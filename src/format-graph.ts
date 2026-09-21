import type { DependencyGraph, GraphEdge } from './types.ts';

export function formatGraph(graph: DependencyGraph): string {
  if (graph.nodes.length === 0) {
    return '(empty graph)';
  }

  const nodes = new Map(graph.nodes.map(node => [node.id, node]));
  const adjacency = new Map<number, GraphEdge[]>();

  for (const edge of graph.edges) {
    const children = adjacency.get(edge.from) ?? [];
    children.push(edge);
    adjacency.set(edge.from, children);
  }

  const lines: string[] = [];
  const expanded = new Set<number>();
  const active = new Set<number>();

  function visit(id: number, prefix: string, connector: string, kind?: GraphEdge['kind']): void {
    const node = nodes.get(id);

    if (!node) {
      throw new Error(`Unknown graph node: ${id}`);
    }

    const labels: string[] = [];

    if (node.kind !== 'dependency') {
      labels.push(node.kind);
    }

    if (kind && kind !== 'dependency') {
      labels.push(kind);
    }

    let marker = '';

    if (active.has(id)) {
      marker = '↻ ';
    } else if (expanded.has(id)) {
      marker = '↗ ';
    }

    const name = node.name.replace(/[\r\n\t]/g, ' ');
    const suffix = labels.length ? ` [${labels.join(', ')}]` : '';
    lines.push(`${prefix}${connector}${marker}${name} #${id}${suffix}`);

    // 定义关系仅提供说明, 不沿它展开输入或标记节点已展开
    if (marker || kind === 'definition') {
      return;
    }

    expanded.add(id);
    active.add(id);
    const children = adjacency.get(id) ?? [];
    const indentation: Record<string, string> = { '': '', '└─ ': '   ', '├─ ': '│  ' };
    const childPrefix = prefix + indentation[connector];

    children.forEach((edge, index) => {
      visit(edge.to, childPrefix, index === children.length - 1 ? '└─ ' : '├─ ', edge.kind);
    });

    active.delete(id);
  }

  for (const id of graph.roots) {
    if (lines.length) {
      lines.push('');
    }

    visit(id, '', '');
  }

  return lines.join('\n');
}
