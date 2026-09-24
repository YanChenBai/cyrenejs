import { DEPENDENCY_BRAND, REF_BRAND, RIPPLE_BRAND } from './brands.ts';
import { InvalidDependencyError } from './errors.ts';
import { setDefinition } from './metadata.ts';
import type { Dependency, ResolveInputs, RippleOptions, ValidInputs } from './types.ts';

// 从完整工厂签名提取业务参数, 保留默认参数与 rest 参数的推导
type FactoryParams<F> = F extends (dependencies: never, ...params: infer P) => unknown ? P : never;

export function ripple<
  const T extends Record<PropertyKey, unknown> | readonly unknown[],
  F extends (dependencies: ResolveInputs<T>, ...params: never[]) => unknown,
>(
  inputs: T & ValidInputs<T>,
  factory: F,
  options?: RippleOptions<Awaited<ReturnType<F>>>,
): Dependency<Awaited<ReturnType<F>>, FactoryParams<F>>;
export function ripple<F extends (...params: never[]) => unknown>(
  factory: F,
  options?: RippleOptions<Awaited<ReturnType<F>>>,
): Dependency<Awaited<ReturnType<F>>, Parameters<F>>;

export function ripple(
  inputOrFactory:
    | Record<PropertyKey, unknown>
    | readonly unknown[]
    | ((...args: unknown[]) => unknown),
  factoryOrOptions?: ((...args: unknown[]) => unknown) | RippleOptions<unknown>,
  explicitOptions?: RippleOptions<unknown>,
): Dependency<unknown, unknown[]> {
  const isFactoryFirst = typeof inputOrFactory === 'function';
  const inputs = isFactoryFirst ? {} : inputOrFactory;
  const factory = isFactoryFirst ? inputOrFactory : factoryOrOptions;

  const options = (isFactoryFirst ? factoryOrOptions : explicitOptions) as
    | RippleOptions<unknown>
    | undefined;

  if (typeof factory !== 'function') {
    throw new InvalidDependencyError('Ripple factory must be a function');
  }

  if (isFactoryFirst && explicitOptions !== undefined) {
    throw new InvalidDependencyError('Factory-first ripple accepts at most two arguments');
  }

  const settings = options ?? {};

  if (settings.lifetime && settings.lifetime !== 'singleton' && settings.lifetime !== 'transient') {
    throw new InvalidDependencyError(`Unknown lifetime: ${String(settings.lifetime)}`);
  }

  // 每次调用都生成独立 Ref, 参数相同也不合并实例身份
  const dependency = (...params: unknown[]) =>
    Object.freeze({
      [REF_BRAND]: Object.freeze({}),
      dependency,
      params: Object.freeze([...params]),
    });

  Object.defineProperty(dependency, DEPENDENCY_BRAND, { value: Object.freeze({}) });
  Object.defineProperty(dependency, RIPPLE_BRAND, { value: true });
  setDefinition(dependency, {
    inputs: Object.freeze(
      Array.isArray(inputs) ? [...inputs] : { ...(inputs as Record<PropertyKey, unknown>) },
    ),
    invoke: (dependencies, params) => {
      if (isFactoryFirst) {
        return factory(...params);
      }

      return factory(dependencies, ...params);
    },
    options: Object.freeze({ ...settings }),
  });

  return Object.freeze(dependency) as unknown as Dependency<unknown, unknown[]>;
}

export function isRipple(value: unknown): value is Dependency<unknown, never[]> {
  return (
    typeof value === 'function' &&
    Object.hasOwn(value, RIPPLE_BRAND) &&
    Reflect.get(value, RIPPLE_BRAND) === true
  );
}
