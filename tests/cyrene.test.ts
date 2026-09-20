import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test';

import {
  CircularDependencyError,
  Cyrene,
  DisposedError,
  InvalidDependencyError,
  MissingBindingError,
  ResolutionError,
  lazy,
  ripple,
  token,
} from '../src/index.ts';
import type { Binding, Dependency, DependencyRef, Lazy } from '../src/index.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;

  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });

  return { promise, resolve, reject };
}

describe('依赖定义与输入', () => {
  it('推导参数和异步实例类型, 声明时不执行工厂', async () => {
    const Config = token<{ prefix: string }>('Config');

    const factory = vi.fn(
      async ({ config }: { config: { prefix: string } }, name: string, count: number = 1) => ({
        label: config.prefix + name,
        count,
      }),
    );

    const service = ripple({ config: Config }, factory);
    const ref = service('users', 2);
    expect(factory).not.toHaveBeenCalled();

    const app = new Cyrene({
      providers: { users: ref },
      bindings: [{ token: Config, value: { prefix: 'test:' } }],
    });

    expect(factory).not.toHaveBeenCalled();
    const result = await app.start();
    expectTypeOf(result.users).toEqualTypeOf<{ label: string; count: number }>();
    expect(result.users).toEqual({ label: 'test:users', count: 2 });
    expect(await app.resolve(ref)).toBe(result.users);
    await app.dispose();
  });

  it('保留普通值, 函数, 嵌套对象和 Symbol 键', async () => {
    const symbol = Symbol('input');
    const callback = vi.fn();
    class Example {}
    const hidden = ripple({}, vi.fn());
    const nested = { hidden };
    const factory = ripple({ callback, nested, Example, [symbol]: 42 }, values => values);
    const app = new Cyrene();
    const result = await app.resolve(factory);
    expect(result.callback).toBe(callback);
    expect(result.nested).toBe(nested);
    expect(result.Example).toBe(Example);
    expect(result[symbol]).toBe(42);
    expect(callback).not.toHaveBeenCalled();
    const fn = ripple({}, () => callback);
    expect(await app.resolve(fn)).toBe(callback);
    await app.dispose();
  });

  it('区分定义与 Ref 身份, 隔离不同运行时的缓存', async () => {
    const service = ripple({}, () => ({}));
    const a = service();
    const b = service();
    const app = new Cyrene();
    const other = new Cyrene();
    const instance = await app.resolve(service);
    expect(await app.resolve(service)).toBe(instance);
    expect(await other.resolve(service)).not.toBe(instance);
    const first = await app.resolve(a);
    expect(first).not.toBe(instance);
    expect(await app.resolve(a)).toBe(first);
    expect(await app.resolve(b)).not.toBe(first);
    await Promise.all([app.dispose(), other.dispose()]);
  });

  it('快照保存声明, 支持外部 undefined 和函数值', async () => {
    const Value = token<undefined>('Value');
    const Handler = token<() => void>('Handler');
    const handler = vi.fn();
    const inputs = { value: 1 };
    const source = ripple(inputs, ({ value }) => value);
    inputs.value = 2;
    const providers = { value: source, empty: Value, handler: Handler };
    const binding = { token: Handler, value: handler };

    const app = new Cyrene({
      providers,
      bindings: [{ token: Value, value: undefined }, binding],
    });

    providers.value = ripple({}, () => 3);
    binding.value = vi.fn();
    const result = await app.start();
    expect(result).toEqual({ value: 1, empty: undefined, handler });
    expect(handler).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('校验公开 API 的类型边界', () => {
    const required = ripple({}, (_deps, value: string) => value.length);
    const optional = ripple({}, (_deps, value = 1) => value);
    const rest = ripple({}, (_deps, ...values: number[]) => values.length);
    const mixed = ripple({}, (_deps, name: string, retry = 3) => ({ name, retry }));
    const Count = token<number>('Count');
    expectTypeOf(optional()).toEqualTypeOf<DependencyRef<number>>();
    expectTypeOf(rest(1, 2)).toEqualTypeOf<DependencyRef<number>>();
    expectTypeOf(mixed('users')).toEqualTypeOf<DependencyRef<{ name: string; retry: number }>>();
    expectTypeOf(required('abc')).toEqualTypeOf<ReturnType<typeof required>>();

    // 仅做编译期检查, 非法调用不进入运行时
    const checkInvalidCalls = () => {
      // @ts-expect-error 参数类型必须匹配
      required(123);
      // @ts-expect-error 默认参数保留类型约束
      optional('no');
      // @ts-expect-error 缺少必填参数
      required();
      // @ts-expect-error 参数化定义不能直接作为入口
      new Cyrene({ providers: { required } });
      // @ts-expect-error 可选参数也需显式创建 Ref
      void new Cyrene().resolve(optional);
      // @ts-expect-error rest 参数也需显式创建 Ref
      void new Cyrene().resolve(rest);
      // @ts-expect-error 参数化定义不能直接注入
      ripple({ required }, () => 1);
      // @ts-expect-error 精确绑定类型检查
      const bad: Binding<number> = { token: Count, value: 'no' };
      void bad;
      // @ts-expect-error 异构 bindings 也应校验 Token 与实现的关系
      new Cyrene({ bindings: [{ token: Count, value: 'no' }] });
      // @ts-expect-error dependency binding 的实例类型必须匹配
      new Cyrene({ bindings: [{ token: Count, dependency: ripple({}, () => 'no') }] });
      // @ts-expect-error 已移除 scoped
      ripple({}, () => 1, { lifetime: 'scoped' });
      // @ts-expect-error 已移除 add
      new Cyrene().add({});
      // @ts-expect-error 已移除 createScope
      new Cyrene().createScope();
    };

    expectTypeOf(checkInvalidCalls).toBeFunction();
  });
});

describe('启动, 绑定与依赖图', () => {
  it('执行工厂前统一校验全部入口', async () => {
    const factory = vi.fn(() => 1);
    const missing = token<number>('Missing');

    const app = new Cyrene({
      providers: {
        first: ripple({}, factory),
        invalid: ripple({ missing }, ({ missing }) => missing),
      },
    });

    await expect(app.start()).rejects.toBeInstanceOf(MissingBindingError);
    expect(factory).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('跳过未使用的绑定, 复用绑定目标的实例身份', async () => {
    const Service = token<object>('Service');
    const Unused = token<object>('Unused');
    const service = ripple({}, () => ({}));
    const unused = vi.fn(() => ({}));

    const app = new Cyrene({
      providers: { service: Service, direct: service },
      bindings: [
        { token: Service, dependency: service },
        { token: Unused, dependency: ripple({}, unused) },
      ],
    });

    const result = await app.start();
    expect(result.service).toBe(result.direct);
    expect(unused).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('拒绝重复, 歧义和非法绑定', () => {
    const Value = token<number>('Value');
    expect(
      () =>
        new Cyrene({
          bindings: [
            { token: Value, value: 1 },
            { token: Value, value: 2 },
          ],
        }),
    ).toThrow(InvalidDependencyError);
    expect(
      () =>
        new Cyrene({
          bindings: [
            {
              token: Value,
              value: 1,
              dependency: ripple({}, () => 2),
            } as unknown as Binding,
          ],
        }),
    ).toThrow(InvalidDependencyError);
    expect(() => new Cyrene({ providers: { invalid: 1 } as never })).toThrow(
      InvalidDependencyError,
    );
    const SameName = token<number>('Value');

    const app = new Cyrene({
      bindings: [
        { token: Value, value: 1 },
        { token: SameName, value: 2 },
      ],
    });

    expect(() => app.validate(Value)).not.toThrow();
  });

  it('检测跨绑定的强依赖环, 不执行工厂', () => {
    const A = token<number>('A');
    const B = token<number>('B');
    const factory = vi.fn(({ value }: { value: number }) => value);
    const a = ripple({ value: B }, factory);
    const b = ripple({ value: A }, factory);

    const app = new Cyrene({
      providers: { a },
      bindings: [
        { token: A, dependency: a },
        { token: B, dependency: b },
      ],
    });

    expect(() => app.validate()).toThrow(CircularDependencyError);
    expect(factory).not.toHaveBeenCalled();
  });

  it('查看 Ref 与延迟依赖边, 不触发初始化', () => {
    const factory = vi.fn(() => ({}));
    const value = ripple({}, factory, { debugName: 'Value' });
    const ref = value();
    const root = ripple({ value: lazy(() => ref) }, ({ value }) => value);
    const graph = new Cyrene({ providers: { root } }).inspect();
    expect(graph.edges.map(edge => edge.kind)).toEqual(
      expect.arrayContaining(['lazy', 'definition']),
    );
    expect(graph.nodes.find(node => node.kind === 'ref')?.params).toEqual([]);
    expect(factory).not.toHaveBeenCalled();
  });

  it('并发解析与启动共享同一次单例初始化', async () => {
    const gate = deferred<object>();
    const factory = vi.fn(() => gate.promise);
    const dependency = ripple({}, factory);
    const app = new Cyrene({ providers: { first: dependency, second: dependency } });
    const startup = app.start();
    expect(app.start()).toBe(startup);
    const resolved = app.resolve(dependency);
    gate.resolve({});
    const result = await startup;
    expect(await resolved).toBe(result.first);
    expect(result.first).toBe(result.second);
    expect(factory).toHaveBeenCalledTimes(1);
    await app.dispose();
  });

  it('允许失败后重新解析, 保留原启动失败结果', async () => {
    const failure = new Error('offline');

    const factory = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(42);

    const dependency = ripple({}, factory, { debugName: 'Database' });
    const app = new Cyrene({ providers: { dependency } });
    const startup = app.start();
    await expect(startup).rejects.toMatchObject({
      name: 'ResolutionError',
      cause: failure,
      path: ['Database'],
    });
    expect(app.start()).toBe(startup);
    expect(await app.resolve(dependency)).toBe(42);
    expect(factory).toHaveBeenCalledTimes(2);
    await app.dispose();
  });

  it('复用 transient 启动结果, 显式解析时创建新实例', async () => {
    const factory = vi.fn(() => ({}));
    const dependency = ripple({}, factory, { lifetime: 'transient' });
    const app = new Cyrene({ providers: { dependency } });
    const result = await app.start();
    expect(await app.start()).toBe(result);
    expect(await app.resolve(dependency)).not.toBe(result.dependency);
    expect(await app.resolve(dependency)).not.toBe(result.dependency);
    expect(factory).toHaveBeenCalledTimes(3);
    await app.dispose();
    expect(await new Cyrene().start()).toEqual({});
  });
});

describe('延迟解析与资源释放', () => {
  it('支持合法的延迟依赖环, 释放后拒绝解析', async () => {
    interface A {
      b: Lazy<B>;
    }
    interface B {
      a: A;
    }
    const factory = vi.fn(({ a }: { a: A }): B => ({ a }));
    const a: Dependency<A> = ripple({ b: lazy(() => b) }, ({ b }): A => ({ b }));
    const b: Dependency<B> = ripple({ a }, factory);
    const app = new Cyrene({ providers: { a } });
    const result = await app.start();
    expect(factory).not.toHaveBeenCalled();
    expect((await result.a.b.resolve()).a).toBe(result.a);
    await app.dispose();
    await expect(result.a.b.resolve()).rejects.toBeInstanceOf(DisposedError);
  });

  it('检测并发启动入口之间的延迟等待环', async () => {
    const a: Dependency<number> = ripple({ b: lazy(() => b) }, async ({ b }): Promise<number> =>
      b.resolve(),
    );

    const b: Dependency<number> = ripple({ a: lazy(() => a) }, async ({ a }): Promise<number> =>
      a.resolve(),
    );

    const app = new Cyrene({ providers: { a, b } });
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

    const app = new Cyrene({ providers: { a } });
    await expect(app.start()).rejects.toBeInstanceOf(CircularDependencyError);
    await app.dispose();
  });

  it('校验延迟依赖目标, 不提前初始化', async () => {
    const missing = token<number>('Missing');
    const factory = vi.fn(() => 1);
    const root = ripple({ later: lazy(() => missing) }, factory);
    const app = new Cyrene({ providers: { root } });
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
      await using app = new Cyrene({ providers: { service } });
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
    const app = new Cyrene({ providers: { a } });
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

    const app = new Cyrene({ providers: { service } });
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
      providers: { broken },
      bindings: [{ token: External, value: { [Symbol.dispose]: externalDispose } }],
    });

    await app.start();
    const disposal = app.dispose();
    await expect(disposal).rejects.toBeInstanceOf(AggregateError);
    expect(app.dispose()).toBe(disposal);
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

    const app = new Cyrene({ providers: { good, bad } });
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
    const app = new Cyrene({ providers: { a: service, b: service } });
    await app.start();
    await app.dispose();
    expect(explicit).toHaveBeenCalledOnce();
    expect(automatic).not.toHaveBeenCalled();
  });
});
