import { defineDependency, isDependency } from './dependency.ts';
import { InvalidDependencyError } from './errors.ts';
import { RIPPLE_BRAND } from './symbols.ts';
import type { Dependency, FactoryAsync, ResolveInputs, RippleOptions } from './types.ts';
import { isFunction } from './utils.ts';

export function ripple<T>(
  factory: () => T,
  options?: RippleOptions,
): Dependency<Awaited<T>, {}, FactoryAsync<T>>;
export function ripple<const D extends Record<PropertyKey, unknown>, T>(
  deps: D,
  factory: (deps: ResolveInputs<D>) => T,
  options?: RippleOptions,
): Dependency<Awaited<T>, D, FactoryAsync<T, D>>;

/** 工厂只保存创建规则，声明不绑定任何容器的名称或实例。 */
export function ripple(
  depsOrFactory: Record<PropertyKey, unknown> | (() => unknown),
  factoryOrOptions?: ((deps: never) => unknown) | RippleOptions,
  configuration?: RippleOptions,
): Dependency {
  let inputs: Record<PropertyKey, unknown> = {};
  let factory: unknown = depsOrFactory;
  let options = factoryOrOptions as RippleOptions | undefined;

  if (!isFunction(depsOrFactory)) {
    inputs = depsOrFactory;
    factory = factoryOrOptions;
    options = configuration;
  }

  if (!isFunction(factory) || !inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    throw new InvalidDependencyError('ripple requires a factory and optional dependency inputs');
  }

  validateOptions(options ?? {});
  const declaration = Object.freeze({ [RIPPLE_BRAND]: Object.freeze({}) });

  let invoke = (values: Record<PropertyKey, unknown>): unknown =>
    Reflect.apply(factory, undefined, [values]);

  if (isFunction(depsOrFactory)) {
    invoke = () => Reflect.apply(factory, undefined, []);
  }

  defineDependency(declaration, {
    inputs: Object.freeze({ ...inputs }),
    invoke,
    options: Object.freeze({ ...options }),
  });

  return declaration;
}

function validateOptions(options: RippleOptions): void {
  if (options.lifetime !== undefined && !['singleton', 'transient'].includes(options.lifetime)) {
    throw new InvalidDependencyError('Unknown lifetime');
  }

  if (options.ownership !== undefined && !['owned', 'borrowed'].includes(options.ownership)) {
    throw new InvalidDependencyError('Unknown ownership');
  }

  if ('dispose' in options) {
    throw new InvalidDependencyError('Use Symbol.asyncDispose or Symbol.dispose on the instance');
  }
}

export function isRipple(value: unknown): value is Dependency {
  return isDependency(value);
}
