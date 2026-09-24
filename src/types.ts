import type {
  DEPENDENCY_BRAND,
  LAZY_BRAND,
  REF_BRAND,
  RIPPLE_BRAND,
  POEM_BRAND,
} from './brands.ts';

export type Lifetime = 'singleton' | 'transient';

export interface RippleOptions<T> {
  lifetime?: Lifetime;
  debugName?: string;
  dispose?: (value: T) => void | Promise<void>;
}

export interface DependencyIdentity<T = unknown, P extends unknown[] = unknown[]> {
  // 仅携带编译期类型信息, 运行时 brand 不存放实例结果或参数声明
  readonly [DEPENDENCY_BRAND]: { readonly result?: T; readonly params: P };
}

export type Dependency<T, P extends unknown[] = []> = DependencyIdentity<T, P> & {
  readonly [RIPPLE_BRAND]: true;
} & ((...params: P) => DependencyRef<T>);

export interface DependencyRef<T = unknown> {
  readonly [REF_BRAND]: { readonly result?: T };
  readonly dependency: DependencyIdentity<T>;
  readonly params: readonly unknown[];
}

export interface LazyRef<T = unknown> {
  readonly [LAZY_BRAND]: { readonly result?: T };
}

export interface Lazy<T> {
  resolve(): Promise<T>;
}

export type Resolvable<T = unknown> = Dependency<T, []> | DependencyRef<T>;
export type DependencyEntries = Record<string, Resolvable> | readonly Resolvable[];

export type ValidRipples<T> = T extends readonly unknown[]
  ? Record<Exclude<keyof T, keyof unknown[] | `${number}` | typeof POEM_BRAND>, never>
  : Record<Exclude<keyof T, string | typeof POEM_BRAND>, never>;

export type PoemBrand = {
  readonly [POEM_BRAND]: true;
};

// 去掉组合时带入的旧标识, 避免消费方声明泄漏内部 Symbol
export type Poem<T extends Record<string, Resolvable> = Record<string, Resolvable>> = {
  [K in keyof T as K extends string ? K : never]: T[K];
} & PoemBrand;

export type InferInput<T> =
  T extends DependencyIdentity<infer R>
    ? R
    : T extends DependencyRef<infer R>
      ? R
      : T extends LazyRef<infer R>
        ? Lazy<R>
        : T;

export type ResolveInputs<T> = T extends readonly [...infer Items]
  ? { [K in keyof Items]: InferInput<Items[K]> }
  : { [K in keyof T as K extends typeof POEM_BRAND ? never : K]: InferInput<T[K]> };

// 有参数的定义必须先创建 Ref, 包括仅有可选参数或 rest 参数的情况
export type ValidInputs<T> = {
  [K in keyof T]: T[K] extends DependencyIdentity<unknown, infer P>
    ? P extends []
      ? T[K]
      : never
    : T[K];
};

export interface CyreneOptions<T extends DependencyEntries = {}> {
  ripples?: T & ValidRipples<T>;
}

export interface GraphNode {
  id: number;
  kind: 'dependency' | 'ref';
  name: string;
  lifetime?: Lifetime;
  params?: readonly unknown[];
  retained?: boolean;
}

export interface GraphEdge {
  from: number;
  to: number;
  kind: 'dependency' | 'lazy' | 'definition' | 'override';
}

export interface DependencyGraph {
  roots: number[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}
