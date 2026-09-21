import { RIPPLES_SYMBOL } from './brands.ts';
import { assertRipples } from './metadata.ts';
import type { DependencyEntries, Ripples, RipplesBrand, ValidRipples } from './types.ts';

// 展开时移除旧 brand, 用可命名类型重新附加, 避免声明生成泄漏私有 Symbol。
export function defineRipples<const T extends DependencyEntries>(
  ripples: T & ValidRipples<T>,
): { [K in keyof T as K extends string ? K : never]: T[K] } & RipplesBrand {
  assertRipples(ripples);
  Object.defineProperty(ripples, RIPPLES_SYMBOL, { value: true });

  return ripples as unknown as ReturnType<typeof defineRipples<T>>;
}

export function isRipples(value: unknown): value is Ripples {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, RIPPLES_SYMBOL) &&
    Reflect.get(value, RIPPLES_SYMBOL) === true
  );
}
