import { InvalidDependencyError } from './errors.ts';
import type { RippleOptions } from './types.ts';

export interface Definition {
  inputs: Readonly<Record<PropertyKey, unknown>> | readonly unknown[];
  invoke: (
    inputs: Record<PropertyKey, unknown> | readonly unknown[],
    params: readonly unknown[],
  ) => unknown;
  options: Readonly<RippleOptions<unknown>>;
}

// 元数据不挂在公开属性上, 弱引用也不会阻止定义被回收
const definitions = new WeakMap<object, Definition>();

export function setDefinition(target: object, definition: Definition): void {
  definitions.set(target, definition);
}

export function getDefinition(target: object): Definition {
  const definition = definitions.get(target);

  if (!definition) {
    throw new InvalidDependencyError('Unknown dependency definition');
  }

  return definition;
}
