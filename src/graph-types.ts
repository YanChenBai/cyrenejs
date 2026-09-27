import type { Dependency, DependencyEntries } from './types.ts';

/** 对象身份无法进入类型系统，只在声明结构能唯一定位注册 key 时建立边。 */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type IsUnion<T, Whole = T> = T extends Whole ? ([Whole] extends [T] ? false : true) : never;

type MatchingKeys<Target, Originals, Implementations> = {
  [K in keyof Originals & keyof Implementations & string]: Equal<Target, Originals[K]> extends true
    ? K
    : Equal<Target, Implementations[K]> extends true
      ? K
      : never;
}[keyof Originals & keyof Implementations & string];

type UniqueKey<Target, Originals, Implementations> =
  MatchingKeys<Target, Originals, Implementations> extends infer Keys
    ? true extends IsUnion<Keys>
      ? never
      : Keys & string
    : never;

type StrongTargets<D> =
  D extends Dependency<unknown, infer Inputs>
    ? {
        [P in keyof Inputs]: Inputs[P] extends Dependency ? Inputs[P] : never;
      }[keyof Inputs]
    : never;

type TargetKeys<Target, Originals, Implementations> = Target extends Dependency
  ? UniqueKey<Target, Originals, Implementations>
  : never;

type Edges<Originals, Implementations, K extends keyof Implementations> = TargetKeys<
  StrongTargets<Implementations[K]>,
  Originals,
  Implementations
>;

/** 沿当前路径搜索回边；lazy 不属于 StrongTargets，因此不参与检查。 */
type Visit<
  Originals,
  Implementations,
  K,
  Path extends string = never,
> = K extends keyof Implementations & string
  ? K extends Path
    ? K
    : Visit<Originals, Implementations, Edges<Originals, Implementations, K>, Path | K>
  : never;

type CycleKeys<Originals, Implementations> = string extends keyof Originals
  ? never
  : Visit<Originals, Implementations, keyof Implementations & string>;

/** 无法静态辨认的边留给运行时；明确的循环使调用参数缺少此诊断属性。 */
export type Acyclic<
  Originals extends DependencyEntries,
  Implementations extends DependencyEntries,
> = [CycleKeys<Originals, Implementations>] extends [never]
  ? unknown
  : { readonly 'Circular dependency': CycleKeys<Originals, Implementations> };

export type ReplaceDependency<
  T extends DependencyEntries,
  K extends string,
  D extends Dependency,
> = Omit<T, K> & Record<K, D>;
