import { expect, it, vi } from 'vite-plus/test';

import { Cyrene, ripple } from '../src/index.ts';

it('逆创建顺序清理，消费者 disposer 仍可调用真实依赖', async () => {
  const events: string[] = [];

  const database = ripple(() => ({
    flush() {
      events.push('flush');
    },
    [Symbol.dispose]() {
      events.push('database');
    },
  }));

  const worker = ripple({ database }, ({ database }) => ({
    async [Symbol.asyncDispose]() {
      await Promise.resolve();
      database.flush();
      events.push('worker');
    },
  }));

  const app = new Cyrene().add({ worker, database });
  app.resolve('worker');
  await app.dispose();
  expect(events).toEqual(['flush', 'worker', 'database']);
});

it('按实际完成顺序清理独立资源，async 协议优先且忽略普通 dispose', async () => {
  const events: string[] = [];
  const sync = vi.fn();
  const ordinary = vi.fn();

  const first = ripple(() => ({
    [Symbol.asyncDispose]: async () => {
      events.push('first');
    },
    [Symbol.dispose]: sync,
    dispose: ordinary,
  }));

  const second = ripple(() => ({
    [Symbol.dispose]: () => {
      events.push('second');
    },
  }));

  const app = new Cyrene().add({ first, second, plain: ripple(() => ({ dispose: ordinary })) });
  app.resolve('first');
  app.resolve('second');
  app.resolve('plain');
  await app.dispose();
  expect(events).toEqual(['second', 'first']);
  expect(sync).not.toHaveBeenCalled();
  expect(ordinary).not.toHaveBeenCalled();
});

it('借用资源不清理，同一 owned 对象只清理一次', async () => {
  const borrowedCleanup = vi.fn();
  const ownedCleanup = vi.fn();
  const borrowed = ripple(() => ({ [Symbol.dispose]: borrowedCleanup }), { ownership: 'borrowed' });
  const owned = ripple(() => ({ [Symbol.dispose]: ownedCleanup }));
  const alias = ripple({ owned }, ({ owned }) => owned);
  const app = new Cyrene().add({ borrowed, owned, alias });
  app.resolve('borrowed');
  app.resolve('alias');
  await app.dispose();
  expect(ownedCleanup).toHaveBeenCalledOnce();
  expect(borrowedCleanup).not.toHaveBeenCalled();
});

it('同一实例所有权冲突明确报错，保留原清理责任', async () => {
  const cleanup = vi.fn();
  const shared = { [Symbol.dispose]: cleanup };

  const app = new Cyrene().add({
    owned: ripple(() => shared),
    borrowed: ripple(() => shared, { ownership: 'borrowed' }),
  });

  app.resolve('owned');
  expect(() => app.resolve('borrowed')).toThrow();
  await app.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});

it('清理失败聚合并继续，重复 dispose 不会再次调用资源', async () => {
  const cleanup = vi.fn();
  const failure = new Error('cleanup');

  const app = new Cyrene().add({
    first: ripple(() => ({ [Symbol.dispose]: cleanup })),
    second: ripple(() => ({
      [Symbol.dispose]() {
        throw failure;
      },
    })),
  });

  app.resolve('first');
  app.resolve('second');
  const disposal = app.dispose();
  await expect(disposal).rejects.toMatchObject({ errors: [failure] });
  expect(app.dispose()).toBe(disposal);
  expect(cleanup).toHaveBeenCalledOnce();
});

it('await using 自动等待容器的异步清理', async () => {
  const cleanup = vi.fn(async () => {});

  {
    await using app = new Cyrene().add(
      'resource',
      ripple(() => ({ [Symbol.asyncDispose]: cleanup })),
    );
    app.resolve('resource');
    expect(cleanup).not.toHaveBeenCalled();
  }

  expect(cleanup).toHaveBeenCalledOnce();
});

it('disposer 同步重入 dispose 得到同一 Promise，不重复执行清理', async () => {
  let nested: Promise<void> | undefined;
  const original = new Cyrene();

  const cleanup = vi.fn(() => {
    nested = original.dispose();
  });

  const app = original.add(
    'resource',
    ripple(() => ({ [Symbol.dispose]: cleanup })),
  );

  app.resolve('resource');
  const closing = app.dispose();
  await closing;
  expect(nested).toBe(closing);
  expect(cleanup).toHaveBeenCalledOnce();
});
