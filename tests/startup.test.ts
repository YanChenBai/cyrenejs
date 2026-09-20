import { describe, expect, it, vi } from 'vite-plus/test';

import {
  CircularDependencyError,
  Cyrene,
  InvalidDependencyError,
  MissingBindingError,
  lazy,
  ripple,
  token,
} from '../src/index.ts';
import type { Binding } from '../src/index.ts';
import { deferred } from './helpers.ts';

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
  });

  it('无入口启动后仍可按需解析, 不改变启动结果', async () => {
    const dispose = vi.fn();
    const factory = vi.fn(() => ({}));
    const service = ripple({}, factory, { dispose });
    const app = new Cyrene();
    const startup = app.start();
    expect(await startup).toEqual({});
    expect(factory).not.toHaveBeenCalled();
    const instance = await app.resolve(service);
    expect(await app.resolve(service)).toBe(instance);
    expect(app.start()).toBe(startup);
    expect(await app.start()).toEqual({});
    expect(factory).toHaveBeenCalledOnce();
    await app.dispose();
    expect(dispose).toHaveBeenCalledExactlyOnceWith(instance);
  });

  it('singleton 保留捕获的 transient, 直接解析创建独立实例并全部释放', async () => {
    const released: object[] = [];
    const factory = vi.fn(() => ({}));

    const resource = ripple({}, factory, {
      lifetime: 'transient',
      dispose: value => {
        released.push(value);
      },
    });

    const service = ripple({ resource }, ({ resource }) => ({ resource }), {
      dispose: value => {
        released.push(value);
      },
    });

    const app = new Cyrene({ providers: { service } });
    const result = await app.start();
    expect(await app.resolve(service)).toBe(result.service);
    expect(await app.resolve(service)).toBe(result.service);
    expect(factory).toHaveBeenCalledOnce();
    const first = await app.resolve(resource);
    const second = await app.resolve(resource);
    expect(first).not.toBe(result.service.resource);
    expect(second).not.toBe(result.service.resource);
    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(released).toEqual([]);
    await app.dispose();
    expect(released).toHaveLength(4);
    expect(new Set(released)).toEqual(
      new Set([result.service, result.service.resource, first, second]),
    );
    expect(released.indexOf(result.service)).toBeLessThan(
      released.indexOf(result.service.resource),
    );
  });
});
