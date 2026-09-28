import { expect, expectTypeOf, it, vi } from 'vite-plus/test';

import {
  CircularDependencyError,
  Cyrene,
  InvalidDependencyError,
  lazy,
  ripple,
} from '../src/index.ts';
import type { Dependency } from '../src/index.ts';

it('use 接受多个声明并原地累积入口，收集内部依赖但不公开属性', async () => {
  const database = ripple('database', () => ({ value: 42 }));
  const users = ripple('users', { db: database }, ({ db }) => db);
  const orders = ripple('orders', { database }, deps => deps);
  const reports = ripple('reports', () => 'report');
  const original = new Cyrene();
  const app = original.use(users).use(orders, reports);
  expect(app).toBe(original);
  expect(Object.keys(app.ripples)).toEqual(['users', 'orders', 'reports']);
  expectTypeOf(app.ripples).toEqualTypeOf<{
    readonly users: { value: number };
    readonly orders: { readonly database: { value: number } };
    readonly reports: string;
  }>();
  expect(Reflect.has(app.ripples, 'database')).toBe(false);
  expect(app.inspect().roots).toEqual(['users', 'orders', 'reports']);
  expect(app.inspect().nodes).toHaveLength(4);
  expect(app.ripples.users).toBe(app.resolve(database));
  expect(app.ripples.orders.database).toBe(app.resolve(database));
  expect(app.resolve('database')).toBe(app.resolve(database));
  await app.dispose();
});

it('重复 use 幂等，内部声明可以提升为显式入口', async () => {
  const child = ripple('child', () => 1);
  const root = ripple('root', { child }, deps => deps);
  const app = new Cyrene().use(root, root);
  app.inspect();
  const exposed = app.use(child).use(child);
  expect(Object.keys(exposed.ripples)).toEqual(['root', 'child']);
  expectTypeOf(exposed.ripples.child).toEqualTypeOf<number>();
  expect(exposed.ripples.root.child).toBe(exposed.ripples.child);
  await app.dispose();
});

it('use 整批校验入口，失败不会留下属性或注册', async () => {
  const first = ripple('same', () => 1);
  const conflict = ripple('same', () => 2);
  const fresh = ripple('fresh', () => 3);
  const app = new Cyrene().use(first);
  expect(() => app.use(fresh, conflict)).toThrow('Duplicate Ripple key');
  expect(() => app.use(fresh, {} as never)).toThrow(InvalidDependencyError);
  expect(() => new Cyrene().use(first, conflict)).toThrow('Duplicate Ripple key');
  expect(Object.keys(app.ripples)).toEqual(['same']);
  expect(app.inspect().nodes).toHaveLength(1);
  app.use(fresh);
  expect(app.resolve(fresh)).toBe(3);
  await app.dispose();
});

it('深层不同声明重名时先拒绝整张图，不运行任何工厂', async () => {
  const factory = vi.fn(() => 1);
  const first = ripple('database', factory);
  const second = ripple('database', factory);
  const left = ripple('left', { db: first }, deps => deps);
  const right = ripple('right', { db: second }, deps => deps);
  const app = new Cyrene().use(left, right);
  expect(() => app.inspect()).toThrow('Duplicate Ripple key: database');
  expect(() => app.resolve(left)).toThrow('Duplicate Ripple key: database');
  expect(factory).not.toHaveBeenCalled();
  expect(() => app.use(first)).toThrow('locked');
  await app.dispose();
});

it('lazy 前向引用在构图时收集，未读取目标时不创建实例', async () => {
  const target = vi.fn(() => later);
  const root = ripple('root', { later: lazy(target) }, deps => deps);
  const app = new Cyrene().use(root);
  const factory = vi.fn(() => 42);
  const later = ripple('later', factory);
  expect(target).not.toHaveBeenCalled();
  expect(app.inspect().nodes.map(node => node.key)).toEqual(['root', 'later']);
  const value = app.ripples.root;
  expect(factory).not.toHaveBeenCalled();
  expect(Object.keys(app.ripples)).toEqual(['root']);
  expect(value.later.resolve()).toBe(42);
  expect(target).toHaveBeenCalledOnce();
  await app.dispose();
});

it('只 use 一个入口也能收集 lazy 环', async () => {
  const a: Dependency<{ b: unknown }, unknown, false, 'a'> = ripple(
    'a',
    { b: lazy(() => b) },
    deps => deps,
  );

  const b = ripple('b', { a }, deps => deps);
  const app = new Cyrene().use(a);
  expect(app.inspect().nodes).toHaveLength(2);
  expect(Object.keys(app.ripples)).toEqual(['a']);
  await app.dispose();
});

it('覆盖内部依赖保留原 key、声明定位和公开范围', async () => {
  const database = ripple('database', () => ({ value: 1 }));
  const users = ripple('users', { db: database }, deps => deps);
  const replacement = ripple('mockDatabase', () => ({ value: 2 }));
  const app = new Cyrene().use(users).override(database, replacement);
  expect(Object.keys(app.ripples)).toEqual(['users']);
  expect(app.inspect().nodes.map(node => node.key)).toEqual(['users', 'database']);
  expect(app.ripples.users.db).toBe(app.resolve(database));
  expect(app.resolve(replacement)).toBe(app.resolve(database));
  expect(app.resolve(database).value).toBe(2);
  expect(() => app.resolve('mockDatabase')).toThrow('Unknown registration key');
  await app.dispose();
});

it('覆盖显式入口不改变属性，允许相同 key 的替身', async () => {
  const original = ripple('service', () => 1);
  const replacement = ripple('service', () => 2);
  const app = new Cyrene().use(original).override(original, replacement);
  expect(app.ripples.service).toBe(2);
  expect(app.resolve(original)).toBe(app.resolve(replacement));
  await app.dispose();
});

it('覆盖先于 use，重复覆盖最后生效，旧替身不再占用身份', async () => {
  const original = ripple('service', () => 1);
  const first = ripple('first', () => 2);
  const last = ripple('last', () => 3);
  const app = new Cyrene().override(original, first).override(original, last).use(original, first);
  expect(app.ripples.service).toBe(3);
  expect(app.ripples.first).toBe(2);
  expect(app.resolve(last)).toBe(3);
  await app.dispose();
});

it('覆盖只收集有效实现的依赖，独有旧依赖被裁剪，共享旧依赖保留', async () => {
  const old = ripple('old', () => 1);
  const fresh = ripple('fresh', () => 2);
  const original = ripple('service', { old }, () => 0);
  const replacement = ripple('mock', { fresh }, ({ fresh }) => fresh);
  const app = new Cyrene().use(original).override(original, replacement);
  expect(app.inspect().nodes.map(node => node.key)).toEqual(['service', 'fresh']);
  expect(app.ripples.service).toBe(2);
  expect(() => app.resolve(old)).toThrow('Unregistered Ripple');
  await app.dispose();

  const consumer = ripple('consumer', { old }, deps => deps);
  const shared = new Cyrene().use(original, consumer).override(original, replacement);
  expect(shared.inspect().nodes.map(node => node.key)).toEqual([
    'service',
    'fresh',
    'consumer',
    'old',
  ]);
  await shared.dispose();
});

it('不可达覆盖在构图时报错，包括被上层替换裁剪掉的目标', async () => {
  const old = ripple('old', () => 1);
  const root = ripple('root', { old }, () => 0);
  const replacement = ripple('mock', () => 2);
  const app = new Cyrene().override(old, replacement);
  expect(() => app.inspect()).toThrow('Override target is not reachable: old');
  app.use(root).override(root, replacement);
  expect(() => app.inspect()).toThrow('Override target is not reachable: old');
  app.use(old).override(root, root);
  expect(app.resolve(old)).toBe(2);
  await app.dispose();
});

it('同一替身不能占用多个槽位或作为另一入口', async () => {
  const first = ripple('first', () => 1);
  const second = ripple('second', () => 2);
  const replacement = ripple('mock', () => 3);

  const app = new Cyrene()
    .use(first, second)
    .override(first, replacement)
    .override(second, replacement);

  expect(() => app.inspect()).toThrow('multiple keys');
  app.override(second, second).use(replacement);
  expect(() => app.inspect()).toThrow('multiple keys');
  await app.dispose();
});

it('强依赖环在解析前拒绝，inspect 失败后仍可修复配置', async () => {
  const factory = vi.fn(() => 1);
  const database = ripple('database', factory);
  const users = ripple('users', { database }, ({ database }) => database);
  const cyclic = ripple('cyclic', { users }, ({ users }) => users);
  const app = new Cyrene().use(users).override(database, cyclic);
  expect(() => app.inspect()).toThrow(CircularDependencyError);
  expect(factory).not.toHaveBeenCalled();
  app.override(database, database);
  expect(app.ripples.users).toBe(1);
  await app.dispose();
});

it.each(['ripples', 'resolve'] as const)('%s 首次解析失败也锁定配置', async operation => {
  const broken = ripple('broken', (): number => {
    throw new Error('failed');
  });

  const app = new Cyrene().use(broken);
  expect(() => (operation === 'ripples' ? app.ripples.broken : app.resolve(broken))).toThrow();
  expect(() => app.use(broken)).toThrow('locked');
  expect(() => app.override(broken, broken)).toThrow('locked');
  await app.dispose();
});

it('构图失败和陌生声明的解析尝试均锁定配置', async () => {
  const first = ripple('same', () => 1);
  const second = ripple('same', () => 2);
  const root = ripple('root', { first, second }, deps => deps);
  const app = new Cyrene().use(root);
  expect(() => app.resolve(root)).toThrow('Duplicate Ripple key');
  expect(() => app.override(first, second)).toThrow('locked');
  await app.dispose();
  const empty = new Cyrene();
  expect(() => empty.resolve(first)).toThrow('Unregistered Ripple');
  expect(() => empty.use(first)).toThrow('locked');
  await empty.dispose();
});

it('缓存构图，失败配置与幂等 use 不触发重建，有效配置变更才失效', async () => {
  const later = ripple('later', () => 42);
  const target = vi.fn(() => later);
  const root = ripple('root', { later: lazy(target) }, deps => deps);
  const app = new Cyrene().use(root);
  app.inspect();
  app.use(root).use();
  expect(() => app.use(ripple('root', () => 0))).toThrow();
  expect(() => app.override(root, {} as never)).toThrow();
  app.inspect();
  expect(target).toHaveBeenCalledOnce();
  app.override(
    later,
    ripple('mock', () => 43),
  );
  expect(app.ripples.root.later.resolve()).toBe(43);
  app.inspect();
  expect(target).toHaveBeenCalledTimes(2);
  await app.dispose();
});

it('构图失败不缓存半成品，可在声明完成后重新诊断', async () => {
  let later: Dependency<number, unknown, false> | undefined = undefined;
  const root = ripple('root', { later: lazy(() => later!) }, deps => deps);
  const app = new Cyrene().use(root);
  expect(() => app.inspect()).toThrow('Expected a Ripple');
  later = ripple('later', () => 42);
  app.inspect();
  expect(app.ripples.root.later.resolve()).toBe(42);
  await app.dispose();
});

it('特殊字符串 key 不受 Object 原型字段影响', async () => {
  const app = new Cyrene().use(
    ripple('__proto__', () => 'proto'),
    ripple('constructor', () => 'constructor'),
  );

  expect(app.ripples.__proto__).toBe('proto');
  expect(app.ripples.constructor).toBe('constructor');
  await app.dispose();
});
