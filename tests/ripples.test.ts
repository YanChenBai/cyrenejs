import { expect, expectTypeOf, it, vi } from 'vite-plus/test';

import { CircularDependencyError, Cyrene, lazy, ripple } from '../src/index.ts';
import type { Dependency } from '../src/index.ts';
import { deferred } from './helpers.ts';

it('属性同步返回真实实例，查看 key 和描述符不触发创建', async () => {
  const factory = vi.fn(() => ({ count: 1 }));
  const service = ripple(factory);
  const app = new Cyrene().add({ service });
  const view = app.ripples;
  expect(Object.keys(view)).toEqual(['service']);
  expect(Object.getOwnPropertyDescriptor(view, 'service')).toMatchObject({
    get: expect.any(Function),
  });
  expect(factory).not.toHaveBeenCalled();
  expect(Reflect.set(view, 'service', {})).toBe(false);
  expect(Reflect.defineProperty(view, 'other', { value: 1 })).toBe(false);
  expect(Reflect.deleteProperty(view, 'service')).toBe(false);
  expect(() => Object.preventExtensions(view)).toThrow();

  const registered = app.add(
    'other',
    ripple(() => 2),
  );

  expect(registered.ripples).toBe(view);
  expectTypeOf(registered.ripples.other).toEqualTypeOf<number>();
  const value = app.ripples.service;
  expectTypeOf(value).toEqualTypeOf<{ count: number }>();
  expect(value).toBe(app.resolve(service));
  expect(value).toBe(app.resolve('service'));
  expect(factory).toHaveBeenCalledOnce();
  expect(() =>
    app.add(
      'late',
      ripple(() => 3),
    ),
  ).toThrow('locked');
  await app.dispose();
  expect(() => view.service).toThrow('disposed');
});

it('异步性沿多层强依赖传播，lazy 和普通 Promise 输入不传播', async () => {
  const gate = deferred<number>();
  const source = ripple(() => gate.promise);
  const sync = ripple(() => 1);
  const consumer = ripple({ source, sync, plain: true }, deps => deps.source + deps.sync);
  const top = ripple({ consumer }, deps => String(deps.consumer));
  const factory = vi.fn(() => Promise.resolve(42));
  const later = ripple(factory);
  const lazyConsumer = ripple({ later: lazy(() => later), plain: gate.promise }, deps => deps);
  const app = new Cyrene().add({ source, sync, consumer, top, later, lazyConsumer });
  const value = app.ripples.lazyConsumer;
  expect(value.plain).toBe(gate.promise);
  expect(factory).not.toHaveBeenCalled();
  expectTypeOf(value.later.resolve()).toEqualTypeOf<Promise<number>>();
  const pending = app.ripples.top;
  expectTypeOf(pending).toEqualTypeOf<Promise<string>>();
  expect(app.resolve(top)).toBe(pending);
  gate.resolve(2);
  expect(await pending).toBe('3');
  expect(app.ripples.top).toBe(pending);
  expect(await value.later.resolve()).toBe(42);
  expect(factory).toHaveBeenCalledOnce();
  await app.dispose();
});

it('异步工厂失败仍缓存同一个 Promise', async () => {
  const factory = vi.fn(async () => {
    throw new Error('failed');
  });

  const app = new Cyrene().add('service', ripple(factory));
  const pending = app.ripples.service;
  await expect(pending).rejects.toThrow('Failed to resolve');
  expect(app.ripples.service).toBe(pending);
  expect(factory).toHaveBeenCalledOnce();
  await app.dispose();
});

it('跨 await 的 lazy 等待环被拒绝', async () => {
  const a: Dependency<unknown> = ripple({ b: lazy(() => b) }, async ({ b }) => {
    await Promise.resolve();

    return b.resolve();
  });

  const b: Dependency<unknown> = ripple({ a: lazy(() => a) }, async ({ a }) => {
    await Promise.resolve();

    return a.resolve();
  });

  const app = new Cyrene().add({ a, b });
  await expect(app.resolve(a)).rejects.toBeInstanceOf(CircularDependencyError);
  await app.dispose();
});
