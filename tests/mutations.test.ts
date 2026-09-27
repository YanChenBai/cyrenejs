import { expect, expectTypeOf, it, vi } from 'vite-plus/test';

import { CircularDependencyError, Cyrene, InvalidDependencyError, ripple } from '../src/index.ts';

it('两种 add 原地注册，链式调用保留 key 类型且不运行工厂', async () => {
  const factory = vi.fn(() => 42);
  const original = new Cyrene();
  const app = original.add('count', ripple(factory)).add({ label: ripple(() => 'ready') });
  expect(app).toBe(original);
  expect(factory).not.toHaveBeenCalled();
  expectTypeOf(app.resolve('count')).toEqualTypeOf<number>();
  expectTypeOf(app.resolve('label')).toEqualTypeOf<string>();
  await app.dispose();
});

it('分开调用 add 也能注册，批量注册允许依赖在同批稍后出现', async () => {
  const config = ripple(() => 42);
  const root = ripple({ config }, deps => deps);
  const app = new Cyrene();
  app.add({ root, config });
  app.add(
    'extra',
    ripple(() => 'extra'),
  );
  expect(app.resolve('root')).toEqual({ config: 42 });
  expect(app.resolve('extra')).toBe('extra');
  await app.dispose();
});

it('重复 key、重复声明、缺失依赖均立即报错并保留原注册表', async () => {
  const config = ripple(() => ({}));
  const app = new Cyrene().add('config', config);
  expect(() =>
    app.add(
      'config',
      ripple(() => ({})),
    ),
  ).toThrow('Duplicate registration key');
  expect(() => app.add('alias', config)).toThrow('registered more than once');
  const missing = ripple(() => ({}));
  expect(() =>
    app.add(
      'root',
      ripple({ missing }, deps => deps),
    ),
  ).toThrow('Unregistered dependency');
  expect(app.inspect().nodes.map(node => node.key)).toEqual(['config']);
  await app.dispose();
});

it('首次解析前 override 根据原始声明重定向依赖，允许再次覆盖', async () => {
  const factory = vi.fn(() => ({ value: 'old' }));
  const database = ripple(factory);
  const users = ripple({ database }, deps => deps);
  const app = new Cyrene().add({ database, users });
  expect(
    app.override(
      'database',
      ripple(() => ({ value: 'first' })),
    ),
  ).toBe(app);
  app.override(
    'database',
    ripple(() => ({ value: 'mock' })),
  );
  expect(app.resolve('users').database).toBe(app.resolve('database'));
  expect(app.resolve('users').database.value).toBe('mock');
  expect(factory).not.toHaveBeenCalled();
  await app.dispose();
});

it('override 校验新依赖和循环，失败不会更换原配方', async () => {
  const database = ripple(() => ({ value: 1 }));
  const users = ripple({ database }, ({ database }) => ({ value: database.value }));
  const app = new Cyrene().add({ database, users });
  const cyclic = ripple({ users }, ({ users }) => ({ value: users.value }));
  // @ts-expect-error 同时验证类型拦截与绕过类型后的运行时保护。
  expect(() => app.override('database', cyclic)).toThrow(CircularDependencyError);
  expect(() => app.override('unknown', database)).toThrow('Unknown registration key');
  // @ts-expect-error 替换使 database 强依赖自身。
  expect(() => app.override('database', users)).toThrow('registered more than once');
  expect(app.resolve('database').value).toBe(1);
  await app.dispose();
});

it.each(['ripples', 'resolve'] as const)(
  '%s 一经调用立即锁定注册，即使初始化失败',
  async operation => {
    const broken = ripple((): number => {
      throw new Error('failed');
    });

    const app = new Cyrene().add('broken', broken);
    expect(() => (operation === 'ripples' ? app.ripples.broken : app.resolve('broken'))).toThrow();
    expect(() =>
      app.add(
        'late',
        ripple(() => 1),
      ),
    ).toThrow('locked');
    expect(() =>
      app.override(
        'broken',
        ripple(() => 1),
      ),
    ).toThrow('locked');
    expect(() =>
      app.add(
        'late',
        ripple(() => 1),
      ),
    ).toThrow('locked');
    await app.dispose();
  },
);

it('动态输入校验拒绝非法集合，未知 key 不会隐式注册', async () => {
  const app = new Cyrene();
  expect(() => app.add([] as never)).toThrow(InvalidDependencyError);
  expect(() => app.add({ [Symbol('key')]: ripple(() => 1) } as never)).toThrow(
    InvalidDependencyError,
  );
  expect(() => app.add('bad', {} as never)).toThrow(InvalidDependencyError);
  expect(() => app.resolve('missing')).toThrow('Unknown registration key');
  await app.dispose();
});

it('特殊字符串 key 不受 Object 原型字段影响', async () => {
  const app = new Cyrene()
    .add(
      '__proto__',
      ripple(() => 'proto'),
    )
    .add(
      'constructor',
      ripple(() => 'constructor'),
    );

  expect(app.resolve('__proto__')).toBe('proto');
  expect(app.resolve('constructor')).toBe('constructor');
  await app.dispose();
});

it('override 后继续 add 保留原声明定位，失败重建不改变已发布邻接', async () => {
  const database = ripple(() => ({ value: 'original' }));
  const config = ripple(() => ({ value: 'configured' }));
  const replacement = ripple({ config }, ({ config }) => ({ value: config.value }));
  const app = new Cyrene().add({ database, config });
  app.override('database', replacement);
  const users = ripple({ database }, deps => deps);
  const registered = app.add('users', users);
  const before = registered.inspect();
  const invalid = ripple({ users }, ({ users }) => ({ value: users.database.value }));
  expect(() => registered.override('database', invalid)).toThrow(CircularDependencyError);
  expect(registered.inspect()).toEqual(before);
  expect(registered.resolve('users').database.value).toBe('configured');
  await registered.dispose();
});
