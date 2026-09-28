import { assertDependency } from './dependency.ts';
import { LAZY_BRAND } from './symbols.ts';
import type { Dependency, DependencyAsync, InferInput, LazyRef } from './types.ts';
import { isObject } from './utils.ts';

const targets = new WeakMap<object, () => Dependency>();

/** 延迟初始化与前向引用分别由 Lazy 句柄和声明回调负责。回调必须稳定且无副作用。 */
export function lazy<D extends Dependency>(
  getTarget: () => D,
): LazyRef<InferInput<D>, DependencyAsync<D>> {
  // 此时只记录回调，允许声明引用后面才定义的变量；不能在这里提前求值。
  const reference = Object.freeze({ [LAZY_BRAND]: Object.freeze({}) });
  targets.set(reference, getTarget);

  return reference;
}

/** 只认可由 lazy 创建并登记的标记，不接受手写品牌对象。 */
export function isLazy(value: unknown): value is LazyRef {
  return isObject(value) && targets.has(value);
}

/** 在构建声明闭包时取得真实目标；回调返回非声明时立即报错。 */
export function getLazyTarget(reference: LazyRef): Dependency {
  // 收集依赖闭包时求值并验证，随后将结果写入节点邻接元数据。
  // 因而 lazy 是延迟“实例初始化”，并不是延迟整个声明的合法性校验。
  const target = targets.get(reference)?.();
  assertDependency(target);

  return target;
}
