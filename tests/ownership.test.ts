import { describe, expect, it, vi } from 'vite-plus/test';

import { Cyrene, InvalidDependencyError, lazy, ripple } from '../src/index.ts';
import { deferred } from './helpers.ts';

describe('资源归属与别名', () => {
  it('释放等待在途别名完成, 合并后激活的 lazy 依赖', async () => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const order: string[] = [];

    const value = {
      [Symbol.dispose]: () => {
        order.push('shared');
      },
    };

    const shared = ripple({}, () => value);

    const consumer = ripple({ later: lazy(() => shared) }, ({ later }) => ({ later }), {
      dispose: () => {
        order.push('consumer');
      },
    });

    const alias = ripple({}, async () => {
      entered.resolve();
      await gate.promise;
      return value;
    });

    const app = new Cyrene({ ripples: { consumer, alias } });
    const result = await app.resolve(consumer);
    await result.later.resolve();
    const pending = app.resolve(alias);
    await entered.promise;
    const disposal = app.dispose();
    expect(order).toEqual([]);
    gate.resolve();
    await pending;
    await disposal;
    expect(order).toEqual(['consumer', 'shared']);
  });

  it('对象别名合并造成资源环时仍各清理一次, 清理失败继续释放', async () => {
    const cleanup = vi.fn();
    const failure = new Error('cleanup failed');

    const shared = {
      [Symbol.dispose]: () => {
        throw failure;
      },
    };

    const leaf = ripple({}, () => shared);
    const middle = ripple({ leaf }, () => ({}), { dispose: cleanup });
    const root = ripple({ middle }, () => shared);
    const app = new Cyrene({ ripples: { root } });
    await app.start();
    const disposal = app.dispose();
    await expect(disposal).rejects.toMatchObject({ errors: [failure] });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(app.dispose()).toBe(disposal);
  });

  it.each([false, true])('合并别名的消费者和依赖, 入口反转=%s', async reverse => {
    const order: string[] = [];
    const shared = { [Symbol.dispose]: () => order.push('shared') };

    const left = ripple({}, () => ({}), {
      dispose: () => {
        order.push('left');
      },
    });

    const right = ripple({}, () => ({}), {
      dispose: () => {
        order.push('right');
      },
    });

    const a = ripple({ left }, () => shared);
    const b = ripple({ right }, () => shared);

    const consumer = ripple({ a }, ({ a }) => ({ a }), {
      dispose: () => {
        order.push('consumer');
      },
    });

    const app = new Cyrene({ ripples: reverse ? { b, consumer } : { consumer, b } });
    await app.start();
    await app.dispose();
    expect(order.filter(name => name === 'shared')).toHaveLength(1);
    expect(order.indexOf('consumer')).toBeLessThan(order.indexOf('shared'));
    expect(order.indexOf('shared')).toBeLessThan(order.indexOf('left'));
    expect(order.indexOf('shared')).toBeLessThan(order.indexOf('right'));
  });

  it.each([false, true])('显式清理覆盖别名的自动清理, 显式定义先解析=%s', async explicitFirst => {
    const automatic = vi.fn();
    const explicit = vi.fn();
    const value = { [Symbol.dispose]: automatic };
    const a = ripple({}, () => value);
    const b = ripple({}, () => value, { dispose: explicit });
    const c = ripple({}, () => value, { dispose: explicit });
    const app = new Cyrene({ ripples: { a, b, c } });

    for (const target of explicitFirst ? [b, a, c] : [a, b, c]) {
      await app.resolve(target);
    }

    await app.dispose();
    expect(explicit).toHaveBeenCalledExactlyOnceWith(value);
    expect(automatic).not.toHaveBeenCalled();
  });

  it('清理冲突使解析失败, 保留原清理方法及失败别名的依赖边', async () => {
    const order: string[] = [];
    const value = {};

    const cleanup = () => {
      order.push('shared');
    };

    const conflicting = vi.fn();

    const dependency = ripple({}, () => ({}), {
      dispose: () => {
        order.push('dependency');
      },
    });

    const first = ripple({}, () => value, { dispose: cleanup });
    const second = ripple({ dependency }, () => value, { dispose: conflicting });
    const app = new Cyrene({ ripples: { first, second } });
    await app.resolve(first);
    await expect(app.resolve(second)).rejects.toMatchObject({
      name: 'ResolutionError',
      cause: expect.any(InvalidDependencyError),
    });
    await app.dispose();
    expect(order).toEqual(['shared', 'dependency']);
    expect(conflicting).not.toHaveBeenCalled();
  });

  it('工厂返回的对象和函数按资源管理, 经别名转发只释放一次', async () => {
    const dispose = vi.fn();
    const object = { [Symbol.dispose]: dispose };
    const fn = Object.assign(() => {}, { [Symbol.dispose]: dispose });
    const source = ripple({}, () => object);
    const forwarded = ripple({ source }, ({ source }) => source);
    const alias = ripple({ forwarded }, ({ forwarded }) => forwarded);
    const app = new Cyrene({ ripples: [source, alias, ripple({}, () => fn)] });
    await app.start();
    expect(await app.resolve(source)).toBe(object);
    expect(await app.resolve(alias)).toBe(object);
    await app.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });

  it('原始值不按相等值合并资源', async () => {
    const dispose = vi.fn();
    const service = ripple({}, () => 1, { lifetime: 'transient', dispose });

    const app = new Cyrene({
      ripples: { a: service, b: service },
    });

    await app.start();
    await app.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});
