import {
  CircularDependencyError,
  DisposedError,
  InvalidDependencyError,
  ResolutionError,
} from './errors.ts';
import { getBinding, inspectGraph } from './graph.ts';
import {
  assertResolvable,
  entries,
  getDefinition,
  getLazyTarget,
  isDependency,
  isLazy,
  isObject,
  isRef,
  isToken,
  targetName,
} from './metadata.ts';
import type {
  Binding,
  CyreneOptions,
  DependencyEntries,
  DependencyGraph,
  Resolvable,
  ResolveEntries,
  Token,
} from './types.ts';

interface Instance {
  target: Resolvable;
  // 资源依赖保留到释放时, 等待关系只存在于初始化期间
  dependencies: Set<Instance>;
  waitingFor: Set<Instance>;
  promise: Promise<unknown>;
  state: 'initializing' | 'ready' | 'failed';
  value?: unknown;
  dispose?: () => void | Promise<void>;
}

async function settle<T>(promises: readonly Promise<T>[]): Promise<T[]> {
  // 某个分支失败后仍等待其他分支结束, 避免遗漏稍后创建的资源
  const results = await Promise.allSettled(promises);

  const errors = results
    .filter(result => result.status === 'rejected')
    .map(result => result.reason);

  if (errors.length === 1) {
    throw errors[0];
  }

  if (errors.length > 1) {
    throw new AggregateError(errors, 'Multiple dependencies failed');
  }

  return results.map(result => (result as PromiseFulfilledResult<T>).value);
}

export class Cyrene<
  TProviders extends DependencyEntries = {},
  const TBindings extends readonly Binding[] = readonly Binding[],
> {
  #providers: Readonly<TProviders>;
  readonly #bindings = new Map<Token, Binding>();
  readonly #cache = new Map<object, Instance>();
  readonly #instances = new Set<Instance>();
  readonly #pending = new Set<Promise<unknown>>();
  #state: 'active' | 'disposing' | 'disposed' = 'active';
  #startup?: Promise<ResolveEntries<TProviders>>;
  #disposal?: Promise<void>;

  constructor(options: CyreneOptions<TProviders, TBindings> = {}) {
    this.#providers = Object.freeze({ ...options.providers }) as Readonly<TProviders>;

    for (const target of Object.values(this.#providers)) {
      assertResolvable(target);
    }

    for (const binding of options.bindings ?? []) {
      if (!isToken(binding.token)) {
        throw new InvalidDependencyError('Binding requires a Token');
      }

      if (Object.hasOwn(binding, 'value') === Object.hasOwn(binding, 'dependency')) {
        throw new InvalidDependencyError(
          `Binding ${binding.token.name} requires exactly one of value or dependency`,
        );
      }

      if (this.#bindings.has(binding.token)) {
        throw new InvalidDependencyError(`Duplicate binding: ${binding.token.name}`);
      }

      if ('dependency' in binding) {
        assertResolvable(binding.dependency);
      }

      this.#bindings.set(binding.token, Object.freeze({ ...binding }));
    }
  }

  start(): Promise<ResolveEntries<TProviders>> {
    if (this.#state !== 'active') {
      return Promise.reject(new DisposedError('Cyrene is disposing or disposed'));
    }

    if (this.#startup) {
      return this.#startup;
    }

    this.#startup = this.#track(
      Promise.resolve().then(async () => {
        const providers = Object.entries(this.#providers);
        // 全部入口统一校验后才开始初始化, 避免后面的入口无效却已产生副作用
        inspectGraph(
          providers.map(([, target]) => target),
          this.#bindings,
        );

        const values = await settle(
          providers.map(([, target]) => this.#resolveTarget(target, undefined, [])),
        );

        return Object.fromEntries(
          providers.map(([name], index) => [name, values[index]]),
        ) as ResolveEntries<TProviders>;
      }),
    );
    return this.#startup;
  }

  resolve<T>(target: Resolvable<T>): Promise<T> {
    if (this.#state !== 'active') {
      return Promise.reject(new DisposedError('Cyrene is disposing or disposed'));
    }

    return this.#track(
      Promise.resolve().then(() => {
        inspectGraph([target], this.#bindings);
        return this.#resolveTarget(target, undefined, []);
      }),
    ) as Promise<T>;
  }

  validate(target?: Resolvable): void {
    this.inspect(target);
  }

  inspect(target?: Resolvable): DependencyGraph {
    this.#assertActive();
    return inspectGraph(
      target === undefined ? Object.values(this.#providers) : [target],
      this.#bindings,
    );
  }

  dispose(): Promise<void> {
    if (this.#disposal) {
      return this.#disposal;
    }

    // 同步关闭新解析入口, 清理过程等待已经接收的任务结束
    this.#state = 'disposing';
    this.#disposal = Promise.resolve().then(() => this.#dispose());
    return this.#disposal;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }

  #assertActive(): void {
    if (this.#state !== 'active') {
      throw new DisposedError('Cyrene is disposing or disposed');
    }
  }

  #track<T>(promise: Promise<T>): Promise<T> {
    this.#pending.add(promise);
    void promise.then(
      () => this.#pending.delete(promise),
      () => this.#pending.delete(promise),
    );
    return promise;
  }

  async #resolveTarget(
    target: Resolvable,
    owner: Instance | undefined,
    path: readonly string[],
  ): Promise<unknown> {
    assertResolvable(target);

    if (isToken(target)) {
      const binding = getBinding(this.#bindings, target, path);

      if ('dependency' in binding) {
        assertResolvable(binding.dependency);
        return this.#resolveTarget(binding.dependency, owner, [...path, target.name]);
      }

      // 外部值不进入实例持有集合, 生命周期仍由提供方管理
      return binding.value;
    }

    const definition = getDefinition(isRef(target) ? target.dependency : target);
    const isSingleton = definition.options.lifetime !== 'transient';

    if (!isSingleton && owner) {
      this.#assertNoTransientCycle(target, owner, path);
    }

    let instance = isSingleton ? this.#cache.get(target) : undefined;

    if (!instance) {
      instance = {
        target,
        dependencies: new Set(),
        waitingFor: new Set(),
        promise: Promise.resolve(),
        state: 'initializing',
      };
      const created = instance;

      // 先记录状态, 再在微任务中执行工厂, 保证并发解析共享同一次初始化
      if (isSingleton) {
        this.#cache.set(target, created);
      }

      this.#instances.add(created);
      const nextPath = [...path, targetName(target)];
      created.promise = this.#track(
        Promise.resolve().then(async () => {
          try {
            const inputs = entries(definition.inputs);

            const values = await settle(
              inputs.map(([, input]) => this.#resolveInput(input, created, nextPath)),
            );

            const dependencies = Object.fromEntries(
              inputs.map(([key], index) => [key, values[index]!.value]),
            );

            const value = await definition.invoke(dependencies, isRef(target) ? target.params : []);

            created.value = value;
            created.dispose = this.#getDisposer(value, definition.options.dispose);
            created.state = 'ready';
            return value;
          } catch (cause) {
            created.state = 'failed';
            this.#instances.delete(created);

            // 只移除失败实例的缓存, 不重置 start 已记录的失败结果
            if (isSingleton) {
              this.#cache.delete(target);
            }

            if (cause instanceof ResolutionError || cause instanceof CircularDependencyError) {
              throw cause;
            }

            throw new ResolutionError(nextPath, cause);
          }
        }),
      );
    }

    if (!owner) {
      return instance.promise;
    }

    // 延迟依赖激活后也记录资源关系, 释放顺序不能只依赖创建时间
    owner.dependencies.add(instance);

    if (instance.state === 'initializing') {
      if (this.#reaches(instance, owner, new Set())) {
        throw new CircularDependencyError(
          `Circular initialization: ${[...path, targetName(target)].join(' -> ')}`,
        );
      }

      owner.waitingFor.add(instance);
    }

    try {
      return await instance.promise;
    } finally {
      owner.waitingFor.delete(instance);
    }
  }

  #assertNoTransientCycle(target: Resolvable, owner: Instance, path: readonly string[]): void {
    // transient 没有缓存, 按正在等待的实例链检测重复身份, 避免 lazy 环无限创建实例
    for (const pending of this.#instances) {
      if (
        pending.target === target &&
        pending.state === 'initializing' &&
        this.#reaches(pending, owner, new Set())
      ) {
        throw new CircularDependencyError(
          `Circular initialization: ${[...path, targetName(target)].join(' -> ')}`,
        );
      }
    }
  }

  async #resolveInput(
    input: unknown,
    owner: Instance,
    path: readonly string[],
  ): Promise<{ value: unknown }> {
    if (isLazy(input)) {
      const target = getLazyTarget(input);
      return {
        value: Object.freeze({
          resolve: () => {
            if (this.#state !== 'active') {
              return Promise.reject(new DisposedError('Cyrene is disposing or disposed'));
            }

            return this.#track(
              Promise.resolve().then(() => {
                inspectGraph([target], this.#bindings);
                return this.#resolveTarget(
                  target,
                  owner,
                  owner.state === 'initializing' ? path : [],
                );
              }),
            );
          },
        }),
      };
    }

    if (isDependency(input) || isRef(input) || isToken(input)) {
      assertResolvable(input);
      return { value: await this.#resolveTarget(input, owner, path) };
    }

    // 包装普通值, 避免 async 返回时自动展开作为输入传入的 Promise
    return { value: input };
  }

  #reaches(instance: Instance, target: Instance, visited: Set<Instance>): boolean {
    if (instance === target) {
      return true;
    }

    if (visited.has(instance)) {
      return false;
    }

    visited.add(instance);
    return [...instance.waitingFor].some(child => this.#reaches(child, target, visited));
  }

  #getDisposer(
    value: unknown,
    dispose?: (value: unknown) => void | Promise<void>,
  ): (() => void | Promise<void>) | undefined {
    if (dispose) {
      return () => dispose(value);
    }

    if (!isObject(value)) {
      return undefined;
    }

    const method = Reflect.get(value, Symbol.asyncDispose) ?? Reflect.get(value, Symbol.dispose);

    if (typeof method === 'function') {
      return () => method.call(value);
    }

    return undefined;
  }

  async #dispose(): Promise<void> {
    // 已接收的任务仍可能创建间接依赖, 持续等待直到没有在途任务
    while (this.#pending.size) {
      await Promise.allSettled(this.#pending);
    }

    const visited = new Set<Instance>();
    const order: Instance[] = [];

    const visit = (instance: Instance) => {
      if (visited.has(instance)) {
        return;
      }

      visited.add(instance);

      for (const dependency of instance.dependencies) {
        visit(dependency);
      }

      order.push(instance);
    };

    for (const instance of this.#instances) {
      visit(instance);
    }

    const disposed = new Set<object>();
    const errors: unknown[] = [];

    // 后序遍历反转后先释放消费者, visited 同时避免延迟资源环重复遍历
    for (const instance of order.reverse()) {
      if (instance.state !== 'ready' || !instance.dispose) {
        continue;
      }

      if (isObject(instance.value)) {
        if (disposed.has(instance.value)) {
          continue;
        }

        disposed.add(instance.value);
      }

      try {
        await instance.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const instance of order) {
      instance.dependencies.clear();
      instance.waitingFor.clear();
      instance.value = undefined;
      instance.dispose = undefined;
      instance.promise = Promise.resolve();
    }

    this.#providers = Object.freeze({}) as Readonly<TProviders>;
    this.#cache.clear();
    this.#instances.clear();
    this.#bindings.clear();
    this.#startup = undefined;
    this.#state = 'disposed';

    if (errors.length) {
      throw new AggregateError(errors, 'Failed to dispose Cyrene resources');
    }
  }
}
