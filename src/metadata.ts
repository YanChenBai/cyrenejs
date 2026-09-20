import { dependencyBrand, lazyBrand, refBrand, tokenBrand } from './brands.ts';
import { InvalidDependencyError } from './errors.ts';
import type {
  DependencyIdentity,
  DependencyRef,
  LazyRef,
  Resolvable,
  RippleOptions,
  Token,
} from './types.ts';

export interface Definition {
  inputs: Readonly<Record<PropertyKey, unknown>>;
  invoke: (inputs: Record<PropertyKey, unknown>, params: readonly unknown[]) => unknown;
  options: Readonly<RippleOptions<unknown>>;
}

// 元数据不挂在公开属性上, 弱引用也不会阻止定义被回收
const definitions = new WeakMap<object, Definition>();
const lazyTargets = new WeakMap<object, () => Resolvable>();

export function setDefinition(target: object, definition: Definition): void {
  definitions.set(target, definition);
}

export function getDefinition(target: object): Definition {
  const definition = definitions.get(target);
  if (!definition) throw new InvalidDependencyError('Unknown dependency definition');
  return definition;
}

export function setLazyTarget(target: object, getTarget: () => Resolvable): void {
  lazyTargets.set(target, getTarget);
}

export function getLazyTarget(target: object): Resolvable {
  const getTarget = lazyTargets.get(target);
  if (!getTarget) throw new InvalidDependencyError('Unknown lazy reference');
  const value = getTarget();
  assertResolvable(value);
  return value;
}

export function isObject(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

export function isDependency(value: unknown): value is DependencyIdentity {
  return isObject(value) && Object.hasOwn(value, dependencyBrand);
}

export function isRef(value: unknown): value is DependencyRef {
  return isObject(value) && Object.hasOwn(value, refBrand);
}

export function isToken(value: unknown): value is Token {
  return isObject(value) && Object.hasOwn(value, tokenBrand);
}

export function isLazy(value: unknown): value is LazyRef {
  return isObject(value) && Object.hasOwn(value, lazyBrand);
}

export function assertResolvable(value: unknown): asserts value is Resolvable {
  if (isDependency(value)) {
    getDefinition(value);
    return;
  }
  if (isRef(value) && isDependency(value.dependency) && Array.isArray(value.params)) {
    getDefinition(value.dependency);
    return;
  }
  if (isToken(value) && typeof value.name === 'string') return;
  throw new InvalidDependencyError('Expected a Dependency, DependencyRef or Token');
}

export function entries(value: object): [PropertyKey, unknown][] {
  // 同时保留字符串键和 Symbol 键, 忽略继承属性与不可枚举属性
  return Reflect.ownKeys(value)
    .filter(key => Object.prototype.propertyIsEnumerable.call(value, key))
    .map(key => [key, Reflect.get(value, key)]);
}

export function targetName(target: Resolvable | DependencyIdentity): string {
  if (isToken(target)) return target.name;
  const definition = getDefinition(isRef(target) ? target.dependency : target);
  return `${definition.options.debugName ?? 'Dependency'}${isRef(target) ? '(ref)' : ''}`;
}
