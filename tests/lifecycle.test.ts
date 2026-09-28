import { expect, it, vi } from 'vite-plus/test';

import { CircularDependencyError, Cyrene, DisposedError, lazy, ripple } from '../src/index.ts';
import type { Dependency, Lazy } from '../src/index.ts';
import { deferred } from './helpers.ts';

it('初始化期间仅启动 lazy 不建立等待边，目标可以等待启动方', async () => {
  const gate = deferred<void>();
  let pending: unknown;

  const a: Dependency<string, unknown, true> = ripple({ b: lazy(() => b) }, async ({ b }) => {
    pending = b.resolve();
    expect(b.resolve()).toBe(pending);
    await gate.promise;

    return 'a';
  });

  const b = ripple({ a: lazy(() => a) }, async ({ a }) => {
    await Promise.resolve();

    return `${await a.resolve()}b`;
  });

  const app = new Cyrene().add({ a, b });
  const first = app.resolve(a);
  const second = app.resolve(b);
  expect(pending).toBeInstanceOf(Promise);
  gate.resolve();
  expect(await first).toBe('a');
  expect(await second).toBe('ab');
  expect(await pending).toBe('ab');
  await app.dispose();
});

it('两个工厂在 await 后通过 lazy 互相等待仍拒绝并允许关闭', async () => {
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

it('lazy Promise 支持 then、catch 和 finally，并保留原始拒绝', async () => {
  const failure = new Error('unavailable');
  const finalized = vi.fn();

  const child = ripple(async () => {
    throw failure;
  });

  const parent = ripple({ child: lazy(() => child) }, ({ child }) =>
    child
      .resolve()
      .then(() => 'unexpected')
      .catch(error => {
        expect(error.cause).toBe(failure);

        return 'recovered';
      })
      .finally(finalized),
  );

  const app = new Cyrene().add({ child, parent });
  expect(await app.resolve(parent)).toBe('recovered');
  expect(finalized).toHaveBeenCalledOnce();
  await app.dispose();
});

it('初始化完成后的 lazy 句柄继续返回公共入口的缓存 Promise', async () => {
  const child = ripple(async () => 'child');
  let started: Promise<string> | undefined;

  const parent = ripple({ child: lazy(() => child) }, ({ child }) => {
    started = child.resolve();

    return child;
  });

  const app = new Cyrene().add({ child, parent });
  const handle = app.resolve(parent);
  const pending = app.resolve(child);
  expect(handle.resolve()).toBe(pending);
  expect(await started).toBe('child');
  expect(await pending).toBe('child');
  expect(handle.resolve()).toBe(pending);
  await app.dispose();
});

it('按需解析时 lazy 不激活依赖，句柄返回真实单例', async () => {
  const factory = vi.fn(() => ({}));
  const later = ripple(factory);
  const root = ripple({ later: lazy(() => later) }, deps => deps);
  const app = new Cyrene().add({ root, later });
  const value = app.resolve('root');
  expect(factory).not.toHaveBeenCalled();
  expect(value.later.resolve()).toBe(app.resolve('later'));
  await app.dispose();
  expect(() => value.later.resolve()).toThrow(DisposedError);
});

it('lazy 注册回调只在构图时求值，解析和诊断不重新求值', async () => {
  const later = ripple(() => ({}));
  const target = vi.fn(() => later);
  const root = ripple({ later: lazy(target) }, deps => deps);
  const app = new Cyrene().add({ root, later });
  expect(target).not.toHaveBeenCalled();
  app.inspect();
  const value = app.resolve('root');
  value.later.resolve();
  expect(target).toHaveBeenCalledOnce();
  await app.dispose();
});

it('未激活的 lazy 环合法，真实异步等待环被拒绝', async () => {
  const a: Dependency<unknown> = ripple({ b: lazy(() => b) }, async ({ b }) => b.resolve());
  const b: Dependency<unknown> = ripple({ a: lazy(() => a) }, async ({ a }) => a.resolve());
  const app = new Cyrene().add({ a, b });
  await expect(app.resolve('a')).rejects.toThrow();
  await app.dispose();
});

it('单节点 lazy 自等待被拒绝，失败句柄不能继续解析', async () => {
  let saved: Lazy<unknown> | undefined;

  const self: Dependency<unknown> = ripple({ self: lazy(() => self) }, async deps => {
    saved = deps.self;

    return deps.self.resolve();
  });

  const app = new Cyrene().add('self', self);
  await expect(app.resolve('self')).rejects.toBeInstanceOf(CircularDependencyError);
  expect(() => saved!.resolve()).toThrow(DisposedError);
  await app.dispose();
});

it('读取 ripples 只初始化目标，lazy 目标保持未创建', async () => {
  const factory = vi.fn(() => ({}));
  const later = ripple(factory);
  const root = ripple({ later: lazy(() => later) }, deps => deps);
  const app = new Cyrene().add({ root, later });
  const value = app.ripples.root;
  expect(value).toHaveProperty('later');
  expect(factory).not.toHaveBeenCalled();
  await app.dispose();
});
