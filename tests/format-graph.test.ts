import { expect, it } from 'vite-plus/test';

import { Cyrene, formatGraph, lazy, ripple } from '../src/index.ts';

it('诊断使用容器 key，保留依赖属性、lazy 边与初始化状态', async () => {
  const database = ripple('database', () => ({}));
  const root = ripple('root', { database, later: lazy(() => database) }, deps => deps);
  const app = new Cyrene().use(root, database);
  expect(app.inspect().nodes).toEqual([
    { key: 'root', state: 'registered' },
    { key: 'database', state: 'registered' },
  ]);
  expect(app.inspect().edges).toEqual([
    { from: 'root', to: 'database', input: 'database', kind: 'dependency' },
    { from: 'root', to: 'database', input: 'later', kind: 'lazy' },
  ]);
  expect(app.inspect().nodes.every(node => node.state === 'registered')).toBe(true);
  app.resolve('root');
  expect(app.inspect().nodes.every(node => node.state === 'ready')).toBe(true);
  expect(formatGraph(app.inspect())).toContain('[lazy]');
  expect(formatGraph(app.inspect())).toContain('↗');
  await app.dispose();
  expect(formatGraph(app.inspect())).toBe('(empty graph)');
});

it('修改诊断快照不影响解析图', async () => {
  const dependency = ripple('dependency', () => 42);
  const root = ripple('root', { dependency }, deps => deps);
  const app = new Cyrene().use(root, dependency);
  const snapshot = app.inspect();
  snapshot.edges[0]!.to = 'unknown';
  snapshot.nodes.length = 0;
  expect(app.resolve('root')).toEqual({ dependency: 42 });
  await app.dispose();
});

it('格式化单个 key、lazy 环和特殊字符，不再重复显示名称和 ID', () => {
  expect(
    formatGraph({
      roots: ['service\nname'],
      nodes: [{ key: 'service\nname', state: 'registered' }],
      edges: [{ from: 'service\nname', to: 'service\nname', input: 'self', kind: 'lazy' }],
    }),
  ).toBe('service name\n└─ ↻ service name [lazy]');
});
