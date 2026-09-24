import { DEPENDENCY_BRAND, REF_BRAND } from './brands.ts';
import { InvalidDependencyError } from './errors.ts';
import { getDefinition } from './metadata.ts';
import type { DependencyIdentity, DependencyRef, Resolvable } from './types.ts';
import { isObject } from './utils.ts';

export function isDependency(value: unknown): value is DependencyIdentity {
  return isObject(value) && Object.hasOwn(value, DEPENDENCY_BRAND);
}

export function isRef(value: unknown): value is DependencyRef {
  return isObject(value) && Object.hasOwn(value, REF_BRAND);
}

export function assertResolvable(value: unknown): asserts value is Resolvable {
  if (isDependency(value)) {
    getDefinition(value);
    return;
  }

  if (isRef(value) && isDependency(value.dependency) && Array.isArray(value.params)) {
    getDefinition(value.dependency);
    return;
  }

  throw new InvalidDependencyError('Expected a Dependency or DependencyRef');
}

export function targetName(target: Resolvable | DependencyIdentity): string {
  const definition = getDefinition(isRef(target) ? target.dependency : target);
  return `${definition.options.debugName ?? 'Dependency'}${isRef(target) ? '(ref)' : ''}`;
}
