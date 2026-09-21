import { RIPPLES_SYMBOL } from './brands.ts';
import { assertRipples } from './metadata.ts';
import type { DependencyEntries, Ripples, ValidRipples } from './types.ts';

export function defineRipples<const T extends DependencyEntries>(
  ripples: T & ValidRipples<T>,
): Ripples<T> {
  assertRipples(ripples);
  Object.defineProperty(ripples, RIPPLES_SYMBOL, { value: true });

  return ripples as unknown as Ripples<T>;
}

export function isRipples(value: unknown): value is Ripples {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, RIPPLES_SYMBOL) &&
    Reflect.get(value, RIPPLES_SYMBOL) === true
  );
}
