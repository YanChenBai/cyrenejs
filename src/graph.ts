import { CircularDependencyError, MissingBindingError } from './errors.ts';
import {
  assertResolvable,
  entries,
  getDefinition,
  getLazyTarget,
  isDependency,
  isLazy,
  isRef,
  isToken,
  targetName,
} from './metadata.ts';
import type {
  Binding,
  DependencyGraph,
  DependencyIdentity,
  GraphEdge,
  GraphNode,
  Resolvable,
  Token,
} from './types.ts';

export function getBinding(
  bindings: ReadonlyMap<Token, Binding>,
  token: Token,
  path: readonly string[],
): Binding {
  const binding = bindings.get(token);

  if (!binding) {
    throw new MissingBindingError(`Missing binding: ${[...path, token.name].join(' -> ')}`);
  }

  return binding;
}

export function inspectGraph(
  targets: readonly Resolvable[],
  bindings: ReadonlyMap<Token, Binding>,
): DependencyGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const identities = new Map<object, number>();
  // Ref 的定义节点只提供说明, 被识别为节点不代表其输入已经展开
  const expanded = new Set<object>();

  function identify(target: Resolvable | DependencyIdentity): number {
    const existing = identities.get(target);

    if (existing !== undefined) {
      return existing;
    }

    const id = nodes.length;
    identities.set(target, id);

    const node: GraphNode = {
      id,
      name: targetName(target),
      kind: 'dependency',
    };

    if (isToken(target)) {
      node.kind = 'token';
    } else if (isRef(target)) {
      node.kind = 'ref';
    }

    if (!isToken(target)) {
      node.lifetime =
        getDefinition(isRef(target) ? target.dependency : target).options.lifetime ?? 'singleton';
    }

    if (isRef(target)) {
      node.params = target.params;
    }

    nodes.push(node);
    return id;
  }

  function visit(target: Resolvable, path: readonly string[]): number {
    assertResolvable(target);
    const id = identify(target);

    if (expanded.has(target)) {
      return id;
    }

    expanded.add(target);
    const nextPath = [...path, targetName(target)];

    if (isToken(target)) {
      const binding = getBinding(bindings, target, path);

      if ('dependency' in binding) {
        assertResolvable(binding.dependency);
        edges.push({
          from: id,
          to: visit(binding.dependency, nextPath),
          kind: 'dependency',
        });
      }

      return id;
    }

    const definition = getDefinition(isRef(target) ? target.dependency : target);

    if (isRef(target)) {
      edges.push({ from: id, to: identify(target.dependency), kind: 'definition' });
    }

    for (const [, input] of entries(definition.inputs)) {
      if (isLazy(input)) {
        edges.push({ from: id, to: visit(getLazyTarget(input), nextPath), kind: 'lazy' });
      } else if (isDependency(input) || isRef(input) || isToken(input)) {
        assertResolvable(input);
        edges.push({ from: id, to: visit(input, nextPath), kind: 'dependency' });
      }
    }

    return id;
  }

  for (const target of targets) {
    visit(target, []);
  }

  const adjacency = new Map<number, number[]>();

  // 延迟边仍参与图校验, 但只有强依赖边参与初始化环检测
  for (const edge of edges) {
    if (edge.kind !== 'dependency') {
      continue;
    }

    const children = adjacency.get(edge.from) ?? [];
    children.push(edge.to);
    adjacency.set(edge.from, children);
  }

  const visited = new Set<number>();
  // 区分已完成节点与当前递归路径, 共享依赖不会被误判为循环
  const active = new Set<number>();

  function check(id: number, path: string[]): void {
    if (active.has(id)) {
      throw new CircularDependencyError(
        `Circular dependency: ${[...path, nodes[id]!.name].join(' -> ')}`,
      );
    }

    if (visited.has(id)) {
      return;
    }

    active.add(id);

    for (const child of adjacency.get(id) ?? []) {
      check(child, [...path, nodes[id]!.name]);
    }

    active.delete(id);
    visited.add(id);
  }

  for (const node of nodes) {
    check(node.id, []);
  }

  return { nodes, edges };
}
