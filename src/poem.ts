import { POEM_BRAND } from './brands.ts';
import { isDependency } from './dependency.ts';
import { InvalidDependencyError } from './errors.ts';
import type { Poem, PoemBrand, Resolvable, ValidRipples } from './types.ts';
import { assertRipples } from './validation.ts';

export function poem<const T extends Record<string, Resolvable>>(
  ripples: T & ValidRipples<T>,
): { [K in keyof T as K extends string ? K : never]: T[K] } & PoemBrand;
export function poem<const T extends Record<string, Resolvable>>(
  create: () => T & ValidRipples<T>,
): { [K in keyof T as K extends string ? K : never]: T[K] } & PoemBrand;

export function poem(input: Record<string, Resolvable> | (() => Record<string, Resolvable>)): Poem {
  if (arguments.length !== 1) {
    throw new InvalidDependencyError('poem() requires one object or object factory');
  }

  if (isDependency(input)) {
    throw new InvalidDependencyError('Poem entries must be an object');
  }

  // 构图函数同步执行一次; 数组入口仍可直接交给 Cyrene, 但不是 Poem。
  const ripples = typeof input === 'function' ? input() : input;

  if (Array.isArray(ripples)) {
    throw new InvalidDependencyError('Poem entries must be an object');
  }

  assertRipples(ripples);
  Object.defineProperty(ripples, POEM_BRAND, { value: true });

  return ripples as Poem;
}

export function isPoem(value: unknown): value is Poem {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, POEM_BRAND) &&
    Reflect.get(value, POEM_BRAND) === true
  );
}
