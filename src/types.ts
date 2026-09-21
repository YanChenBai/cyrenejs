import type {
  dependencyBrand,
  lazyBrand,
  refBrand,
  tokenBrand,
  RIPPLE_SYMBOL,
  RIPPLES_SYMBOL,
} from './brands.ts';

export type Lifetime = 'singleton' | 'transient';

export interface RippleOptions<T> {
  lifetime?: Lifetime;
  debugName?: string;
  dispose?: (value: T) => void | Promise<void>;
}

export interface DependencyIdentity<T = unknown, P extends unknown[] = unknown[]> {
  // 仅携带编译期类型信息, 运行时 brand 不存放实例结果或参数声明
  readonly [dependencyBrand]: { readonly result?: T; readonly params: P };
}

export type Dependency<T, P extends unknown[] = []> = DependencyIdentity<T, P> & {
  readonly [RIPPLE_SYMBOL]: true;
} & ((...params: P) => DependencyRef<T>);

export interface DependencyRef<T = unknown> {
  readonly [refBrand]: { readonly result?: T };
  readonly dependency: DependencyIdentity<T>;
  readonly params: readonly unknown[];
}

export interface Token<T = unknown> {
  readonly [tokenBrand]: { readonly result?: T };
  readonly name: string;
}

export interface LazyRef<T = unknown> {
  readonly [lazyBrand]: { readonly result?: T };
}

export interface Lazy<T> {
  resolve(): Promise<T>;
}

export type Resolvable<T = unknown> = Dependency<T, []> | DependencyRef<T> | Token<T>;
export type DependencyEntries = Record<string, Resolvable>;

export type ValidRipples<T> = Record<Exclude<keyof T, string | typeof RIPPLES_SYMBOL>, never>;

export type RipplesBrand = {
  readonly [RIPPLES_SYMBOL]: true;
};

export type Ripples<T extends DependencyEntries = DependencyEntries> = {
  [K in keyof T as K extends string ? K : never]: T[K];
} & RipplesBrand;

export type InferInput<T> =
  T extends DependencyIdentity<infer R>
    ? R
    : T extends DependencyRef<infer R> | Token<infer R>
      ? R
      : T extends LazyRef<infer R>
        ? Lazy<R>
        : T;

export type ResolveInputs<T> = {
  [K in keyof T as K extends typeof RIPPLES_SYMBOL ? never : K]: InferInput<T[K]>;
};
export type ResolveEntries<T extends DependencyEntries> = ResolveInputs<T>;

// 有参数的定义必须先创建 Ref, 包括仅有可选参数或 rest 参数的情况
export type ValidInputs<T> = {
  [K in keyof T]: T[K] extends DependencyIdentity<unknown, infer P>
    ? P extends []
      ? T[K]
      : never
    : T[K];
};

export type Binding<T = unknown> =
  | { token: Token<T>; value: T; dependency?: never }
  | { token: Token<T>; dependency: Resolvable<T>; value?: never };

// 按元组元素关联 Token 与实现类型, 避免异构绑定退化为 unknown 检查
export type ValidBindings<T extends readonly Binding[]> = {
  [K in keyof T]: T[K] extends { token: Token<infer R> } ? Binding<R> : never;
};

export interface CyreneOptions<
  T extends DependencyEntries = {},
  B extends readonly Binding[] = readonly Binding[],
> {
  ripples?: T & ValidRipples<T>;
  bindings?: B & ValidBindings<B>;
}

export interface GraphNode {
  id: number;
  kind: 'dependency' | 'ref' | 'token';
  name: string;
  lifetime?: Lifetime;
  params?: readonly unknown[];
}

export interface GraphEdge {
  from: number;
  to: number;
  kind: 'dependency' | 'lazy' | 'definition';
}

export interface DependencyGraph {
  roots: number[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}
