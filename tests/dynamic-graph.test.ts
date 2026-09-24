import { describe, expect, it, vi } from 'vite-plus/test';

import { Cyrene, InvalidDependencyError, formatGraph, lazy, ripple } from '../src/index.ts';
import type { Dependency } from '../src/index.ts';
import { deferred } from './helpers.ts';

describe('运行时依赖图', () => {
  it('启动后增加入口并复用已有依赖, 移除时只释放目标', async () => {
    const released: string[] = [];

    const shared = ripple({}, () => ({ name: 'shared' }), {
      dispose: () => {
        released.push('shared');
      },
    });

    const initial = ripple({ shared }, ({ shared }) => shared.name);

    const added = ripple({ shared }, ({ shared }) => ({ shared }), {
      dispose: () => {
        released.push('added');
      },
    });

    const app = new Cyrene({ ripples: { initial } });

    await app.start();
    expect(await app.add(added)).toEqual({ shared: await app.resolve(shared) });
    expect(app.inspect().roots).toHaveLength(3);

    await app.remove(added);
    expect(released).toEqual(['added']);
    expect(app.inspect().roots).toHaveLength(2);
    expect(await app.resolve(initial)).toBe('shared');

    await app.dispose();
    expect(released).toEqual(['added', 'shared']);
  });

  it('prune 清理孤立依赖, 但保留共享依赖与独立入口', async () => {
    const released: string[] = [];

    const leaf = ripple({}, () => ({ name: 'leaf' }), {
      dispose: () => {
        released.push('leaf');
      },
    });

    const shared = ripple({}, () => ({ name: 'shared' }), {
      dispose: () => {
        released.push('shared');
      },
    });

    const branch = ripple({ leaf, shared }, values => values, {
      dispose: () => {
        released.push('branch');
      },
    });

    const first = ripple({ branch }, values => values, {
      dispose: () => {
        released.push('first');
      },
    });

    const second = ripple({ shared }, values => values);
    const app = new Cyrene({ ripples: { first, second } });

    await app.start();
    await app.prune(first);

    expect(released).toEqual(['first', 'branch', 'leaf']);
    expect(app.inspect().roots).toHaveLength(1);
    expect(await app.resolve(second)).toEqual({ shared: { name: 'shared' } });

    await app.dispose();
    expect(released).toEqual(['first', 'branch', 'leaf', 'shared']);
  });

  it('prune 保留单独声明为入口的依赖', async () => {
    const dependency = ripple({}, () => ({ value: 1 }));
    const consumer = ripple({ dependency }, ({ dependency }) => dependency.value);
    const app = new Cyrene({ ripples: { consumer, dependency } });

    await app.start();
    await app.prune(consumer);

    expect(app.inspect().roots).toHaveLength(1);
    expect(await app.resolve(dependency)).toEqual({ value: 1 });
    await app.dispose();
  });

  it('拒绝删除有 consumer 的节点, lazy 边也算 consumer', async () => {
    const dependency = ripple({}, () => ({ value: 1 }));
    const consumer = ripple({ dependency: lazy(() => dependency) }, values => values);
    const app = new Cyrene({ ripples: { dependency, consumer } });

    await app.start();
    await expect(app.remove(dependency)).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.prune(dependency)).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(app.inspect().roots).toHaveLength(2);
    await app.dispose();
  });

  it('剪枝后旧 lazy 句柄失效, 目标只能通过 add 重新接入', async () => {
    const dependency = ripple({}, () => ({ value: 1 }));
    const consumer = ripple({ dependency: lazy(() => dependency) }, values => values);
    const app = new Cyrene({ ripples: { consumer } });

    await app.start();
    const instance = await app.resolve(consumer);
    await app.prune(consumer);

    await expect(instance.dependency.resolve()).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.resolve(dependency)).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(await app.add(dependency)).toEqual({ value: 1 });
    await app.dispose();
  });

  it('失败的 add 不保留入口, 清理本次创建的资源', async () => {
    const dispose = vi.fn();
    const dependency = ripple({}, () => ({}), { dispose });

    const broken = ripple({ dependency }, () => {
      throw new Error('failed');
    });

    const app = new Cyrene();

    await app.start();
    await expect(app.add(broken)).rejects.toThrow('Failed to resolve');
    expect(app.inspect().roots).toHaveLength(0);
    expect(dispose).toHaveBeenCalledOnce();

    await app.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('启动前不允许修改运行时图', async () => {
    const service = ripple({}, () => 1);
    const app = new Cyrene({ ripples: { service } });

    await expect(app.add(service)).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.remove(service)).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.prune(service)).rejects.toBeInstanceOf(InvalidDependencyError);
    await app.dispose();
  });

  it('失败的 add 若创建已有资源的别名, 保留其新依赖直到整体释放', async () => {
    const released: string[] = [];
    const shared = {};

    const initial = ripple({}, () => shared, {
      dispose: () => {
        released.push('shared');
      },
    });

    const fresh = ripple({}, () => ({}), {
      dispose: () => {
        released.push('fresh');
      },
    });

    const alias = ripple({ fresh }, () => shared);

    const broken = ripple({ alias }, () => {
      throw new Error('failed');
    });

    const app = new Cyrene({ ripples: { initial } });

    await app.start();
    await expect(app.add(broken)).rejects.toThrow('Failed to resolve');
    expect(released).toEqual([]);

    await app.dispose();
    expect(released).toEqual(['shared', 'fresh']);
  });

  it('图变更等待进行中的解析, 并阻止同时进入的新解析', async () => {
    const gate = deferred<number>();
    const first = ripple({}, () => gate.promise);
    const second = ripple({}, () => 2);
    const app = new Cyrene({ ripples: { first } });
    const startup = app.start();
    const addition = app.add(second);

    await expect(app.resolve(second)).rejects.toBeInstanceOf(InvalidDependencyError);
    gate.resolve(1);
    await startup;
    expect(await addition).toBe(2);
    await app.dispose();
  });

  it('等待中的工厂仍可激活其 lazy 依赖', async () => {
    const gate = deferred<void>();
    const dependency = ripple({}, () => 1);

    const first = ripple({ dependency: lazy(() => dependency) }, async ({ dependency }) => {
      await gate.promise;
      return dependency.resolve();
    });

    const second = ripple({}, () => 2);
    const app = new Cyrene({ ripples: { first } });

    const startup = app.start();
    const addition = app.add(second);
    gate.resolve();

    await startup;
    expect(await addition).toBe(2);
    expect(await app.resolve(first)).toBe(1);
    await app.dispose();
  });

  it('override 在同一图中替换所有消费者, 立即释放并重建已初始化实例', async () => {
    const events: string[] = [];
    let generation = 0;

    const old = ripple({}, () => ({ name: 'old' }), {
      debugName: 'Old',
      dispose: () => {
        events.push('old');
      },
    });

    const replacement = ripple({}, () => ({ name: 'new' }), { debugName: 'New' });

    const a = ripple({ old }, ({ old }) => ({ old, generation: ++generation }), {
      debugName: 'A',
      dispose: () => {
        events.push('a');
      },
    });

    const b = ripple({ a }, ({ a }) => ({ a, generation: ++generation }), {
      debugName: 'B',
      dispose: () => {
        events.push('b');
      },
    });

    const c = ripple({ old }, ({ old }) => ({ old, generation: ++generation }), {
      debugName: 'C',
      dispose: () => {
        events.push('c');
      },
    });

    const app = new Cyrene({ ripples: { b, c } });

    await app.start();
    const beforeB = await app.resolve(b);
    const beforeC = await app.resolve(c);

    await app.override(old, replacement);

    const afterB = await app.resolve(b);
    const afterC = await app.resolve(c);
    expect(afterB).not.toBe(beforeB);
    expect(afterB.a).not.toBe(beforeB.a);
    expect(afterC).not.toBe(beforeC);
    expect(afterB.a.old).toBe(afterC.old);
    expect(afterB.a.old.name).toBe('new');
    expect(await app.resolve(old)).toBe(afterB.a.old);
    expect(events).toEqual(['c', 'b', 'a', 'old']);

    const graph = app.inspect();
    const oldNode = graph.nodes.find(node => node.name === 'Old')!;
    const newNode = graph.nodes.find(node => node.name === 'New')!;
    expect(graph.edges).toContainEqual({
      from: oldNode.id,
      to: newNode.id,
      kind: 'override',
    });
    expect(graph.edges.filter(edge => edge.to === oldNode.id)).toHaveLength(2);

    await app.dispose();
  });

  it('override 拒绝成环替换, 原图和实例保持不变', async () => {
    const old = ripple({}, () => ({ value: 1 }));
    const consumer = ripple({ old }, ({ old }) => old);
    const app = new Cyrene({ ripples: { consumer } });
    await app.start();
    const original = await app.resolve(consumer);
    const graph = app.inspect();

    await expect(app.override(old, consumer)).rejects.toThrow('Circular dependency');
    expect(await app.resolve(consumer)).toBe(original);
    expect(app.inspect()).toEqual(graph);
    await app.dispose();
  });

  it('override 保留旧定义的依赖, 只释放被替换的实例', async () => {
    const released: string[] = [];

    const leaf = ripple({}, () => ({}), {
      debugName: 'leaf',
      dispose: () => {
        released.push('leaf');
      },
    });

    const old = ripple({ leaf }, () => ({ value: 1 }), {
      dispose: () => {
        released.push('old');
      },
    });

    const fresh = ripple({}, () => ({ value: 2 }));
    const replacement = ripple({ fresh }, ({ fresh }) => fresh);
    const consumer = ripple({ old }, ({ old }) => old);
    const app = new Cyrene({ ripples: { consumer } });

    await app.start();
    await app.override(old, replacement);
    expect(released).toEqual(['old']);
    expect((await app.resolve(consumer)).value).toBe(2);
    expect(app.inspect().nodes.map(node => node.name)).toContain('leaf');
    await app.dispose();
    expect(released).toEqual(['old', 'leaf']);
  });

  it('override 不清理先前 remove 保留的无关依赖', async () => {
    const released: string[] = [];

    const retained = ripple({}, () => ({ value: 'retained' }), {
      dispose: () => {
        released.push('retained');
      },
    });

    const removedRoot = ripple({ retained }, ({ retained }) => retained.value);
    const old = ripple({}, () => ({ value: 'old' }));
    const replacement = ripple({}, () => ({ value: 'new' }));
    const consumer = ripple({ old }, ({ old }) => old.value);
    const app = new Cyrene({ ripples: { removedRoot, consumer } });

    await app.start();
    await app.remove(removedRoot);
    await app.override(old, replacement);

    expect(await app.resolve(consumer)).toBe('new');
    expect(released).toEqual([]);

    await app.prune(consumer);
    expect(released).toEqual([]);

    await app.dispose();
    expect(released).toEqual(['retained']);
  });
  it('remove 保留的孤立节点可见且可直接删除, 不需要重新解析', async () => {
    const dispose = vi.fn();
    const leaf = ripple(() => ({}), { debugName: 'Leaf', dispose });
    const root = ripple({ leaf }, () => ({}));
    const app = new Cyrene({ ripples: { root } });
    await app.start();
    await app.remove(root);
    expect(app.inspect().roots).toEqual([]);
    expect(app.inspect().nodes.map(node => node.name)).toEqual(['Leaf']);
    expect(formatGraph(app.inspect())).toContain('[retained]');
    await app.remove(leaf);
    expect(dispose).toHaveBeenCalledOnce();
    expect(app.inspect().nodes).toEqual([]);
    await app.dispose();
  });

  it('prune 清理整个 lazy 环, 包括作为目标的环内入口', async () => {
    for (const wrap of [false, true]) {
      const disposeA = vi.fn();
      const disposeB = vi.fn();
      const a = ripple({ b: lazy(() => b) }, values => values, { dispose: disposeA });
      const b: Dependency<object> = ripple({ a }, (): object => ({}), { dispose: disposeB });
      const target = wrap ? ripple({ a }, ({ a }) => a) : a;
      const app = new Cyrene({ ripples: { target } });
      await app.start();
      // 通过内部句柄激活 B, 不把 A 或 B 提升为外部入口
      const value = await app.resolve(target);
      const instanceA = value;
      await instanceA.b.resolve();
      await app.prune(target);
      expect(app.inspect().nodes).toEqual([]);
      expect(disposeA).toHaveBeenCalledOnce();
      expect(disposeB).toHaveBeenCalledOnce();
      await app.dispose();
    }
  });

  it('prune 保护环上的其他入口和闭包外消费者, 拒绝时不释放资源', async () => {
    for (const independentRoot of [false, true]) {
      const dispose = vi.fn();
      const a = ripple({ b: lazy(() => b) }, () => ({}), { dispose });
      const b: Dependency<object> = ripple({ a }, (): object => ({}));
      const other = independentRoot ? b : ripple({ b }, () => ({}));
      const app = new Cyrene({ ripples: { a, other } });
      await app.start();
      const graph = app.inspect();
      await expect(app.prune(a)).rejects.toBeInstanceOf(InvalidDependencyError);
      expect(app.inspect()).toEqual(graph);
      expect(dispose).not.toHaveBeenCalled();
      await app.dispose();
    }
  });

  it('override 重建入口时可调用保留服务的 lazy 句柄', async () => {
    const x = ripple(() => 10);
    const helper = ripple({ x: lazy(() => x) }, ({ x }) => ({ get: () => x.resolve() }));
    const old = ripple(() => 1);
    const replacement = ripple(() => 2);
    const root = ripple({ helper, old }, async ({ helper, old }) => (await helper.get()) + old);
    const app = new Cyrene({ ripples: { root } });
    await app.start();
    await app.override(old, replacement);
    expect(await app.resolve(root)).toBe(12);
    await app.dispose();
  });

  it('override 使已激活 lazy 分支失效, 但直到再次使用才重建', async () => {
    const factory = vi.fn(({ old }: { old: number }) => ({ old }));
    const dispose = vi.fn();
    const old = ripple(() => 1);
    const replacement = ripple(() => 2);
    const middle = ripple({ old }, factory, { dispose });
    const root = ripple({ middle: lazy(() => middle) }, values => values);
    const app = new Cyrene({ ripples: { root } });
    await app.start();
    const before = await app.resolve(root);
    expect(await before.middle.resolve()).toEqual({ old: 1 });
    await app.override(old, replacement);
    expect(factory).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    await expect(before.middle.resolve()).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(await (await app.resolve(root)).middle.resolve()).toEqual({ old: 2 });
    await app.dispose();
  });

  it('lazy 回调中的 Ref 在接入图后保持同一身份', async () => {
    const service = ripple((name: string) => ({ name }));
    const target = vi.fn(() => service('report'));
    const root = ripple({ service: lazy(target) }, values => values);
    const app = new Cyrene({ ripples: { root } });
    await app.start();
    const value = await app.resolve(root);
    expect(await value.service.resolve()).toEqual({ name: 'report' });
    expect(await value.service.resolve()).toBe(await value.service.resolve());
    expect(target).toHaveBeenCalledOnce();
    await app.dispose();
  });

  it('清理失败仍提交删除, 重建失败仍保留新替换图', async () => {
    const brokenDispose = ripple(() => ({}), {
      dispose: () => {
        throw new Error('cleanup');
      },
    });

    const old = ripple(() => 1);
    let fail = true;

    const replacement = ripple(() => {
      if (fail) {
        throw new Error('initialization');
      }

      return 2;
    });

    const root = ripple({ old }, ({ old }) => old);
    const app = new Cyrene({ ripples: { brokenDispose, root } });
    await app.start();
    await expect(app.remove(brokenDispose)).rejects.toBeInstanceOf(AggregateError);
    await expect(app.resolve(brokenDispose)).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.override(old, replacement)).rejects.toThrow('Failed to resolve');
    expect(app.inspect().edges.some(edge => edge.kind === 'override')).toBe(true);
    fail = false;
    expect(await app.resolve(root)).toBe(2);
    await app.dispose();
  });
  it('变更释放期间拒绝 lazy, 重建期间允许并等待存活句柄', async () => {
    const releaseEntered = deferred<void>();
    const releaseGate = deferred<void>();
    const rebuildEntered = deferred<void>();
    const rebuildGate = deferred<void>();
    const lazyEntered = deferred<void>();
    const lazyGate = deferred<number>();

    const x = ripple(() => {
      lazyEntered.resolve();
      return lazyGate.promise;
    });

    const helper = ripple({ x: lazy(() => x) }, values => values);

    const old = ripple(() => 1, {
      dispose: async () => {
        releaseEntered.resolve();
        await releaseGate.promise;
      },
    });

    const replacement = ripple(async () => {
      rebuildEntered.resolve();
      await rebuildGate.promise;
      return 2;
    });

    const root = ripple({ old }, ({ old }) => old);
    const app = new Cyrene({ ripples: { root, helper } });
    await app.start();
    const handle = (await app.resolve(helper)).x;
    const finished = vi.fn();
    const mutation = app.override(old, replacement).then(finished);
    await releaseEntered.promise;
    await expect(handle.resolve()).rejects.toBeInstanceOf(InvalidDependencyError);
    releaseGate.resolve();
    await rebuildEntered.promise;
    const pending = handle.resolve();
    await lazyEntered.promise;
    rebuildGate.resolve();
    await expect(app.resolve(root)).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.remove(helper)).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(finished).not.toHaveBeenCalled();
    lazyGate.resolve(10);
    expect(await pending).toBe(10);
    await mutation;
    expect(finished).toHaveBeenCalledOnce();
    expect(await app.resolve(root)).toBe(2);
    await app.dispose();
  });

  it('失败 add 保留现有服务在初始化期间激活的 lazy 资源', async () => {
    const dispose = vi.fn();
    const x = ripple(() => ({}), { dispose });
    const helper = ripple({ x: lazy(() => x) }, values => values);

    const broken = ripple({ helper }, async ({ helper }) => {
      await helper.x.resolve();
      throw new Error('broken');
    });

    const app = new Cyrene({ ripples: { helper } });
    await app.start();
    await expect(app.add(broken)).rejects.toThrow('Failed to resolve');
    expect(dispose).not.toHaveBeenCalled();
    await app.prune(helper);
    expect(dispose).toHaveBeenCalledOnce();
    await app.dispose();
  });

  it('共享对象阻止局部删除和替换, 验证失败保持原图', async () => {
    const shared = {};
    const dispose = vi.fn();
    const first = ripple(() => shared, { dispose });
    const second = ripple(() => shared, { dispose });
    const replacement = ripple(() => ({}));
    const app = new Cyrene({ ripples: { first, second } });
    await app.start();
    const graph = app.inspect();
    await expect(app.remove(first)).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.prune(first)).rejects.toBeInstanceOf(InvalidDependencyError);
    await expect(app.override(first, replacement)).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(app.inspect()).toEqual(graph);
    expect(dispose).not.toHaveBeenCalled();
    await app.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('override 按确切身份替换, 不重放 transient 的历史实例', async () => {
    const factory = vi.fn(() => ({ value: 1 }));
    const dispose = vi.fn();
    const old = ripple(factory, { lifetime: 'transient', dispose });
    const separate = old();
    const replacementFactory = vi.fn(() => ({ value: 2 }));
    const replacement = ripple(replacementFactory, { lifetime: 'transient' });
    const app = new Cyrene({ ripples: { old, separate } });
    await app.start();
    await app.resolve(old);
    await app.resolve(old);
    await app.override(old, replacement);
    expect(dispose).toHaveBeenCalledTimes(3);
    expect(replacementFactory).toHaveBeenCalledOnce();
    expect((await app.resolve(separate)).value).toBe(1);
    await app.dispose();
  });
});
