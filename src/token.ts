import { tokenBrand } from './brands.ts';
import type { Token } from './types.ts';

export function token<T>(name: string): Token<T> {
  return Object.freeze({ [tokenBrand]: Object.freeze({}), name });
}
