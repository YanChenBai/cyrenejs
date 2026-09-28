import assert from 'node:assert/strict';

import { Cyrene, ripple } from '../../src/index.ts';

export async function runRegistration(): Promise<void> {
  let released = false;

  const external = {
    name: 'application-owned',
    [Symbol.dispose]() {
      released = true;
    },
  };

  try {
    const Config = ripple('config', () => ({ label: 'configured' }));
    const External = ripple('external', () => external, { ownership: 'borrowed' });
    const Service = ripple('service', { config: Config, external: External }, deps => deps);
    await using app = new Cyrene();

    app.use(Config, External);
    // 接住返回值才会给新变量增加 service 的属性类型提示。
    const registered = app.use(Service);
    const byDeclaration = app.resolve(Service);
    const byKey = app.resolve('service'); // unknown, 原 app 的泛型未改变
    assert.equal(registered.ripples.service, byDeclaration);
    assert.equal(byKey, byDeclaration);
    assert.equal(byDeclaration.external, external);
    process.stdout.write(
      `分步注册: ${byDeclaration.config.label}, ${byDeclaration.external.name}\n`,
    );
  } finally {
    // borrowed 资源的关闭责任仍属于应用。
    assert.equal(released, false);
    external[Symbol.dispose]();
  }

  assert.equal(released, true);
  process.stdout.write('容器已关闭, 外部资源由应用释放\n');
}
