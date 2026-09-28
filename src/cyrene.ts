import { assertDependency, getDefinition } from './dependency.ts';
import {
  CircularDependencyError,
  DisposedError,
  InvalidDependencyError,
  ResolutionError,
} from './errors.ts';
import { compileRegistry } from './registry.ts';
import type { Registry } from './registry.ts';
import { ResourceStore } from './resources.ts';
import type {
  Dependency,
  DependencyEntries,
  DependencyGraph,
  DependencyAsync,
  Resolved,
  ResolveEntries,
  InferInput,
  NodeState,
  EntryDeclarations,
} from './types.ts';
import { inputEntries } from './utils.ts';

interface Resolution {
  key: string;
  parent?: Resolution;
  state: Exclude<NodeState, 'registered'>;
  value?: unknown;
  error?: unknown;
  executing: boolean;
  resultDeferred?: boolean;
  /** 仅保存尚未完成的初始化等待边，不维护第二份资源依赖图。 */
  waiting: Set<Resolution>;
}

/** 等待所有分支结束后报告失败，确保 dispose 不遗漏晚到的资源。 */
async function settle<T>(tasks: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(tasks);

  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);

  if (errors.length === 1) {
    throw errors[0];
  }

  if (errors.length) {
    throw new AggregateError(errors, 'Multiple dependencies failed');
  }

  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}

export class Cyrene<TRipples extends DependencyEntries = {}> {
  #roots = new Map<string, Dependency>();

  #overrides = new Map<Dependency, Dependency>();

  #identities = new Map<Dependency, string>();

  #registry?: Registry;

  #cache = new Map<string, Resolution>();

  #states = new Map<string, NodeState>();

  #executing = new Set<string>();

  #pending = new Set<Promise<unknown>>();

  #resources = new ResourceStore();

  #state: 'configuring' | 'active' | 'disposing' | 'disposed' = 'configuring';

  #disposal?: Promise<void>;

  #ripples: Record<string, unknown> = Object.create(null);

  #view = new Proxy(this.#ripples, {
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
    setPrototypeOf: () => false,
    preventExtensions: () => false,
  });

  get ripples(): ResolveEntries<TRipples> {
    return this.#view as ResolveEntries<TRipples>;
  }

  /** 显式入口原地累积；依赖在构图时自动收集，不暴露为属性。 */
  use<const T extends readonly Dependency[]>(
    ...declarations: T
  ): Cyrene<TRipples & EntryDeclarations<T>>;
  use(...declarations: Dependency[]): unknown {
    this.#assertConfiguring();
    const incoming = new Map<string, Dependency>();

    for (const declaration of declarations) {
      assertDependency(declaration);
      const existing = incoming.get(declaration.key) ?? this.#roots.get(declaration.key);

      if (existing && existing !== declaration) {
        throw new InvalidDependencyError(`Duplicate Ripple key: ${declaration.key}`);
      }

      incoming.set(declaration.key, declaration);
    }

    for (const [key, declaration] of incoming) {
      if (this.#roots.has(key)) {
        continue;
      }

      this.#roots.set(key, declaration);
      Object.defineProperty(this.#ripples, key, {
        enumerable: true,
        get: () => this.resolve(declaration),
      });
      this.#registry = undefined;
    }

    return this;
  }

  /** 替换以原声明定位，保留原 key 与公开范围；构图时检查目标可达性。 */
  override<D extends Dependency>(
    target: D,
    replacement: Dependency<NoInfer<InferInput<D>>, unknown, NoInfer<DependencyAsync<D>>>,
  ): this {
    this.#assertConfiguring();
    assertDependency(target);
    assertDependency(replacement);
    this.#overrides.set(target, replacement);
    this.#registry = undefined;

    return this;
  }

  resolve<D extends Dependency>(target: D): Resolved<D>;
  resolve<K extends string>(key: K): K extends keyof TRipples ? Resolved<TRipples[K]> : unknown;

  /** 三种入口遵循同一 lifetime；singleton 复用结果，transient 每次重新创建。 */
  resolve(target: string | Dependency): unknown {
    if (this.#state === 'disposing' || this.#state === 'disposed') {
      throw new DisposedError('Cyrene is disposing or disposed');
    }

    this.#state = 'active';
    Object.preventExtensions(this.#ripples);
    this.#compile();
    const key = this.#resolveKey(target);
    this.#require(key);

    return this.#resolve(key);
  }

  inspect(): DependencyGraph {
    const registry = this.#compile();

    return {
      roots: [...this.#roots.keys()],
      nodes: [...registry.keys()].map(key => ({
        key,
        state: this.#states.get(key) ?? 'registered',
      })),
      edges: [...registry.values()].flatMap(node =>
        [...node.dependencies.values()].map(edge => ({ ...edge })),
      ),
    };
  }

  /** 关闭入口后等待已接收的初始化，再逆序清理；业务方法的在途工作由应用停止。 */
  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }

    this.#state = 'disposing';
    // 先保存关闭 Promise，再执行用户清理代码，保证同步重入 dispose 仍然幂等。
    this.#disposal = Promise.resolve().then(() => this.#close());

    return this.#disposal;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #assertConfiguring(): void {
    if (this.#state !== 'configuring') {
      throw new InvalidDependencyError('Registrations are locked after the first resolution');
    }
  }

  #compile(): Registry {
    if (!this.#registry) {
      const compiled = compileRegistry(this.#roots.values(), this.#overrides);
      this.#registry = compiled.registry;
      this.#identities = compiled.identities;
    }

    return this.#registry;
  }

  #require(key: string): void {
    if (!this.#registry!.has(key)) {
      throw new InvalidDependencyError(`Unknown registration key: ${key}`);
    }
  }

  #resolveKey(target: string | Dependency): string {
    if (typeof target === 'string') {
      return target;
    }

    assertDependency(target);

    const key = this.#identities.get(target);

    if (key !== undefined) {
      return key;
    }

    throw new InvalidDependencyError('Unregistered Ripple declaration');
  }

  #resolve(key: string, owner?: Resolution): unknown {
    return this.#result(this.#resolveRecord(key, owner), owner);
  }

  /** singleton 复用缓存，transient 保留独立的初始化记录与等待关系。 */
  #resolveRecord(key: string, owner?: Resolution, deferred = false): Resolution {
    let record = this.#cache.get(key);
    const fresh = !record;

    if (!record) {
      record = this.#newRecord(key, owner);
    }

    if (!fresh && record.executing && (!owner || deferred)) {
      throw new CircularDependencyError(`Circular initialization: ${owner?.key ?? key} -> ${key}`);
    }

    if (!deferred && owner) {
      this.#waitFor(record, owner);
    }

    if (fresh) {
      this.#create(record);
    }

    return record;
  }

  #newRecord(key: string, owner?: Resolution): Resolution {
    this.#assertCreationPath(key, owner);

    const record: Resolution = {
      key,
      parent: owner,
      state: 'initializing',
      executing: true,
      waiting: new Set(),
    };

    const definition = getDefinition(this.#registry!.get(key)!.implementation);

    if (definition.options.lifetime !== 'transient') {
      this.#cache.set(key, record);
    }

    return record;
  }

  /** 等待边只连接尚未完成的具体实例，不按声明 key 合并 transient。 */
  #waitFor(target: Resolution, owner: Resolution): void {
    if (owner.state !== 'initializing' || target.state !== 'initializing') {
      return;
    }

    if (this.#reaches(target, owner)) {
      throw new CircularDependencyError(`Circular initialization: ${owner.key} -> ${target.key}`);
    }

    owner.waiting.add(target);
  }

  /** transient 递归会不断产生新记录，须按仍在初始化的创建链阻止无限展开。 */
  #assertCreationPath(key: string, owner?: Resolution): void {
    if (this.#executing.has(key)) {
      throw new CircularDependencyError(`Circular initialization: ${key}`);
    }

    for (let ancestor = owner; ancestor?.state === 'initializing'; ancestor = ancestor.parent) {
      if (ancestor.key === key) {
        throw new CircularDependencyError(`Circular initialization: ${owner?.key} -> ${key}`);
      }
    }
  }

  #result(record: Resolution, owner?: Resolution): unknown {
    // lazy 启动的消费者可以先等待执行中的父工厂，待其交付结果后再继续。
    let value = record.value;

    if (record.executing) {
      record.resultDeferred = true;
      value = Promise.resolve().then(() => this.#result(record));
    }

    if (owner) {
      if (isPromise(value)) {
        void Promise.resolve(value).then(
          () => owner.waiting.delete(record),
          () => owner.waiting.delete(record),
        );
      } else {
        owner.waiting.delete(record);
      }
    }

    if (record.state === 'failed' && !isPromise(value)) {
      throw record.error;
    }

    return value;
  }

  #create(record: Resolution): void {
    this.#states.set(record.key, 'initializing');
    this.#executing.add(record.key);

    try {
      const value = this.#initialize(record);

      if (isPromise(value)) {
        const promise = Promise.resolve(value)
          .then(result => this.#complete(record, result))
          .catch(cause => {
            throw this.#fail(record, cause);
          });

        record.value = promise;
        this.#pending.add(promise);
        void promise.then(
          () => this.#pending.delete(promise),
          () => this.#pending.delete(promise),
        );
      } else {
        const result = this.#complete(record, value);

        // 同步环无法交付同步实例；已返回的资源仍须登记并在关闭时释放。
        if (record.resultDeferred) {
          throw new CircularDependencyError(`Circular synchronous initialization: ${record.key}`);
        }

        record.value = result;
      }
    } catch (cause) {
      this.#fail(record, cause);
    } finally {
      record.executing = false;
      this.#executing.delete(record.key);
    }
  }

  #complete(record: Resolution, value: unknown): unknown {
    const definition = getDefinition(this.#registry!.get(record.key)!.implementation);
    this.#resources.add(value, definition.options.ownership ?? 'owned');
    record.state = 'ready';
    this.#states.set(record.key, 'ready');
    record.waiting.clear();

    return value;
  }

  #fail(record: Resolution, cause: unknown): unknown {
    record.state = 'failed';
    this.#states.set(record.key, 'failed');
    record.waiting.clear();
    record.error =
      cause instanceof CircularDependencyError || cause instanceof ResolutionError
        ? cause
        : new ResolutionError([record.key], cause);

    return record.error;
  }

  #reaches(source: Resolution, target: Resolution, visited = new Set<Resolution>()): boolean {
    if (source === target) {
      return true;
    }

    if (visited.has(source)) {
      return false;
    }

    visited.add(source);

    return [...source.waiting].some(child => this.#reaches(child, target, visited));
  }

  #initialize(record: Resolution): unknown {
    const registration = this.#registry!.get(record.key)!;
    const definition = getDefinition(registration.implementation);
    const resolved: Record<PropertyKey, unknown> = {};
    const pending: Promise<void>[] = [];
    const errors: unknown[] = [];

    for (const [key, input] of inputEntries(definition.inputs)) {
      const edge = registration.dependencies.get(key);

      try {
        if (!edge) {
          Object.defineProperty(resolved, key, { value: input, enumerable: true });
          continue;
        }

        const value =
          edge.kind === 'lazy' ? this.#lazyHandle(edge.to, record) : this.#resolve(edge.to, record);

        const assign = (value: unknown) => {
          Object.defineProperty(resolved, key, { value, enumerable: true });
        };

        if (isPromise(value)) {
          pending.push(Promise.resolve(value).then(assign));
        } else {
          assign(value);
        }
      } catch (error) {
        errors.push(error);
      }
    }

    if (pending.length) {
      return settle([...pending, ...errors.map(error => Promise.reject(error))]).then(() =>
        definition.invoke(resolved),
      );
    }

    if (errors.length === 1) {
      throw errors[0];
    }

    if (errors.length) {
      throw new AggregateError(errors, 'Multiple dependencies failed');
    }

    return definition.invoke(resolved);
  }

  #lazyHandle(key: string, owner: Resolution) {
    const pending = new WeakMap<Resolution, Promise<unknown>>();

    return Object.freeze({
      resolve: () => {
        const isClosed =
          this.#state === 'disposed' ||
          (this.#state === 'disposing' && owner.state !== 'initializing');

        if (isClosed || owner.state === 'failed') {
          throw new DisposedError('Lazy owner is unavailable');
        }

        const target = this.#resolveRecord(key, owner, true);
        const value = this.#result(target);

        if (owner.state !== 'initializing' || !isPromise(value)) {
          return value;
        }

        // 启动 lazy 不等于等待；只有消费 Promise 时才登记等待关系。
        const existing = pending.get(target);

        if (existing) {
          return existing;
        }

        const promise = new LazyPromise(Promise.resolve(value), () => {
          this.#waitFor(target, owner);
          this.#result(target, owner);
        });

        pending.set(target, promise);

        return promise;
      },
    });
  }

  async #close(): Promise<void> {
    try {
      while (this.#pending.size) {
        await Promise.allSettled(this.#pending);
      }

      // 真实依赖引用不失效，消费者的清理方法仍可使用尚未释放的依赖。
      await this.#resources.dispose();
    } finally {
      this.#state = 'disposed';
      this.#cache.clear();
      this.#states.clear();
      this.#roots.clear();
      this.#overrides.clear();
      this.#identities.clear();
      this.#registry = undefined;
    }
  }
}

/** Promise 子类让 await 也经过 then，派生结果使用原生 Promise。 */
class LazyPromise extends Promise<unknown> {
  #beforeWait: () => void;

  static get [Symbol.species]() {
    return Promise;
  }

  constructor(promise: Promise<unknown>, beforeWait: () => void) {
    super((resolve, reject) => promise.then(resolve, reject));
    this.#beforeWait = beforeWait;
    // 仅启动而未消费的句柄不应额外产生未处理拒绝。
    void super.then(undefined, () => {});
  }

  // 此类本身就是 Promise，需要拦截 await 的同化过程。
  // oxlint-disable-next-line unicorn/no-thenable
  override then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    try {
      this.#beforeWait();
    } catch (error) {
      return Promise.reject(error).then(onfulfilled, onrejected);
    }

    return super.then(onfulfilled, onrejected);
  }
}

function isPromise(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof Reflect.get(value, 'then') === 'function'
  );
}
