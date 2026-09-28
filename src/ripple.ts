import { defineDependency, isDependency } from './dependency.ts';
import { InvalidDependencyError } from './errors.ts';
import { RIPPLE_BRAND } from './symbols.ts';
import type { Dependency, FactoryAsync, ResolveInputs, RippleOptions } from './types.ts';
import { isFunction } from './utils.ts';

export function ripple<const K extends string, T>(
  key: K,
  factory: () => T,
  options?: RippleOptions,
): Dependency<Awaited<T>, {}, FactoryAsync<T>, K>;
export function ripple<const K extends string, const D extends Record<PropertyKey, unknown>, T>(
  key: K,
  deps: D,
  factory: (deps: ResolveInputs<D>) => T,
  options?: RippleOptions,
): Dependency<Awaited<T>, D, FactoryAsync<T, D>, K>;

/** 声明保存 key 与创建规则，不绑定任何容器或实例。 */
export function ripple(
  key: string,
  depsOrFactory: Record<PropertyKey, unknown> | (() => unknown),
  factoryOrOptions?: ((deps: never) => unknown) | RippleOptions,
  configuration?: RippleOptions,
): Dependency {
  if (typeof key !== 'string' || key.length === 0) {
    throw new InvalidDependencyError('Ripple key must be a non-empty string');
  }

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
  const declaration = Object.freeze({ key, [RIPPLE_BRAND]: Object.freeze({}) });

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
