import { describe, expect, it, vi } from 'vite-plus/test';

import {
  CircularDependencyError,
  Cyrene,
  InvalidDependencyError,
  lazy,
  ripple,
} from '../src/index.ts';
import { getDefinition } from '../src/metadata.ts';
import { deferred } from './helpers.ts';

describe('启动与依赖图', () => {
  it('执行工厂前统一校验全部入口', async () => {
    const factory = vi.fn(() => 1);
    const missing = lazy(() => 1 as never);

    const app = new Cyrene({
      ripples: {
        first: ripple({}, factory),
        invalid: ripple({ missing }, ({ missing }) => missing),
      },
    });

    await expect(app.start()).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(factory).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('跳过未使用的定义, 复用依赖目标的实例身份', async () => {
    const service = ripple({}, () => ({}));
    const unused = vi.fn(() => ({}));
    ripple({}, unused);
    const app = new Cyrene({ ripples: { service, direct: service } });
    await app.start();
    const result = await app.resolve(service);
    expect(await app.resolve(service)).toBe(result);
    expect(unused).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('拒绝非法入口', () => {
    expect(() => new Cyrene({ ripples: { invalid: 1 } as never })).toThrow(InvalidDependencyError);
  });

  it('检测强依赖环, 不执行工厂', () => {
    const factory = vi.fn(() => 1);
    const a = ripple({}, factory);
    const b = ripple({ a }, factory);
    // 定义快照不可修改, 仅在内部测试中构造强依赖环
    getDefinition(a).inputs = { b };
    const app = new Cyrene({ ripples: { a } });
    expect(() => app.validate()).toThrow(CircularDependencyError);
    expect(factory).not.toHaveBeenCalled();
  });

  it('相同节点同时以 lazy 和强依赖出现时仍按强依赖检测环', () => {
    const a = ripple({}, () => 1);
    const b = ripple({ a }, () => 2);
    // 故意把强依赖放在 lazy 前, 覆盖双向邻接索引的合并规则。
    getDefinition(a).inputs = { direct: b, deferred: lazy(() => b) };
    const app = new Cyrene({ ripples: { a } });

    expect(() => app.validate()).toThrow(CircularDependencyError);
  });

  it('查看 Ref 与延迟依赖边, 不触发初始化', () => {
    const factory = vi.fn(() => ({}));
    const value = ripple({}, factory, { debugName: 'Value' });
    const ref = value();
    const root = ripple({ value: lazy(() => ref) }, ({ value }) => value);
    const graph = new Cyrene({ ripples: { root } }).inspect();
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
    const app = new Cyrene({ ripples: { first: dependency, second: dependency } });
    const startup = app.start();
    expect(app.start()).toBe(startup);
    const resolved = app.resolve(dependency);
    gate.resolve({});
    expect(await startup).toBeUndefined();
    expect(await resolved).toBe(await app.resolve(dependency));
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
    const app = new Cyrene({ ripples: { dependency } });
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

  it('重复启动不再初始化 transient, 显式解析时创建新实例', async () => {
    const factory = vi.fn(() => ({}));
    const dependency = ripple({}, factory, { lifetime: 'transient' });
    const app = new Cyrene({ ripples: { dependency } });
    expect(await app.start()).toBeUndefined();
    expect(await app.start()).toBeUndefined();
    expect(factory).toHaveBeenCalledOnce();
    const first = await app.resolve(dependency);
    expect(await app.resolve(dependency)).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(3);
    await app.dispose();
  });

  it('无入口启动后通过 add 接入新目标, 不改变启动结果', async () => {
    const dispose = vi.fn();
    const factory = vi.fn(() => ({}));
    const service = ripple({}, factory, { dispose });
    const app = new Cyrene();
    const startup = app.start();
    expect(await startup).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
    await expect(app.resolve(service)).rejects.toBeInstanceOf(InvalidDependencyError);
    const instance = await app.add(service);
    expect(await app.resolve(service)).toBe(instance);
    expect(app.start()).toBe(startup);
    expect(await app.start()).toBeUndefined();
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

    const app = new Cyrene({ ripples: { service } });
    await app.start();
    const result = await app.resolve(service);
    expect(await app.resolve(service)).toBe(result);
    expect(await app.resolve(service)).toBe(result);
    expect(factory).toHaveBeenCalledOnce();
    const first = await app.resolve(resource);
    const second = await app.resolve(resource);
    expect(first).not.toBe(result.resource);
    expect(second).not.toBe(result.resource);
    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(3);
    expect(released).toEqual([]);
    await app.dispose();
    expect(released).toHaveLength(4);
    expect(new Set(released)).toEqual(new Set([result, result.resource, first, second]));
    expect(released.indexOf(result)).toBeLessThan(released.indexOf(result.resource));
  });
});
