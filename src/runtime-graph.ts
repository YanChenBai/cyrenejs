import { assertResolvable, isDependency, isRef, targetName } from './dependency.ts';
import { CircularDependencyError, InvalidDependencyError } from './errors.ts';
import { getLazyTarget, isLazy } from './lazy.ts';
import { getDefinition } from './metadata.ts';
import type {
  DependencyGraph,
  DependencyIdentity,
  GraphEdge,
  GraphNode,
  Resolvable,
} from './types.ts';
import { entries } from './utils.ts';

type EdgeKind = 'dependency' | 'lazy' | 'override';

interface RuntimeNode {
  // consumer -> dependency; both indexes are updated together.
  incoming: Map<Resolvable, EdgeKind>;
  outgoing: Map<Resolvable, EdgeKind>;
  replacement?: Resolvable;
  lazyTargets: Map<object, Resolvable>;
}

export class RuntimeGraph {
  readonly nodes = new Map<Resolvable, RuntimeNode>();

  attach(target: Resolvable): void {
    const added = new Set<Resolvable>();

    try {
      this.#visit(target, added);
      this.#validateCycles();
    } catch (error) {
      this.detach(added);
      throw error;
    }
  }

  detach(targets: ReadonlySet<Resolvable>): void {
    for (const target of targets) {
      const node = this.nodes.get(target);

      if (!node) {
        continue;
      }

      for (const dependency of node.outgoing.keys()) {
        this.nodes.get(dependency)?.incoming.delete(target);
      }

      for (const consumer of node.incoming.keys()) {
        this.nodes.get(consumer)?.outgoing.delete(target);
      }

      this.nodes.delete(target);
    }
  }

  replacementOf(target: Resolvable): Resolvable | undefined {
    return this.nodes.get(target)?.replacement;
  }

  replace(target: Resolvable, replacement: Resolvable): void {
    const node = this.nodes.get(target);

    if (!node) {
      throw new InvalidDependencyError('Target is not attached');
    }

    if (target === replacement) {
      return;
    }

    const previous = new Map(node.outgoing);
    const previousReplacement = node.replacement;
    const existing = new Set(this.nodes.keys());

    this.attach(replacement);

    for (const dependency of node.outgoing.keys()) {
      this.nodes.get(dependency)!.incoming.delete(target);
    }

    node.outgoing.clear();
    node.outgoing.set(replacement, 'override');
    node.replacement = replacement;
    this.nodes.get(replacement)!.incoming.set(target, 'override');

    try {
      this.#validateCycles();
    } catch (error) {
      this.nodes.get(replacement)!.incoming.delete(target);
      node.outgoing.clear();
      node.replacement = previousReplacement;

      for (const [dependency, kind] of previous) {
        node.outgoing.set(dependency, kind);
        this.nodes.get(dependency)!.incoming.set(target, kind);
      }

      this.detach(new Set([...this.nodes.keys()].filter(item => !existing.has(item))));
      throw error;
    }
  }

  consumersOf(target: Resolvable): Set<Resolvable> {
    const consumers = new Set<Resolvable>();
    const queue = [target];

    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;

      if (consumers.has(current)) {
        continue;
      }

      consumers.add(current);

      for (const consumer of this.nodes.get(current)?.incoming.keys() ?? []) {
        queue.push(consumer);
      }
    }

    return consumers;
  }

  planRemoval(target: Resolvable, roots: ReadonlySet<Resolvable>, prune: boolean): Set<Resolvable> {
    const node = this.nodes.get(target);

    if (!node) {
      throw new InvalidDependencyError('Target is not attached');
    }

    if (!prune && node.incoming.size) {
      throw new InvalidDependencyError('Cannot remove a dependency with active consumers');
    }

    if (!prune) {
      return new Set([target]);
    }

    // 环内引用不构成保留理由, 只保护其他入口与闭包外消费者需要的节点
    const collect = (current: Resolvable, selected: Set<Resolvable>) => {
      if (selected.has(current)) {
        return;
      }

      selected.add(current);

      for (const dependency of this.nodes.get(current)!.outgoing.keys()) {
        collect(dependency, selected);
      }
    };

    const candidates = new Set<Resolvable>();
    collect(target, candidates);
    const retained = new Set<Resolvable>();

    for (const current of candidates) {
      const protectedRoot = current !== target && roots.has(current);

      const externalConsumer = [...this.nodes.get(current)!.incoming.keys()].some(
        consumer => !candidates.has(consumer),
      );

      if (protectedRoot || externalConsumer) {
        collect(current, retained);
      }
    }

    if (retained.has(target)) {
      throw new InvalidDependencyError('Cannot prune a dependency with retained consumers');
    }

    return new Set([...candidates].filter(current => !retained.has(current)));
  }

  lazyTargetOf(owner: Resolvable, reference: object): Resolvable {
    const target = this.nodes.get(owner)?.lazyTargets.get(reference);

    if (!target) {
      throw new InvalidDependencyError('Lazy target is not attached');
    }

    return target;
  }

  snapshot(roots: readonly Resolvable[], includeRetained = false): DependencyGraph {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const identities = new Map<object, number>();
    const visited = new Set<Resolvable>();

    const identify = (target: Resolvable | DependencyIdentity): number => {
      const existing = identities.get(target);

      if (existing !== undefined) {
        return existing;
      }

      const id = nodes.length;
      identities.set(target, id);
      const definition = getDefinition(isRef(target) ? target.dependency : target);

      const node: GraphNode = {
        id,
        name: targetName(target),
        kind: isRef(target) ? 'ref' : 'dependency',
        lifetime: definition.options.lifetime ?? 'singleton',
      };

      if (isRef(target)) {
        node.params = target.params;
      }

      nodes.push(node);
      return id;
    };

    const visit = (target: Resolvable): number => {
      const id = identify(target);

      if (visited.has(target)) {
        return id;
      }

      visited.add(target);

      if (isRef(target)) {
        edges.push({ from: id, to: identify(target.dependency), kind: 'definition' });
      }

      for (const [dependency, kind] of this.nodes.get(target)?.outgoing ?? []) {
        edges.push({ from: id, to: visit(dependency), kind });
      }

      return id;
    };

    const rootIds = [...new Set(roots.map(visit))];

    if (includeRetained) {
      const reachable = new Set(visited);

      for (const target of this.nodes.keys()) {
        const id = visit(target);

        if (!reachable.has(target)) {
          nodes[id]!.retained = true;
        }
      }
    }

    return { roots: rootIds, nodes, edges };
  }

  #visit(target: Resolvable, added: Set<Resolvable>): void {
    assertResolvable(target);

    if (this.nodes.has(target)) {
      return;
    }

    const node: RuntimeNode = { incoming: new Map(), outgoing: new Map(), lazyTargets: new Map() };
    this.nodes.set(target, node);
    added.add(target);
    const definition = getDefinition(isRef(target) ? target.dependency : target);

    for (const [, input] of entries(definition.inputs)) {
      let dependency: Resolvable;
      let kind: EdgeKind;

      if (isLazy(input)) {
        dependency = getLazyTarget(input);
        node.lazyTargets.set(input, dependency);
        kind = 'lazy';
      } else if (isDependency(input) || isRef(input)) {
        assertResolvable(input);
        dependency = input;
        kind = 'dependency';
      } else {
        continue;
      }

      this.#visit(dependency, added);
      // 同一对节点若同时存在 lazy 与强依赖, 强依赖决定初始化环语义。
      const edgeKind = node.outgoing.get(dependency) === 'dependency' ? 'dependency' : kind;
      node.outgoing.set(dependency, edgeKind);
      this.nodes.get(dependency)!.incoming.set(target, edgeKind);
    }
  }

  #validateCycles(): void {
    const visited = new Set<Resolvable>();
    const active = new Set<Resolvable>();

    const check = (target: Resolvable, path: string[]): void => {
      if (active.has(target)) {
        throw new CircularDependencyError(
          `Circular dependency: ${[...path, targetName(target)].join(' -> ')}`,
        );
      }

      if (visited.has(target)) {
        return;
      }

      active.add(target);

      for (const [dependency, kind] of this.nodes.get(target)!.outgoing) {
        if (kind !== 'lazy') {
          check(dependency, [...path, targetName(target)]);
        }
      }

      active.delete(target);
      visited.add(target);
    };

    for (const target of this.nodes.keys()) {
      check(target, []);
    }
  }
}
