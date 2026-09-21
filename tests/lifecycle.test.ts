import { describe, expect, it, vi } from 'vite-plus/test';

import {
  CircularDependencyError,
  Cyrene,
  DisposedError,
  MissingBindingError,
  ResolutionError,
  lazy,
  ripple,
  token,
} from '../src/index.ts';
import type { Dependency, Lazy } from '../src/index.ts';
import { deferred } from './helpers.ts';

describe('延迟解析与资源释放', () => {
  it('支持合法的延迟依赖环, 释放后拒绝解析', async () => {
    interface A {
      b: Lazy<B>;
    }
    interface B {
      a: A;
    }
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    const factory = vi.fn(({ a }: { a: A }): B => ({ a }));

    const a: Dependency<A> = ripple({ b: lazy(() => b) }, ({ b }): A => ({ b }), {
      dispose: disposeA,
    });

    const b: Dependency<B> = ripple({ a }, factory, { dispose: disposeB });
    const app = new Cyrene({ ripples: { a } });
    const result = await app.start();
    expect(factory).not.toHaveBeenCalled();
    const instanceB = await result.a.b.resolve();
    expect(instanceB.a).toBe(result.a);
    expect(await result.a.b.resolve()).toBe(instanceB);
    await app.dispose();
    await app.dispose();
    expect(disposeA).toHaveBeenCalledExactlyOnceWith(result.a);
    expect(disposeB).toHaveBeenCalledExactlyOnceWith(instanceB);
    await expect(result.a.b.resolve()).rejects.toBeInstanceOf(DisposedError);
  });

  it('检测并发启动入口之间的延迟等待环', async () => {
    const a: Dependency<number> = ripple({ b: lazy(() => b) }, async ({ b }): Promise<number> =>
      b.resolve(),
    );

    const b: Dependency<number> = ripple({ a: lazy(() => a) }, async ({ a }): Promise<number> =>
      a.resolve(),
    );

    const app = new Cyrene({ ripples: { a, b } });
    await expect(app.start()).rejects.toBeInstanceOf(AggregateError);
    await app.dispose();
  });

  it('拒绝 transient 延迟等待环, 避免无限递归', async () => {
    const a: Dependency<number> = ripple(
      { b: lazy(() => b) },
      async ({ b }): Promise<number> => b.resolve(),
      {
        lifetime: 'transient',
      },
    );

    const b: Dependency<number> = ripple({ a }, ({ a }): number => a, {
      lifetime: 'transient',
    });

    const app = new Cyrene({ ripples: { a } });
    await expect(app.start()).rejects.toBeInstanceOf(CircularDependencyError);
    await app.dispose();
  });

  it('校验延迟依赖目标, 不提前初始化', async () => {
    const missing = token<number>('Missing');
    const factory = vi.fn(() => 1);
    const root = ripple({ later: lazy(() => missing) }, factory);
    const app = new Cyrene({ ripples: { root } });
    await expect(app.start()).rejects.toBeInstanceOf(MissingBindingError);
    expect(factory).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('保留依赖路径与工厂原始错误', async () => {
    const cause = new Error('offline');

    const database = ripple(
      {},
      () => {
        throw cause;
      },
      { debugName: 'Database' },
    );

    const service = ripple({ database }, () => 1, { debugName: 'Users' });
    const app = new Cyrene();
    await expect(app.resolve(service)).rejects.toMatchObject({
      path: ['Users', 'Database'],
      cause,
    });
    await app.dispose();
  });

  it('保留普通 Promise 输入, 不自动等待', async () => {
    const pending = deferred<number>();
    const service = ripple({ pending: pending.promise }, ({ pending }) => ({ pending }));
    const app = new Cyrene();
    const result = await app.resolve(service);
    expect(result.pending).toBe(pending.promise);
    pending.resolve(1);
    await app.dispose();
  });

  it('支持异步资源管理, 释放每个 transient 实例', async () => {
    const dispose = vi.fn();
    const service = ripple({}, () => ({}), { lifetime: 'transient', dispose });

    {
      await using app = new Cyrene({ ripples: { service } });
      await app.start();
      await app.resolve(service);
    }

    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('拒绝运行时延迟等待环, 避免死锁', async () => {
    const a: Dependency<number> = ripple({ b: lazy(() => b) }, async ({ b }): Promise<number> =>
      b.resolve(),
    );

    const b: Dependency<number> = ripple({ a }, ({ a }): number => a);
    const app = new Cyrene({ ripples: { a } });
    await expect(app.start()).rejects.toBeInstanceOf(CircularDependencyError);
    await app.dispose();
  });

  it('等待初始化后先释放消费者, 释放期间拒绝新解析', async () => {
    const gate = deferred<object>();
    const entered = deferred<void>();
    const order: string[] = [];

    const database = ripple(
      {},
      () => {
        entered.resolve();
        return gate.promise;
      },
      {
        dispose: () => {
          order.push('database');
        },
      },
    );

    const service = ripple({ database }, ({ database }) => ({ database }), {
      dispose: () => {
        order.push('service');
      },
    });

    const app = new Cyrene({ ripples: { service } });
    const startup = app.start();
    await entered.promise;
    const disposal = app.dispose();
    expect(app.dispose()).toBe(disposal);
    await expect(app.resolve(database)).rejects.toBeInstanceOf(DisposedError);
    await expect(app.start()).rejects.toBeInstanceOf(DisposedError);
    expect(order).toEqual([]);
    gate.resolve({});
    await startup;
    await disposal;
    expect(app.dispose()).toBe(disposal);
    await app.dispose();
    expect(order).toEqual(['service', 'database']);
  });

  it('记录后续激活的延迟依赖边, 保证释放顺序', async () => {
    const order: string[] = [];

    const database = ripple({}, () => ({}), {
      dispose: () => {
        order.push('database');
      },
    });

    const service = ripple({ database: lazy(() => database) }, ({ database }) => database, {
      dispose: () => {
        order.push('service');
      },
    });

    const app = new Cyrene();
    const handle = await app.resolve(service);
    await handle.resolve();
    await app.dispose();
    expect(order).toEqual(['service', 'database']);
  });

  it('清理失败后继续释放, 遵守外部资源归属与清理优先级', async () => {
    const externalDispose = vi.fn();
    const External = token<object>('External');
    const order: string[] = [];
    const syncDispose = vi.fn();
    const asyncDispose = vi.fn(async () => {});

    const resource = ripple({}, () => ({
      [Symbol.dispose]: syncDispose,
      [Symbol.asyncDispose]: asyncDispose,
    }));

    const broken = ripple({ resource, external: External }, () => ({}), {
      dispose: () => {
        order.push('broken');
        throw new Error('cleanup');
      },
    });

    const app = new Cyrene({
      ripples: { broken },
      bindings: [{ token: External, value: { [Symbol.dispose]: externalDispose } }],
    });

    await app.start();
    const disposal = app.dispose();
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    expect(app.dispose()).toBe(disposal);
    await expect(app.dispose()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(['broken']);
    expect(asyncDispose).toHaveBeenCalledOnce();
    expect(syncDispose).not.toHaveBeenCalled();
    expect(externalDispose).not.toHaveBeenCalled();
  });

  it('启动失败后等待其他分支结束, 保留成功实例供清理', async () => {
    const gate = deferred<object>();
    const cleanup = vi.fn();
    const good = ripple({}, () => gate.promise, { dispose: cleanup });

    const bad = ripple({}, () => {
      throw new Error('failed');
    });

    const app = new Cyrene({ ripples: { good, bad } });
    let settled = false;
    const startup = app.start();

    const observed = startup.catch(error => {
      settled = true;
      return error;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve({});
    expect(await observed).toBeInstanceOf(ResolutionError);
    await app.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('共享对象只释放一次, 优先使用显式清理方法', async () => {
    const automatic = vi.fn();
    const explicit = vi.fn();
    const value = { [Symbol.dispose]: automatic };
    const service = ripple({}, () => value, { lifetime: 'transient', dispose: explicit });
    const app = new Cyrene({ ripples: { a: service, b: service } });
    await app.start();
    await app.dispose();
    expect(explicit).toHaveBeenCalledOnce();
    expect(automatic).not.toHaveBeenCalled();
  });
});
