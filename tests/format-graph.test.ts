import { expect, it, vi } from 'vite-plus/test';

import { Cyrene, formatGraph, lazy, ripple } from '../src/index.ts';
import type { Dependency, Lazy } from '../src/index.ts';

it('绘制命名节点、共享依赖和仍作为入口的子节点', () => {
  const Config = ripple({}, () => 'secret', { debugName: 'Config' });
  const factory = vi.fn(() => ({}));
  const database = ripple({ config: Config }, factory, { debugName: 'Database' });
  const users = ripple({ database }, factory, { debugName: 'Users' });

  const app = new Cyrene({
    ripples: { users, database },
  });

  const graph = app.inspect();
  expect(graph.roots).toEqual([0, 1]);
  expect(formatGraph(graph)).toBe('Users #0\n└─ Database #1\n   └─ Config #2\n\n↗ Database #1');
  expect(factory).not.toHaveBeenCalled();
  expect(app.inspect(database).roots).toEqual([0]);
});

it('标记 lazy 循环, 不执行工厂', () => {
  const a: Dependency<{ b: Lazy<number> }> = ripple({ b: lazy(() => b) }, ({ b }) => ({ b }), {
    debugName: 'A',
  });

  const b = ripple({ a }, () => 1, { debugName: 'B' });
  expect(formatGraph(new Cyrene({ ripples: { a } }).inspect())).toBe(
    'A #0\n└─ B #1 [lazy]\n   └─ ↻ A #0',
  );
});

it('Ref 定义关系不抢先展开直接入口, 不输出参数', () => {
  const dependency = ripple({}, () => 1, { debugName: 'Value' });
  const ref = dependency();
  const graph = new Cyrene({ ripples: { ref, dependency } }).inspect();
  expect(formatGraph(graph)).toBe('Value(ref) #0 [ref]\n└─ Value #1 [definition]\n\nValue #1');
  const parameterized = ripple({}, (_deps, secret: string) => secret, { debugName: 'Secret' });
  const secretGraph = new Cyrene().inspect(parameterized('password'));
  expect(formatGraph(secretGraph)).not.toContain('password');
});

it('空图和重复入口有确定输出', () => {
  expect(formatGraph(new Cyrene().inspect())).toBe('(empty graph)');
  const service = ripple({}, () => 1, { debugName: 'Service' });
  const graph = new Cyrene({ ripples: { first: service, second: service } }).inspect();
  expect(graph.roots).toEqual([0]);
  expect(formatGraph(graph)).toBe('Service #0');
});

it('作为 Ref 定义显示过的保留节点仍展开其运行依赖', async () => {
  const leaf = ripple(() => 1, { debugName: 'Leaf' });
  const service = ripple({ leaf }, () => 1, { debugName: 'Service' });
  const ref = service();
  const root = ripple({ service }, () => 1);
  const app = new Cyrene({ ripples: { ref, root } });
  await app.start();
  await app.remove(root);
  const graph = app.inspect();
  expect(graph.nodes.find(node => node.name === 'Service')?.retained).toBe(true);
  expect(formatGraph(graph)).toContain('[retained]');
  expect(formatGraph(graph)).toContain('Service #');
  expect(formatGraph(graph)).toContain('↗ Leaf');
  await app.dispose();
});
