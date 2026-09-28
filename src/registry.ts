import { assertDependency, getDefinition, isDependency } from './dependency.ts';
import { CircularDependencyError, InvalidDependencyError } from './errors.ts';
import { getLazyTarget, isLazy } from './lazy.ts';
import type { Dependency, GraphEdge } from './types.ts';
import { inputEntries } from './utils.ts';

export interface Registration {
  original: Dependency;
  implementation: Dependency;
}

export interface CompiledRegistration extends Registration {
  dependencies: Map<PropertyKey, GraphEdge>;
}

export type Registry = Map<string, CompiledRegistration>;

/** 原始声明和当前替身都定位同一个 key，让消费者无需改写依赖。 */
export function compileRegistry(registrations: ReadonlyMap<string, Registration>): Registry {
  const identities = new Map<Dependency, string>();
  const registry: Registry = new Map();

  for (const [key, { original, implementation }] of registrations) {
    registerIdentity(identities, original, key);
    registerIdentity(identities, implementation, key);
    // 新邻接只写入副本，校验失败不能影响已发布注册表。
    registry.set(key, { original, implementation, dependencies: new Map() });
  }

  for (const [key, registration] of registry) {
    connectDependencies(identities, key, registration);
  }

  validateRegistry(registry);

  return registry;
}

function registerIdentity(identities: Map<Dependency, string>, target: Dependency, key: string) {
  assertDependency(target);
  const existing = identities.get(target);

  if (existing !== undefined && existing !== key) {
    throw new InvalidDependencyError(`Ripple registered more than once: ${existing}, ${key}`);
  }

  identities.set(target, key);
}

function connectDependencies(
  identities: Map<Dependency, string>,
  key: string,
  registration: CompiledRegistration,
): void {
  const definition = getDefinition(registration.implementation);

  for (const [input, value] of inputEntries(definition.inputs)) {
    const deferred = isLazy(value);
    const target = deferred ? getLazyTarget(value) : value;

    if (!isDependency(target)) {
      continue;
    }

    const dependencyKey = identities.get(target);

    if (dependencyKey === undefined) {
      throw new InvalidDependencyError(`Unregistered dependency: ${key}.${String(input)}`);
    }

    registration.dependencies.set(input, {
      from: key,
      to: dependencyKey,
      input,
      kind: deferred ? 'lazy' : 'dependency',
    });
  }
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
