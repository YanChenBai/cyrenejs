import { LAZY_BRAND } from './brands.ts';
import { assertResolvable } from './dependency.ts';
import { InvalidDependencyError } from './errors.ts';
import type { LazyRef, Resolvable } from './types.ts';
import { isObject } from './utils.ts';

const lazyTargets = new WeakMap<object, () => Resolvable>();

export function lazy<T>(getTarget: () => Resolvable<T>): LazyRef<T> {
  const reference = Object.freeze({ [LAZY_BRAND]: Object.freeze({}) });
  lazyTargets.set(reference, getTarget);
  return reference;
}

export function isLazy(value: unknown): value is LazyRef {
  return isObject(value) && Object.hasOwn(value, LAZY_BRAND);
}

export function getLazyTarget(target: object): Resolvable {
  const getTarget = lazyTargets.get(target);

  if (!getTarget) {
    throw new InvalidDependencyError('Unknown lazy reference');
  }

  const value = getTarget();
  assertResolvable(value);
  return value;
}
