import type { RIPPLE_BRAND, LAZY_BRAND } from './symbols.ts';

export type Lifetime = 'singleton' | 'transient';

export interface RippleOptions {
  /** 默认 singleton；transient 每次解析重新创建，资源仍由容器统一释放。 */
  lifetime?: Lifetime;
  /** 外部实例显式标为 borrowed，容器不接管清理。 */
  ownership?: 'owned' | 'borrowed';
}

/** key 属于声明；实例与替换配置仍由各个容器独立管理。 */
export interface Dependency<
  T = unknown,
  Inputs = unknown,
  Async extends boolean = boolean,
  Key extends string = string,
> {
  readonly key: Key;
  readonly [RIPPLE_BRAND]: {
    readonly result?: T;
    /** 保留输入类型，运行时配方存放在内部 WeakMap。 */
    readonly inputs?: Inputs;
    readonly async?: Async;
  };
}

export interface LazyRef<T = unknown, Async extends boolean = boolean> {
  readonly [LAZY_BRAND]: { readonly result?: T; readonly async?: Async };
}

export interface Lazy<T, Async extends boolean = boolean> {
  /** 按目标 lifetime 解析；transient 每次调用创建新实例。 */
  resolve(): AsyncResult<T, Async>;
}

export type DependencyEntries = Record<string, Dependency>;
export type EntryDeclarations<T extends readonly Dependency[]> = {
  [D in T[number] as D['key']]: D;
};

export type InferInput<T> =
  T extends Dependency<infer R> ? R : T extends LazyRef<infer R, infer A> ? Lazy<R, A> : T;

export type ResolveInputs<T> = {
  [K in keyof T]: InferInput<T[K]>;
};

export type AsyncResult<T, Async extends boolean> = Async extends true ? Promise<T> : T;

export type DependencyAsync<D> = D extends Dependency<unknown, unknown, infer A> ? A : false;
export type Resolved<D> =
  D extends Dependency<infer T, unknown, infer A> ? AsyncResult<T, A> : unknown;

type AsyncMode<T> =
  true extends DependencyAsync<T>
    ? [T] extends [Dependency<unknown, unknown, true>]
      ? 'async'
      : 'maybe'
    : never;

type InputAsync<D> = { [K in keyof D]: AsyncMode<D[K]> }[keyof D];

type FactoryMode<T> = [T] extends [never]
  ? false
  : unknown extends T
    ? boolean
    : [T] extends [PromiseLike<unknown>]
      ? true
      : [Extract<T, PromiseLike<unknown>>] extends [never]
        ? false
        : boolean;

/** 逐个输入对象分支计算，保留全异步或同步/异步混合的返回契约。 */
export type FactoryAsync<T, D = {}> =
  FactoryMode<T> extends true
    ? true
    : D extends unknown
      ? 'async' extends InputAsync<D>
        ? true
        : 'maybe' extends InputAsync<D>
          ? boolean
          : FactoryMode<T>
      : never;

export type ResolveEntries<T extends DependencyEntries> = {
  readonly [K in keyof T]: Resolved<T[K]>;
};

export type NodeState = 'registered' | 'initializing' | 'ready' | 'failed';

export interface GraphNode {
  /** 原声明的 key；替换实现不会改变它。 */
  key: string;
  state: NodeState;
}

export interface GraphEdge {
  from: string;
  to: string;
  input: PropertyKey;
  kind: 'dependency' | 'lazy';
}

export interface DependencyGraph {
  roots: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}
