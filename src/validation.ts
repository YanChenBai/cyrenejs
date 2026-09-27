import { assertDependency } from './dependency.ts';
import { InvalidDependencyError } from './errors.ts';
import type { DependencyEntries } from './types.ts';
import { isFunction, isObject } from './utils.ts';

/** 校验入口容器与顶层声明身份，不执行工厂，也不遍历依赖闭包。 */
export function assertEntries(value: unknown): asserts value is DependencyEntries {
  const hasInvalidContainer = !isObject(value) || isFunction(value) || Array.isArray(value);

  if (hasInvalidContainer) {
    throw new InvalidDependencyError('Ripple entries must be an object');
  }

  for (const key of Reflect.ownKeys(value)) {
    const isEnumerable = Object.prototype.propertyIsEnumerable.call(value, key);

    if (typeof key !== 'string' || !isEnumerable) {
      throw new InvalidDependencyError('Ripple entries must have enumerable string keys');
    }

    assertDependency(Reflect.get(value, key));
  }
}
