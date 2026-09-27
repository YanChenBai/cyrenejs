import { expect, it, vi } from 'vite-plus/test';

import { CircularDependencyError, Cyrene, DisposedError, lazy, ripple } from '../src/index.ts';
import type { Dependency } from '../src/index.ts';
import { deferred } from './helpers.ts';

it('transient 注册不创建，属性、key 和声明每次解析都调用工厂', async () => {
  const factory = vi.fn(() => ({}));
  const item = ripple(factory, { lifetime: 'transient' });
  const app = new Cyrene().add({ item });
  expect(factory).not.toHaveBeenCalled();
  const values = [app.ripples.item, app.ripples.item, app.resolve('item'), app.resolve(item)];
  expect(new Set(values).size).toBe(4);
  expect(factory).toHaveBeenCalledTimes(4);
  expect(app.inspect().nodes).toEqual([{ key: 'item', state: 'ready' }]);
  await app.dispose();
});

it('每个注入位置独立解析，singleton 持有首次注入，transient 可共享 singleton', async () => {
  const shared = ripple(() => ({}));
  const item = ripple({ shared }, deps => deps, { lifetime: 'transient' });
  const holder = ripple({ first: item, second: item }, deps => deps);
  const consumer = ripple({ item }, deps => deps, { lifetime: 'transient' });
  const app = new Cyrene().add({ shared, item, holder, consumer });
  const fixed = app.ripples.holder;
  expect(app.ripples.holder).toBe(fixed);
  expect(fixed.first).not.toBe(fixed.second);
  const first = app.ripples.consumer;
  const second = app.ripples.consumer;
  expect(first.item).not.toBe(second.item);
  expect(first.item.shared).toBe(second.item.shared);
  expect(first.item.shared).toBe(fixed.first.shared);
  await app.dispose();
});

it('同一 lazy 句柄在初始化期间和就绪后都为 transient 创建独立 Promise', async () => {
  const child = ripple(async () => ({}), { lifetime: 'transient' });

  const parent = ripple({ child: lazy(() => child) }, async ({ child }) => {
    const first = child.resolve();
    const second = child.resolve();
    expect(first).not.toBe(second);
    const values = await Promise.all([first, second]);

    return { child, values };
  });

  const app = new Cyrene().add({ child, parent });
  const { child: handle, values } = await app.ripples.parent;
  expect(values[0]).not.toBe(values[1]);
  const later = await Promise.all([handle.resolve(), handle.resolve()]);
  expect(new Set([...values, ...later]).size).toBe(4);
  await app.dispose();
});

it('并发 transient 初始化独立，关闭等待全部完成并逐个释放', async () => {
  const firstGate = deferred<void>();
  const secondGate = deferred<void>();
  const events: number[] = [];
  let calls = 0;

  const item = ripple(
    async () => {
      const id = ++calls;
      await (id === 1 ? firstGate.promise : secondGate.promise);

      return { id, [Symbol.dispose]: () => events.push(id) };
    },
    { lifetime: 'transient' },
  );

  const app = new Cyrene().add({ item });
  const first = app.resolve(item);
  const second = app.resolve(item);
  expect(first).not.toBe(second);
  expect(calls).toBe(2);
  const closing = app.dispose();
  expect(() => app.resolve(item)).toThrow(DisposedError);
  secondGate.resolve();
  await second;
  expect(events).toEqual([]);
  firstGate.resolve();
  await first;
  await closing;
  expect(events).toEqual([1, 2]);
});

it.each([false, true])('transient 失败不缓存，下一次解析重新创建：async=%s', async asynchronous => {
  let calls = 0;

  const factory = () => {
    if (++calls === 1) {
      throw new Error('first attempt');
    }

    return { calls };
  };

  const item = ripple(() => (asynchronous ? Promise.resolve().then(factory) : factory()), {
    lifetime: 'transient',
  });

  const app = new Cyrene().add({ item });
  await expect(Promise.resolve().then(() => app.resolve(item))).rejects.toThrow(
    'Failed to resolve',
  );
  expect(app.inspect().nodes[0]?.state).toBe('failed');
  expect(await app.resolve(item)).toEqual({ calls: 2 });
  expect(app.inspect().nodes[0]?.state).toBe('ready');
  await app.dispose();
});

it('transient 返回同一对象仍只释放一次，borrowed 不接管资源', async () => {
  const cleanup = vi.fn();
  const borrowedCleanup = vi.fn();
  const shared = { [Symbol.dispose]: cleanup };
  const item = ripple(() => shared, { lifetime: 'transient' });

  const borrowed = ripple(() => ({ [Symbol.dispose]: borrowedCleanup }), {
    lifetime: 'transient',
    ownership: 'borrowed',
  });

  const app = new Cyrene().add({ item, borrowed });
  expect(app.resolve(item)).toBe(app.resolve(item));
  app.resolve(borrowed);
  app.resolve(borrowed);
  await app.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(borrowedCleanup).not.toHaveBeenCalled();
});

it('override 的当前实现决定 lifetime，原声明仍定位该注册项', async () => {
  const original = ripple(() => ({}));
  const replacement = ripple(() => ({}), { lifetime: 'transient' });
  const app = new Cyrene().add({ original }).override('original', replacement);
  expect(app.resolve(original)).not.toBe(app.resolve(replacement));
  await app.dispose();
});

it.each([false, true])(
  'transient lazy 初始化递归被拒绝而非无限创建：async=%s',
  async asynchronous => {
    const self: Dependency<unknown> = ripple(
      { self: lazy(() => self) },
      async ({ self }) => {
        if (asynchronous) {
          await Promise.resolve();
        }

        return self.resolve();
      },
      { lifetime: 'transient' },
    );

    const app = new Cyrene().add({ self });
    await expect(app.resolve(self)).rejects.toBeInstanceOf(CircularDependencyError);
    await app.dispose();
  },
);

it('transient 就绪后的 lazy 可以创建同声明的新实例', async () => {
  const self: Dependency<{ next: () => unknown }, unknown, false> = ripple(
    { self: lazy(() => self) },
    ({ self }) => ({ next: () => self.resolve() }),
    { lifetime: 'transient' },
  );

  const app = new Cyrene().add({ self });
  const first = app.resolve(self);
  expect(first.next()).not.toBe(first);
  await app.dispose();
});

it('singleton 与 transient 的异步互等按具体实例检测', async () => {
  const parent: Dependency<unknown> = ripple({ child: lazy(() => child) }, async ({ child }) => {
    await Promise.resolve();

    return child.resolve();
  });

  const child = ripple(
    { parent: lazy(() => parent) },
    async ({ parent }) => {
      await Promise.resolve();

      return parent.resolve();
    },
    { lifetime: 'transient' },
  );

  const app = new Cyrene().add({ parent, child });
  await expect(app.resolve(parent)).rejects.toBeInstanceOf(CircularDependencyError);
  await app.dispose();
});

it('关闭期间已接收的初始化可继续创建 transient，消费者先于依赖释放', async () => {
  const gate = deferred<void>();
  const events: string[] = [];
  let sequence = 0;

  const child = ripple(
    () => {
      const id = ++sequence;

      return { [Symbol.dispose]: () => events.push(`child-${id}`) };
    },
    { lifetime: 'transient' },
  );

  const parent = ripple({ child: lazy(() => child) }, async ({ child }) => {
    await gate.promise;
    child.resolve();
    child.resolve();

    return { [Symbol.dispose]: () => events.push('parent') };
  });

  const app = new Cyrene().add({ parent, child });
  const pending = app.resolve(parent);
  const closing = app.dispose();
  gate.resolve();
  await pending;
  await closing;
  expect(events).toEqual(['parent', 'child-2', 'child-1']);
});
