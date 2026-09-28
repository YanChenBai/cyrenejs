import { expect, it, vi } from 'vite-plus/test';

import { CircularDependencyError, Cyrene, DisposedError, lazy, ripple } from '../src/index.ts';
import type { Dependency, Lazy } from '../src/index.ts';
import { deferred } from './helpers.ts';

it('异步父工厂仅启动 lazy 子服务时，子服务可以强依赖仍在执行的父工厂', async () => {
  const gate = deferred<void>();
  const events: string[] = [];
  let pending: Promise<{ parent: object }> | undefined;

  const parent: Dependency<object, unknown, true> = ripple(
    'parent',
    { child: lazy(() => child) },
    async ({ child }) => {
      pending = child.resolve();
      await gate.promise;

      return { [Symbol.dispose]: () => events.push('parent') };
    },
  );

  const child = ripple('child', { parent }, ({ parent }) => ({
    parent,
    [Symbol.dispose]: () => events.push('child'),
  }));

  const app = new Cyrene().use(parent);
  const first = app.resolve(parent);
  const second = app.resolve(child);
  const closing = app.dispose();
  gate.resolve();
  const value = await first;
  expect((await second).parent).toBe(value);
  expect(await pending).toBe(await second);
  await closing;
  expect(events).toEqual(['child', 'parent']);
});

it('父工厂真正等待强依赖自己的 lazy 子服务时仍拒绝循环并允许关闭', async () => {
  const parent: Dependency<string, unknown, true> = ripple(
    'parent',
    { child: lazy(() => child) },
    async ({ child }) => child.resolve(),
  );

  const child = ripple('child', { parent }, ({ parent }) => parent);
  const app = new Cyrene().use(parent);
  await expect(app.resolve(parent)).rejects.toBeInstanceOf(CircularDependencyError);
  await app.dispose();
});

it('普通工厂返回 Promise 时也允许 lazy 子服务等待父服务，父失败传递给子服务', async () => {
  const gate = deferred<string>();
  const failure = new Error('parent failed');
  let pending: Promise<string> | undefined;
  const childFactory = vi.fn(({ parent }: { parent: string }) => parent);

  const parent: Dependency<string, unknown, true> = ripple(
    'parent',
    { child: lazy(() => child) },
    ({ child }) => {
      pending = child.resolve();

      return gate.promise;
    },
  );

  const child = ripple('child', { parent }, childFactory);
  const app = new Cyrene().use(parent);
  const first = app.resolve(parent);
  const second = app.resolve(child);
  const closing = app.dispose();
  gate.reject(failure);
  await expect(first).rejects.toMatchObject({ cause: failure });
  await expect(second).rejects.toMatchObject({ cause: failure });
  await expect(pending).rejects.toMatchObject({ cause: failure });
  expect(childFactory).not.toHaveBeenCalled();
  await closing;
});

it('同步父工厂启动强依赖自己的 lazy 子服务仍拒绝，已交付资源正常清理', async () => {
  const cleanup = vi.fn();
  let pending: unknown;

  const parent: Dependency<object, unknown, false> = ripple(
    'parent',
    { child: lazy(() => child) },
    ({ child }) => {
      pending = child.resolve();

      return { [Symbol.dispose]: cleanup };
    },
  );

  const child = ripple('child', { parent }, ({ parent }) => parent);
  const app = new Cyrene().use(parent);
  expect(() => app.resolve(parent)).toThrow(CircularDependencyError);
  await expect(pending).rejects.toBeInstanceOf(CircularDependencyError);
  await app.dispose();
  expect(cleanup).toHaveBeenCalledOnce();
});

it.each(['singleton', 'transient'] as const)('公共解析同步重入仍拒绝：%s', async lifetime => {
  const app = new Cyrene();
  const factory = vi.fn((): object => app.resolve(service));
  const service = ripple('service', factory, { lifetime });
  app.use(service);
  expect(() => app.resolve(service)).toThrow(CircularDependencyError);
  expect(factory).toHaveBeenCalledOnce();
  await app.dispose();
});

it('初始化期间仅启动 lazy 不建立等待边，目标可以等待启动方', async () => {
  const gate = deferred<void>();
  let pending: unknown;

  const a: Dependency<string, unknown, true> = ripple('a', { b: lazy(() => b) }, async ({ b }) => {
    pending = b.resolve();
    expect(b.resolve()).toBe(pending);
    await gate.promise;

    return 'a';
  });

  const b = ripple('b', { a: lazy(() => a) }, async ({ a }) => {
    await Promise.resolve();

    return `${await a.resolve()}b`;
  });

  const app = new Cyrene().use(a, b);
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
  const a: Dependency<unknown> = ripple('a', { b: lazy(() => b) }, async ({ b }) => {
    await Promise.resolve();

    return b.resolve();
  });

  const b: Dependency<unknown> = ripple('b', { a: lazy(() => a) }, async ({ a }) => {
    await Promise.resolve();

    return a.resolve();
  });

  const app = new Cyrene().use(a, b);
  await expect(app.resolve(a)).rejects.toBeInstanceOf(CircularDependencyError);
  await app.dispose();
});

it('lazy Promise 支持 then、catch 和 finally，并保留原始拒绝', async () => {
  const failure = new Error('unavailable');
  const finalized = vi.fn();

  const child = ripple('child', async () => {
    throw failure;
  });

  const parent = ripple('parent', { child: lazy(() => child) }, ({ child }) =>
    child
      .resolve()
      .then(() => 'unexpected')
      .catch(error => {
        expect(error.cause).toBe(failure);

        return 'recovered';
      })
      .finally(finalized),
  );

  const app = new Cyrene().use(child, parent);
  expect(await app.resolve(parent)).toBe('recovered');
  expect(finalized).toHaveBeenCalledOnce();
  await app.dispose();
});

it('初始化完成后的 lazy 句柄继续返回公共入口的缓存 Promise', async () => {
  const child = ripple('child', async () => 'child');
  let started: Promise<string> | undefined;

  const parent = ripple('parent', { child: lazy(() => child) }, ({ child }) => {
    started = child.resolve();

    return child;
  });

  const app = new Cyrene().use(child, parent);
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
  const later = ripple('later', factory);
  const root = ripple('root', { later: lazy(() => later) }, deps => deps);
  const app = new Cyrene().use(root, later);
  const value = app.resolve('root');
  expect(factory).not.toHaveBeenCalled();
  expect(value.later.resolve()).toBe(app.resolve('later'));
  await app.dispose();
  expect(() => value.later.resolve()).toThrow(DisposedError);
});

it('lazy 注册回调只在构图时求值，解析和诊断不重新求值', async () => {
  const later = ripple('later', () => ({}));
  const target = vi.fn(() => later);
  const root = ripple('root', { later: lazy(target) }, deps => deps);
  const app = new Cyrene().use(root, later);
  expect(target).not.toHaveBeenCalled();
  app.inspect();
  const value = app.resolve('root');
  value.later.resolve();
  expect(target).toHaveBeenCalledOnce();
  await app.dispose();
});

it('未激活的 lazy 环合法，真实异步等待环被拒绝', async () => {
  const a: Dependency<unknown> = ripple('a', { b: lazy(() => b) }, async ({ b }) => b.resolve());
  const b: Dependency<unknown> = ripple('b', { a: lazy(() => a) }, async ({ a }) => a.resolve());
  const app = new Cyrene().use(a, b);
  await expect(app.resolve('a')).rejects.toThrow();
  await app.dispose();
});

it('单节点 lazy 自等待被拒绝，失败句柄不能继续解析', async () => {
  let saved: Lazy<unknown> | undefined;

  const self: Dependency<unknown> = ripple('self', { self: lazy(() => self) }, async deps => {
    saved = deps.self;

    return deps.self.resolve();
  });

  const app = new Cyrene().use(self);
  await expect(app.resolve('self')).rejects.toBeInstanceOf(CircularDependencyError);
  expect(() => saved!.resolve()).toThrow(DisposedError);
  await app.dispose();
});

it('读取 ripples 只初始化目标，lazy 目标保持未创建', async () => {
  const factory = vi.fn(() => ({}));
  const later = ripple('later', factory);
  const root = ripple('root', { later: lazy(() => later) }, deps => deps);
  const app = new Cyrene().use(root, later);
  const value = app.ripples.root;
  expect(value).toHaveProperty('later');
  expect(factory).not.toHaveBeenCalled();
  await app.dispose();
});
