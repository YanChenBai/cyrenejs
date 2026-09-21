import { RIPPLE_PROVIDERS_SYMBOL } from './brands.ts';
import { assertProviders } from './metadata.ts';
import type { DependencyEntries, RippleProviders, ValidProviders } from './types.ts';

export function defineProviders<const T extends DependencyEntries>(
  providers: T & ValidProviders<T>,
): RippleProviders<T> {
  assertProviders(providers);
  Object.defineProperty(providers, RIPPLE_PROVIDERS_SYMBOL, { value: true });

  return providers as unknown as RippleProviders<T>;
}

export function isRippleProviders(value: unknown): value is RippleProviders {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, RIPPLE_PROVIDERS_SYMBOL) &&
    Reflect.get(value, RIPPLE_PROVIDERS_SYMBOL) === true
  );
}
