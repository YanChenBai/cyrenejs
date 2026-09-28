import { InvalidDependencyError } from './errors.ts';
import type { Dependency, RippleOptions } from './types.ts';
import { isObject } from './utils.ts';

/** 不可变的构造配方；不持有某个 Cyrene 的槽位、实例或邻接信息。 */
export interface RippleDefinition {
  readonly inputs: Readonly<Record<PropertyKey, unknown>>;
  readonly invoke: (inputs: Record<PropertyKey, unknown>) => unknown;
  readonly options: Readonly<RippleOptions>;
}
// 元数据不暴露在声明属性上，替换只改变运行时绑定，绝不改写原始声明。
const definitions = new WeakMap<object, RippleDefinition>();

/** 为新声明登记不可变构造配方；此操作只由 ripple 创建声明时调用。 */
export function defineDependency(target: Dependency, definition: RippleDefinition): void {
  // inputs 与 options 的浅拷贝冻结由 ripple 完成，这里冻结配方本身。
  // 不深冻用户输入，否则会意外修改调用方拥有的业务对象。
  definitions.set(target, Object.freeze(definition));
}

/** 读取声明配方；未在当前库登记的伪造声明会明确报错。 */
export function getDefinition(target: Dependency): RippleDefinition {
  const definition = definitions.get(target);

  if (!definition) {
    throw new InvalidDependencyError('Unknown Ripple declaration');
  }

  return definition;
}

/** 通过内部登记身份识别声明，不以公开字段形状推测其合法性。 */
export function isDependency(value: unknown): value is Dependency {
  // 判断真实登记记录而不是只看 id 或品牌，手写同形对象不能冒充工厂声明。
  return isObject(value) && definitions.has(value);
}

/** 在动态输入边界校验声明，并向 TypeScript 收窄可解析目标类型。 */
export function assertDependency(value: unknown): asserts value is Dependency {
  if (!isDependency(value)) {
    throw new InvalidDependencyError('Expected a Ripple declaration');
  }
}
