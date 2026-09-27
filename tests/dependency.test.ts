import { expect, expectTypeOf, it, vi } from 'vite-plus/test';

import { Cyrene, InvalidDependencyError, isRipple, ripple } from '../src/index.ts';

it('无 ID 声明、两种工厂重载与按 key 的异步结果推导', async () => {
  const config = ripple(() => ({ prefix: 'hello' }));

  const service = ripple({ config, count: 2 }, async ({ config, count }) => ({
    label: config.prefix,
    count,
  }));

  const app = new Cyrene().add({ config, service });
  const result = await app.resolve('service');
  expectTypeOf(result).toEqualTypeOf<{ label: string; count: 2 }>();
  expect(result).toEqual({ label: 'hello', count: 2 });
  expect(isRipple(service)).toBe(true);
  expect(isRipple({})).toBe(false);
  expect('id' in service).toBe(false);
  await app.dispose();
});

it('普通输入保留 Symbol、Promise、函数和嵌套对象', async () => {
  const key = Symbol('key');
  const callback = vi.fn();
  const promise = Promise.resolve(1);
  const nested = { child: ripple(vi.fn()) };
  const service = ripple({ [key]: 42, callback, promise, nested }, deps => deps);
  const app = new Cyrene().add('service', service);
  const result = app.resolve('service');
  expect(result[key]).toBe(42);
  expect(result.callback).toBe(callback);
  expect(result.promise).toBe(promise);
  expect(result.nested).toBe(nested);
  expect(app.inspect().nodes).toHaveLength(1);
  await app.dispose();
});

it('注入真实对象，私有字段、构造函数与对象身份保持不变', async () => {
  class Database {
    #count = 42;

    read() {
      return this.#count;
    }
  }
  const database = ripple(() => new Database());
  const service = ripple({ database }, deps => deps);
  const app = new Cyrene().add({ database, service });
  const value = app.resolve('service');
  expect(value.database).toBe(app.resolve('database'));
  expect(value.database).toBeInstanceOf(Database);
  expect(value.database.read()).toBe(42);
  await app.dispose();
});

it('相同声明在不同容器中拥有独立实例', async () => {
  const service = ripple(() => ({}), { lifetime: 'singleton' });
  const left = new Cyrene().add('left', service);
  const right = new Cyrene().add('right', service);
  expect(left.resolve('left')).not.toBe(right.resolve('right'));
  await left.dispose();
  await right.dispose();
});

it('无依赖重载不接收隐藏参数，并发解析只执行一次工厂', async () => {
  const factory = vi.fn(() => ({}));
  const app = new Cyrene().add('service', ripple(factory));
  const [first, second] = [app.resolve('service'), app.resolve('service')];
  expect(first).toBe(second);
  expect(factory).toHaveBeenCalledExactlyOnceWith();
  await app.dispose();
});

it('拒绝未知 lifetime 与旧清理配置', () => {
  expect(() => ripple(() => ({}), { lifetime: 'scoped' } as never)).toThrow(InvalidDependencyError);
  expect(() => ripple(() => ({}), { dispose: () => {} } as never)).toThrow(InvalidDependencyError);
});

it('独立 add 后可按 Ripple 精确推导，与 key 解析共享实例', async () => {
  const service = ripple(() => ({ value: 42 }));
  const app = new Cyrene();
  app.add('service', service);
  const value = app.resolve(service);
  expectTypeOf(value).toEqualTypeOf<{ value: number }>();
  expect(value).toBe(app.resolve('service'));
  await app.dispose();
});

it('原声明与当前替身都解析替换后的单例，陌生声明不会隐式注册', async () => {
  const original = ripple(() => ({ value: 1 }));
  const replacement = ripple(() => ({ value: 2 }));
  const app = new Cyrene().add('service', original);
  app.override('service', replacement);
  expect(app.resolve(original)).toBe(app.resolve(replacement));
  expect(app.resolve(original)).toEqual({ value: 2 });
  expect(() => app.resolve(ripple(() => ({ value: 2 })))).toThrow('Unregistered Ripple');
  expect(() => app.resolve({} as never)).toThrow(InvalidDependencyError);
  await app.dispose();
  expect(() => app.resolve(original)).toThrow('disposed');
});
