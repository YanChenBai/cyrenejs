import { dependencyBrand, refBrand } from './brands.ts';
import { InvalidDependencyError } from './errors.ts';
import { setDefinition } from './metadata.ts';
import type { Dependency, ResolveInputs, RippleOptions, ValidInputs } from './types.ts';

// 从完整工厂签名提取业务参数, 保留默认参数与 rest 参数的推导
type FactoryParams<F> = F extends (dependencies: never, ...params: infer P) => unknown ? P : never;

export function ripple<
  const T extends Record<PropertyKey, unknown>,
  F extends (dependencies: ResolveInputs<T>, ...params: never[]) => unknown,
>(
  inputs: T & ValidInputs<T>,
  factory: F,
  options: RippleOptions<Awaited<ReturnType<F>>> = {},
): Dependency<Awaited<ReturnType<F>>, FactoryParams<F>> {
  if (options.lifetime && options.lifetime !== 'singleton' && options.lifetime !== 'transient') {
    throw new InvalidDependencyError(`Unknown lifetime: ${String(options.lifetime)}`);
  }

  // 每次调用都生成独立 Ref, 参数相同也不合并实例身份
  const dependency = (...params: FactoryParams<F>) =>
    Object.freeze({
      [refBrand]: Object.freeze({}),
      dependency,
      params: Object.freeze([...params]),
    });

  Object.defineProperty(dependency, dependencyBrand, { value: Object.freeze({}) });
  setDefinition(dependency, {
    inputs: Object.freeze({ ...inputs }),
    invoke: (dependencies, params) =>
      factory(dependencies as ResolveInputs<T>, ...(params as never[])),
    options: Object.freeze({ ...options }) as RippleOptions<unknown>,
  });

  return Object.freeze(dependency) as unknown as Dependency<
    Awaited<ReturnType<F>>,
    FactoryParams<F>
  >;
}
