import { expect, it, vi } from 'vite-plus/test';

import { Cyrene, ripple } from '../src/index.ts';

it('逆创建顺序清理，消费者 disposer 仍可调用真实依赖', async () => {
  const events: string[] = [];

  const database = ripple('database', () => ({
    flush() {
      events.push('flush');
    },
    [Symbol.dispose]() {
      events.push('database');
    },
  }));

  const worker = ripple('worker', { database }, ({ database }) => ({
    async [Symbol.asyncDispose]() {
      await Promise.resolve();
      database.flush();
      events.push('worker');
    },
  }));

  const app = new Cyrene().use(worker, database);
  app.resolve('worker');
  await app.dispose();
  expect(events).toEqual(['flush', 'worker', 'database']);
});

it('按实际完成顺序清理独立资源，async 协议优先且忽略普通 dispose', async () => {
  const events: string[] = [];
  const sync = vi.fn();
  const ordinary = vi.fn();

  const first = ripple('first', () => ({
    [Symbol.asyncDispose]: async () => {
      events.push('first');
    },
    [Symbol.dispose]: sync,
    dispose: ordinary,
  }));

  const second = ripple('second', () => ({
    [Symbol.dispose]: () => {
      events.push('second');
    },
  }));

  const app = new Cyrene().use(
    first,
    second,
    ripple('plain', () => ({ dispose: ordinary })),
  );

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

  const borrowed = ripple('borrowed', () => ({ [Symbol.dispose]: borrowedCleanup }), {
    ownership: 'borrowed',
  });

  const owned = ripple('owned', () => ({ [Symbol.dispose]: ownedCleanup }));
  const alias = ripple('alias', { owned }, ({ owned }) => owned);
  const app = new Cyrene().use(borrowed, owned, alias);
  app.resolve('borrowed');
  app.resolve('alias');
  await app.dispose();
  expect(ownedCleanup).toHaveBeenCalledOnce();
  expect(borrowedCleanup).not.toHaveBeenCalled();
});

it('同一实例所有权冲突明确报错，保留原清理责任', async () => {
  const cleanup = vi.fn();
  const shared = { [Symbol.dispose]: cleanup };

  const app = new Cyrene().use(
    ripple('owned', () => shared),
    ripple('borrowed', () => shared, { ownership: 'borrowed' }),
  );

  app.resolve('owned');
  expect(() => app.resolve('borrowed')).toThrow();
  await app.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});

it.each(['owned', 'borrowed'] as const)('无清理方法的实例仍检查所有权冲突：%s', async ownership => {
  const shared = {};
  const original = ripple('original', () => shared, { ownership });

  const conflicting = ripple('conflicting', () => shared, {
    ownership: ownership === 'owned' ? 'borrowed' : 'owned',
  });

  const app = new Cyrene().use(original, conflicting);
  expect(app.resolve(original)).toBe(shared);
  expect(() => app.resolve(conflicting)).toThrow();
  await app.dispose();
});

it('重复登记资源保留首次完成位置，包括原型上的清理方法', async () => {
  const events: string[] = [];

  class Resource {
    [Symbol.dispose]() {
      events.push('first');
    }
  }

  const shared = new Resource();
  const first = ripple('first', () => shared, { lifetime: 'transient' });
  const second = ripple('second', () => ({ [Symbol.dispose]: () => events.push('second') }));
  const app = new Cyrene().use(first, second);
  app.resolve(first);
  app.resolve(second);
  app.resolve(first);
  await app.dispose();
  expect(events).toEqual(['second', 'first']);
});

it('清理协议 getter 在关闭时求值，借用对象不访问清理协议', async () => {
  const cleanup = vi.fn();
  const ownedGetter = vi.fn(() => cleanup);

  const borrowedGetter = vi.fn(() => {
    throw new Error('borrowed disposer must not be accessed');
  });

  const owned = ripple('owned', () =>
    Object.defineProperty({}, Symbol.dispose, { get: ownedGetter }),
  );

  const borrowed = ripple(
    'borrowed',
    () => Object.defineProperty({}, Symbol.dispose, { get: borrowedGetter }),
    { ownership: 'borrowed' },
  );

  const app = new Cyrene().use(owned, borrowed);
  app.resolve(owned);
  app.resolve(borrowed);
  expect(ownedGetter).not.toHaveBeenCalled();
  await app.dispose();
  expect(ownedGetter).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(borrowedGetter).not.toHaveBeenCalled();
});

it('清理失败聚合并继续，重复 dispose 不会再次调用资源', async () => {
  const cleanup = vi.fn();
  const failure = new Error('cleanup');

  const app = new Cyrene().use(
    ripple('first', () => ({ [Symbol.dispose]: cleanup })),
    ripple('second', () => ({
      [Symbol.dispose]() {
        throw failure;
      },
    })),
  );

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
    await using app = new Cyrene().use(
      ripple('resource', () => ({ [Symbol.asyncDispose]: cleanup })),
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

  const app = original.use(ripple('resource', () => ({ [Symbol.dispose]: cleanup })));

  app.resolve('resource');
  const closing = app.dispose();
  await closing;
  expect(nested).toBe(closing);
  expect(cleanup).toHaveBeenCalledOnce();
});
