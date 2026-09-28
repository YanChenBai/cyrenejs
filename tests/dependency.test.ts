import { expect, expectTypeOf, it, vi } from 'vite-plus/test';

import { Cyrene, InvalidDependencyError, isRipple, ripple } from '../src/index.ts';

it('具名声明、两种工厂重载与按 key 的异步结果推导', async () => {
  const config = ripple('config', () => ({ prefix: 'hello' }));

  const service = ripple('service', { config, count: 2 }, async ({ config, count }) => ({
    label: config.prefix,
    count,
  }));

  const app = new Cyrene().use(config, service);
  const result = await app.resolve('service');
  expectTypeOf(result).toEqualTypeOf<{ label: string; count: 2 }>();
  expect(result).toEqual({ label: 'hello', count: 2 });
  expect(isRipple(service)).toBe(true);
  expect(isRipple({})).toBe(false);
  expect(service.key).toBe('service');
  expectTypeOf(service.key).toEqualTypeOf<'service'>();
  expect(Object.isFrozen(service)).toBe(true);
  await app.dispose();
});

it('普通输入保留 Symbol、Promise、函数和嵌套对象', async () => {
  const key = Symbol('key');
  const callback = vi.fn();
  const promise = Promise.resolve(1);
  const nested = { child: ripple('child', vi.fn()) };
  const service = ripple('service', { [key]: 42, callback, promise, nested }, deps => deps);
  const app = new Cyrene().use(service);
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
  const database = ripple('database', () => new Database());
  const service = ripple('service', { database }, deps => deps);
  const app = new Cyrene().use(database, service);
  const value = app.resolve('service');
  expect(value.database).toBe(app.resolve('database'));
  expect(value.database).toBeInstanceOf(Database);
  expect(value.database.read()).toBe(42);
  await app.dispose();
});

it('相同声明在不同容器中拥有独立实例', async () => {
  const service = ripple('service', () => ({}), { lifetime: 'singleton' });
  const left = new Cyrene().use(service);
  const right = new Cyrene().use(service);
  expect(left.resolve(service)).not.toBe(right.resolve(service));
  await left.dispose();
  await right.dispose();
});

it('无依赖重载不接收隐藏参数，并发解析只执行一次工厂', async () => {
  const factory = vi.fn(() => ({}));
  const app = new Cyrene().use(ripple('service', factory));
  const [first, second] = [app.resolve('service'), app.resolve('service')];
  expect(first).toBe(second);
  expect(factory).toHaveBeenCalledExactlyOnceWith();
  await app.dispose();
});

it('拒绝未知 lifetime 与旧清理配置', () => {
  expect(() => ripple('replacement1', () => ({}), { lifetime: 'scoped' } as never)).toThrow(
    InvalidDependencyError,
  );
  expect(() => ripple('replacement2', () => ({}), { dispose: () => {} } as never)).toThrow(
    InvalidDependencyError,
  );
});

it('独立 use 后可按 Ripple 精确推导，与 key 解析共享实例', async () => {
  const service = ripple('service', () => ({ value: 42 }));
  const app = new Cyrene();
  app.use(service);
  const value = app.resolve(service);
  expectTypeOf(value).toEqualTypeOf<{ value: number }>();
  expect(value).toBe(app.resolve('service'));
  await app.dispose();
});

it('原声明与当前替身都解析替换后的单例，陌生声明不会隐式注册', async () => {
  const original = ripple('original', () => ({ value: 1 }));
  const replacement = ripple('replacement', () => ({ value: 2 }));
  const app = new Cyrene().use(original);
  app.override(original, replacement);
  expect(app.resolve(original)).toBe(app.resolve(replacement));
  expect(app.resolve(original)).toEqual({ value: 2 });
  expect(() => app.resolve(ripple('replacement3', () => ({ value: 2 })))).toThrow(
    'Unregistered Ripple',
  );
  expect(() => app.resolve({} as never)).toThrow(InvalidDependencyError);
  await app.dispose();
  expect(() => app.resolve(original)).toThrow('disposed');
});

it('声明 key 必须是非空字符串', () => {
  expect(() => ripple('', () => 1)).toThrow('non-empty string');
  expect(() => ripple(42 as never, () => 1)).toThrow('non-empty string');
});
