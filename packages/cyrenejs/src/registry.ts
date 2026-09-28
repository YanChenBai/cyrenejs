import { assertDependency, getDefinition, isDependency } from './dependency.ts';
import { CircularDependencyError, InvalidDependencyError } from './errors.ts';
import { getLazyTarget, isLazy } from './lazy.ts';
import type { Dependency, GraphEdge } from './types.ts';
import { inputEntries } from './utils.ts';

export interface CompiledRegistration {
  original: Dependency;
  implementation: Dependency;
  dependencies: Map<PropertyKey, GraphEdge>;
}

export type Registry = Map<string, CompiledRegistration>;

/** 先收集有效实现的闭包，再检查强依赖环；只发布完整且合法的快照。 */
export function compileRegistry(
  roots: Iterable<Dependency>,
  overrides: ReadonlyMap<Dependency, Dependency>,
): { registry: Registry; identities: Map<Dependency, string> } {
  const registry: Registry = new Map();
  const identities = new Map<Dependency, string>();
  const reachable = new Set<Dependency>();

  const visit = (original: Dependency): string => {
    assertDependency(original);
    const key = original.key;
    const existing = registry.get(key);

    if (existing) {
      if (existing.original !== original) {
        throw new InvalidDependencyError(`Duplicate Ripple key: ${key}`);
      }

      return key;
    }

    const implementation = overrides.get(original) ?? original;

    const registration: CompiledRegistration = {
      original,
      implementation,
      dependencies: new Map(),
    };

    registry.set(key, registration);
    reachable.add(original);
    registerIdentity(identities, original, key);
    registerIdentity(identities, implementation, key);

    for (const [input, value] of inputEntries(getDefinition(implementation).inputs)) {
      const deferred = isLazy(value);
      const target = deferred ? getLazyTarget(value) : value;

      if (isDependency(target)) {
        registration.dependencies.set(input, {
          from: key,
          to: visit(target),
          input,
          kind: deferred ? 'lazy' : 'dependency',
        });
      }
    }

    return key;
  };

  for (const root of roots) {
    visit(root);
  }

  for (const target of overrides.keys()) {
    if (!reachable.has(target)) {
      throw new InvalidDependencyError(`Override target is not reachable: ${target.key}`);
    }
  }

  validateRegistry(registry);

  return { registry, identities };
}

/** 一个声明不能同时代表两个槽位，替身也遵循这个约束。 */
function registerIdentity(identities: Map<Dependency, string>, target: Dependency, key: string) {
  const existing = identities.get(target);

  if (existing !== undefined && existing !== key) {
    throw new InvalidDependencyError(`Ripple occupies multiple keys: ${existing}, ${key}`);
  }

  identities.set(target, key);
}

/** 构图只检查强依赖环；lazy 的真实等待环在解析时检查。 */
function validateRegistry(registry: Registry): void {
  const visited = new Set<string>();
  const active = new Set<string>();

  const path: string[] = [];

  const visit = (key: string) => {
    if (active.has(key)) {
      throw new CircularDependencyError(`Circular dependency: ${[...path, key].join(' -> ')}`);
    }

    if (visited.has(key)) {
      return;
    }

    active.add(key);
    path.push(key);

    for (const edge of registry.get(key)!.dependencies.values()) {
      if (edge.kind === 'dependency') {
        visit(edge.to);
      }
    }

    path.pop();
    active.delete(key);
    visited.add(key);
  };

  for (const key of registry.keys()) {
    visit(key);
  }
}
