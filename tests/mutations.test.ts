import { expect, expectTypeOf, it, vi } from 'vite-plus/test';

import {
  CircularDependencyError,
  Cyrene,
  InvalidDependencyError,
  lazy,
  ripple,
} from '../src/index.ts';

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

it('分开调用 add 允许先注册消费者，再注册依赖', async () => {
  const config = ripple(() => 42);
  const root = ripple({ config }, deps => deps);
  const app = new Cyrene();
  app.add('root', root);
  app.add({ config });
  app.add(
    'extra',
    ripple(() => 'extra'),
  );
  expect(app.resolve('root')).toEqual({ config: 42 });
  expect(app.resolve('extra')).toBe('extra');
  await app.dispose();
});

it('重复 key、重复声明立即报错并保留原注册表', async () => {
  const config = ripple(() => ({}));
  const app = new Cyrene().add('config', config);
  expect(() =>
    app.add(
      'config',
      ripple(() => ({})),
    ),
  ).toThrow('Duplicate registration key');
  expect(() => app.add('alias', config)).toThrow('registered more than once');
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

it('override 保留身份检查，循环延迟到解析时报错', async () => {
  const database = ripple(() => ({ value: 1 }));
  const users = ripple({ database }, ({ database }) => ({ value: database.value }));
  const app = new Cyrene().add({ database, users });
  const cyclic = ripple({ users }, ({ users }) => ({ value: users.value }));
  app.override('database', cyclic);
  expect(() => app.override('unknown', database)).toThrow('Unknown registration key');
  expect(() => app.override('database', users)).toThrow('registered more than once');
  expect(() => app.resolve('database')).toThrow(CircularDependencyError);
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

it('override 后继续 add 保留原声明定位，诊断失败仍可继续配置', async () => {
  const database = ripple(() => ({ value: 'original' }));
  const config = ripple(() => ({ value: 'configured' }));
  const replacement = ripple({ config }, ({ config }) => ({ value: config.value }));
  const app = new Cyrene().add({ database, config });
  app.override('database', replacement);
  const users = ripple({ database }, deps => deps);
  const registered = app.add('users', users);
  const before = registered.inspect();
  const invalid = ripple({ users }, ({ users }) => ({ value: users.database.value }));
  registered.override('database', invalid);
  expect(() => registered.inspect()).toThrow(CircularDependencyError);
  registered.override('database', replacement);
  expect(registered.inspect()).toEqual(before);
  expect(registered.resolve('users').database.value).toBe('configured');
  await registered.dispose();
});

it.each(['ripples', 'resolve'] as const)(
  '缺失依赖在 %s 首次解析时拒绝且不执行工厂',
  async operation => {
    const factory = vi.fn(() => 1);
    const missing = ripple(() => 2);
    const root = ripple({ missing }, factory);
    const app = new Cyrene().add({ root, independent: ripple(factory) });
    expect(() => (operation === 'ripples' ? app.ripples.independent : app.resolve('root'))).toThrow(
      'Unregistered dependency',
    );
    expect(factory).not.toHaveBeenCalled();
    expect(() => app.add({ missing })).toThrow('locked');
    expect(() => app.resolve('root')).toThrow('Unregistered dependency');
    await app.dispose();
  },
);

it('override 可以引入稍后注册的依赖', async () => {
  const original = ripple(() => 1);
  const later = ripple(() => 42);
  const app = new Cyrene().add({ original });
  app.override(
    'original',
    ripple({ later }, ({ later }) => later),
  );
  app.add({ later });
  expect(app.resolve(original)).toBe(42);
  await app.dispose();
});

it('分批注册 lazy 前向引用时不提前求值', async () => {
  const target = vi.fn(() => later);
  const root = ripple({ later: lazy(target) }, deps => deps);
  const app = new Cyrene().add({ root });
  const later = ripple(() => 42);
  expect(target).not.toHaveBeenCalled();
  app.add({ later });
  expect(app.ripples.root.later.resolve()).toBe(42);
  expect(target).toHaveBeenCalledOnce();
  await app.dispose();
});

it('批量注册失败不留下声明、属性或身份占用', async () => {
  const existing = ripple(() => 1);
  const fresh = ripple(() => 2);
  const app = new Cyrene().add({ existing });
  expect(() => app.add({ fresh, existing: ripple(() => 3) })).toThrow('Duplicate registration key');
  expect(() => app.add({ fresh, alias: existing })).toThrow('registered more than once');
  expect(() => app.add({ fresh, duplicate: fresh })).toThrow('registered more than once');
  expect(Object.keys(app.ripples)).toEqual(['existing']);
  expect(app.inspect().roots).toEqual(['existing']);
  app.add({ fresh });
  expect(app.resolve(fresh)).toBe(2);
  await app.dispose();
});

it('替换维护原声明身份，释放旧替身身份，失败不修改索引', async () => {
  const original = ripple(() => 1);
  const first = ripple(() => 2);
  const second = ripple(() => 3);
  const other = ripple(() => 4);
  const app = new Cyrene().add({ original, other });
  app.override('original', first);
  expect(() => app.add('alias', original)).toThrow('registered more than once');
  expect(() => app.add('alias', first)).toThrow('registered more than once');
  expect(() => app.override('original', other)).toThrow('registered more than once');
  expect(() => app.override('original', {} as never)).toThrow(InvalidDependencyError);
  expect(() => app.add('alias', first)).toThrow('registered more than once');
  app.override('original', second);
  app.add({ first });
  app.override('original', original);
  app.add({ second });
  expect(app.resolve(original)).toBe(1);
  expect(app.resolve(first)).toBe(2);
  expect(app.resolve(second)).toBe(3);
  await app.dispose();
});

it('inspect 编译缓存只在成功配置变更后失效，诊断失败不锁定', async () => {
  const later = ripple(() => 42);
  const target = vi.fn(() => later);
  const factory = vi.fn(({ later }) => later);
  const root = ripple({ later: lazy(target) }, factory);
  const app = new Cyrene().add({ root });
  expect(() => app.inspect()).toThrow('Unregistered dependency');
  app.add({ later });
  app.inspect();
  app.inspect();
  expect(target).toHaveBeenCalledTimes(2);
  expect(factory).not.toHaveBeenCalled();
  expect(() => app.add('duplicate', root)).toThrow();
  expect(() => app.override('root', later)).toThrow();
  app.inspect();
  expect(target).toHaveBeenCalledTimes(2);
  const replacement = ripple(() => 43);
  app.override('later', replacement);
  expect(target).toHaveBeenCalledTimes(2);
  expect(app.ripples.root.resolve()).toBe(43);
  app.inspect();
  expect(target).toHaveBeenCalledTimes(3);
  expect(factory).toHaveBeenCalledOnce();
  await app.dispose();
});
