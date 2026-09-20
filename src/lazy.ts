import { lazyBrand } from './brands.ts';
import { setLazyTarget } from './metadata.ts';
import type { LazyRef, Resolvable } from './types.ts';

export function lazy<T>(getTarget: () => Resolvable<T>): LazyRef<T> {
  const reference = Object.freeze({ [lazyBrand]: Object.freeze({}) });
  setLazyTarget(reference, getTarget);
  return reference;
}
