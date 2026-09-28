import { expect, it, vi } from 'vite-plus/test';

import { Cyrene, DisposedError, lazy, ripple } from '../src/index.ts';
import { deferred } from './helpers.ts';

it('并发菱形依赖与 lazy 共用一次初始化，不误报等待环', async () => {
  const gate = deferred<void>();

  const factory = vi.fn(async () => {
    await gate.promise;

    return {};
  });

  const shared = ripple('shared', factory);
  const left = ripple('left', { shared }, deps => deps);
  const right = ripple('right', { shared }, deps => deps);
  const root = ripple('root', { left, right }, deps => deps);
  const deferredRoot = ripple('deferredRoot', { shared: lazy(() => shared) }, deps => deps);
  const app = new Cyrene().use(shared, left, right, root, deferredRoot);
  const handle = app.ripples.deferredRoot.shared;
  const first = app.ripples.root;
  const pending = app.ripples.shared;

  const requests = Array.from({ length: 100 }, (_, index) => {
    if (index % 3 === 0) {
      return app.resolve(shared);
    }

    if (index % 3 === 1) {
      return app.resolve('shared');
    }

    return handle.resolve();
  });

  expect(requests.every(request => request === pending)).toBe(true);
  expect(factory).toHaveBeenCalledOnce();
  gate.resolve();
  const [value, instances] = await Promise.all([first, Promise.all(requests)]);
  expect(value.left.shared).toBe(value.right.shared);
  expect(instances.every(instance => instance === value.left.shared)).toBe(true);
  await app.dispose();
});

it('多个异步强依赖在任何分支完成前都开始初始化', async () => {
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const entered: string[] = [];

  const first = ripple('first', async () => {
    entered.push('first');
    await firstGate.promise;

    return 1;
  });

  const second = ripple('second', async () => {
    entered.push('second');
    await secondGate.promise;

    return 2;
  });

  const root = ripple('root', { first, second }, deps => deps.first + deps.second);
  const app = new Cyrene().use(first, second, root);
  const pending = app.ripples.root;
  expect(entered).toEqual(['first', 'second']);
  secondGate.resolve();
  firstGate.resolve();
  expect(await pending).toBe(3);
  await app.dispose();
});

it('按需解析共享 Promise，独立分支并行且共享单例', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();

  const factory = vi.fn(async () => {
    entered.resolve();
    await gate.promise;

    return {};
  });

  const shared = ripple('shared', factory);
  const siblingFactory = vi.fn(() => ({}));
  const sibling = ripple('sibling', siblingFactory);
  const root = ripple('root', { shared, sibling }, deps => deps);
  const app = new Cyrene().use(shared, sibling, root);
  const first = app.ripples.root;
  expect(app.resolve('root')).toBe(first);
  await entered.promise;
  await Promise.resolve();
  expect(siblingFactory).toHaveBeenCalledOnce();
  gate.resolve();
  expect((await first).shared).toBe(await app.resolve('shared'));
  expect(app.ripples.root).toBe(first);
  expect(factory).toHaveBeenCalledOnce();
  await app.dispose();
});

it('强依赖失败等待慢分支，资源保留到显式关闭', async () => {
  const gate = deferred<void>();
  const cleanup = vi.fn();

  const slow = ripple('slow', async () => {
    await gate.promise;

    return { [Symbol.dispose]: cleanup };
  });

  const fail = ripple('fail', () => {
    throw new Error('boom');
  });

  const root = ripple('root', { fail, slow }, deps => deps);
  const app = new Cyrene().use(fail, slow, root);
  const rejected = expect(app.ripples.root).rejects.toThrow('Failed to resolve');
  expect(cleanup).not.toHaveBeenCalled();
  gate.resolve();
  await rejected;
  expect(cleanup).not.toHaveBeenCalled();
  await app.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});

it('dispose 等待已接收的初始化，立即拒绝新入口', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const cleanup = vi.fn();

  const service = ripple('service', async () => {
    entered.resolve();
    await gate.promise;

    return { [Symbol.dispose]: cleanup };
  });

  const app = new Cyrene().use(service);
  const pending = app.resolve('service');
  await entered.promise;
  const closing = app.dispose();
  expect(app.dispose()).toBe(closing);
  expect(() => app.resolve('service')).toThrow(DisposedError);
  gate.resolve();
  await pending;
  await closing;
  expect(cleanup).toHaveBeenCalledOnce();
});

it('失败单例缓存失败结果，不自动重复执行工厂', async () => {
  const factory = vi.fn(() => {
    throw new Error('failed');
  });

  const app = new Cyrene().use(ripple('broken', factory));
  expect(() => app.resolve('broken')).toThrow();
  expect(() => app.resolve('broken')).toThrow();
  expect(factory).toHaveBeenCalledOnce();
  await app.dispose();
});

it('关闭等待已接收工厂在 await 之后继续解析 lazy 依赖', async () => {
  const entered = deferred<void>();
  const gate = deferred<void>();
  const events: string[] = [];

  const child = ripple('child', () => ({
    read: () => 42,
    [Symbol.dispose]() {
      events.push('child');
    },
  }));

  const parent = ripple('parent', { child: lazy(() => child) }, async ({ child }) => {
    entered.resolve();
    await gate.promise;
    const value = child.resolve();

    return {
      value: value.read(),
      [Symbol.dispose]() {
        events.push('parent');
      },
    };
  });

  const app = new Cyrene().use(child, parent);
  const pending = app.resolve('parent');
  await entered.promise;
  const closing = app.dispose();
  gate.resolve();
  expect((await pending).value).toBe(42);
  await closing;
  expect(events).toEqual(['parent', 'child']);
});
