import type { DependencyGraph, GraphEdge } from './types.ts';

/** 将诊断快照格式化为终端树形文本；共享节点与循环显示引用标记，不重复展开。 */
export function formatGraph(graph: DependencyGraph): string {
  if (graph.nodes.length === 0) {
    return '(empty graph)';
  }

  const nodes = new Map(graph.nodes.map(node => [node.key, node]));
  const adjacency = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    const children = adjacency.get(edge.from) ?? [];
    children.push(edge);
    adjacency.set(edge.from, children);
  }

  const lines: string[] = [];
  const expanded = new Set<string>();
  const active = new Set<string>();

  /** 渲染一条节点引用及其子边；前缀携带祖先缩进，active 区分循环与普通共享。 */
  function visit(id: string, prefix: string, connector: string, kind?: GraphEdge['kind']): void {
    const node = nodes.get(id);

    if (!node) {
      throw new Error(`Unknown graph node: ${id}`);
    }

    let marker = '';

    if (active.has(id)) {
      marker = '↻ ';
    } else if (expanded.has(id)) {
      marker = '↗ ';
    }

    const name = sanitizeKey(node.key);
    const suffix = kind === 'lazy' ? ' [lazy]' : '';
    lines.push(`${prefix}${connector}${marker}${name}${suffix}`);

    // 共享节点与延迟环只展示引用标记，避免重复展开。
    if (marker) {
      return;
    }

    expanded.add(id);
    active.add(id);
    const children = adjacency.get(id) ?? [];
    const indentation: Record<string, string> = { '': '', '└─ ': '   ', '├─ ': '│  ' };
    const childPrefix = prefix + indentation[connector];

    children.forEach((edge, index) => {
      let connector = '├─ ';

      if (index === children.length - 1) {
        connector = '└─ ';
      }

      visit(edge.to, childPrefix, connector, edge.kind);
    });

    active.delete(id);
  }

  for (const id of graph.roots) {
    if (lines.length) {
      lines.push('');
    }

    visit(id, '', '');
  }

  // 兼容 roots 仅包含部分节点的外部诊断快照。
  for (const node of graph.nodes) {
    if (expanded.has(node.key)) {
      continue;
    }

    if (lines.length) {
      lines.push('');
    }

    visit(node.key, '', '');
  }

  return lines.join('\n');
}

/** 清除终端序列及剩余控制字符，避免节点名称改变终端状态。 */
function sanitizeKey(key: string): string {
  // 有意匹配终端控制码；OSC 等字符串序列连同标题、链接等负载一起移除。
  /* oxlint-disable no-control-regex */
  const strings =
    /(?:\u001B[P\]X^_]|[\u0090\u0098\u009D-\u009F])[\s\S]*?(?:\u0007|\u001B\\|\u009C|$)/g;

  const sequences = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]|\u001B[ -/]*[0-~]/g;
  /* oxlint-enable no-control-regex */

  return key
    .replace(strings, '')
    .replace(sequences, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\p{Cc}/gu, '');
}
