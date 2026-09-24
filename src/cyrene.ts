import { assertResolvable, isDependency, isRef, targetName } from './dependency.ts';
import {
  CircularDependencyError,
  DisposedError,
  InvalidDependencyError,
  ResolutionError,
} from './errors.ts';
import { isLazy } from './lazy.ts';
import { getDefinition } from './metadata.ts';
import { RuntimeGraph } from './runtime-graph.ts';
import type { CyreneOptions, DependencyEntries, DependencyGraph, Resolvable } from './types.ts';
import { entries, isObject } from './utils.ts';
import { assertRipples } from './validation.ts';

interface Instance {
  target: Resolvable;
  // 资源依赖保留到释放时, 等待关系只存在于初始化期间
  dependencies: Set<Instance>;
  waitingFor: Set<Instance>;
  promise: Promise<unknown>;
  state: 'initializing' | 'ready' | 'failed';
  value?: unknown;
  resource?: Resource;
}

interface Resource {
  dependencies: Set<Resource>;
  dispose?: () => void | Promise<void>;
  explicitDispose?: (value: unknown) => void | Promise<void>;
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

function removalOrder(
  instances: ReadonlySet<Instance>,
  retained: ReadonlySet<Resource | undefined>,
): Resource[] {
  const dependencies = new Map<Resource, Set<Resource>>();

  for (const instance of instances) {
    if (!instance.resource || retained.has(instance.resource)) {
      continue;
    }

    const children = dependencies.get(instance.resource) ?? new Set<Resource>();
    dependencies.set(instance.resource, children);

    for (const dependency of instance.dependencies) {
      if (dependency.resource && !retained.has(dependency.resource)) {
        children.add(dependency.resource);
      }
    }
  }

  const visited = new Set<Resource>();
  const order: Resource[] = [];

  const visit = (resource: Resource) => {
    if (visited.has(resource)) {
      return;
    }

    visited.add(resource);

    for (const child of dependencies.get(resource) ?? []) {
      visit(child);
    }

    order.push(resource);
  };

  for (const resource of dependencies.keys()) {
    visit(resource);
  }

  return order.reverse();
}

export class Cyrene<const TRipples extends DependencyEntries = {}> {
  #ripples: Readonly<TRipples>;
  readonly #roots = new Set<Resolvable>();
  readonly #adHocRoots = new Set<Resolvable>();
  readonly #graph = new RuntimeGraph();
  #graphReady = false;
  readonly #cache = new Map<object, Instance>();
  readonly #instances = new Set<Instance>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #resources = new Map<object, Resource>();
  #state: 'active' | 'disposing' | 'disposed' = 'active';
  #startup?: Promise<void>;
  #disposal?: Promise<void>;
  #mutation?: Promise<unknown>;
  #mutationPhase?: 'draining' | 'changing' | 'rebuilding';

  constructor(options: CyreneOptions<TRipples> = {}) {
    const ripples = options.ripples ?? {};
    assertRipples(ripples);
    this.#ripples = Object.freeze(
      Array.isArray(ripples) ? [...ripples] : { ...ripples },
    ) as Readonly<TRipples>;

    for (const target of Object.values(this.#ripples)) {
      this.#roots.add(target);
    }
  }

  start(): Promise<void> {
    if (this.#state !== 'active') {
      return Promise.reject(new DisposedError('Cyrene is disposing or disposed'));
    }

    if (this.#startup) {
      return this.#startup;
    }

    if (this.#mutation) {
      return Promise.reject(new InvalidDependencyError('Graph mutation in progress'));
    }

    this.#startup = this.#track(
      Promise.resolve().then(async () => {
        // 启动入口保留数组中的重复项, transient 每次声明都创建独立实例
        const ripples: Resolvable[] = Object.values(this.#ripples);
        // 全部入口统一校验后才开始初始化, 避免后面的入口无效却已产生副作用
        this.#ensureGraph();
        await settle(ripples.map(target => this.#resolveTarget(target, undefined, [])));
      }),
    );
    return this.#startup;
  }

  resolve<T>(target: Resolvable<T>): Promise<T> {
    if (this.#state !== 'active') {
      return Promise.reject(new DisposedError('Cyrene is disposing or disposed'));
    }

    if (this.#mutation) {
      return Promise.reject(new InvalidDependencyError('Graph mutation in progress'));
    }

    return this.#track(
      Promise.resolve().then(async () => {
        this.#ensureGraph();

        if (!this.#graph.nodes.has(target)) {
          throw new InvalidDependencyError('Target is not attached; call add() first');
        }

        const value = await this.#resolveTarget(target, undefined, []);

        // 直接交给调用者的实例可能继续被使用, 剪枝时视作独立入口
        if (!this.#roots.has(target)) {
          this.#adHocRoots.add(target);
        }

        return value;
      }),
    ) as Promise<T>;
  }

  add<T>(target: Resolvable<T>): Promise<T> {
    return this.#mutate(async () => {
      await this.#requireStarted();
      this.#ensureGraph();
      const existingNodes = new Set(this.#graph.nodes.keys());
      this.#graph.attach(target);

      const previous = new Set(this.#instances);

      try {
        this.#mutationPhase = 'rebuilding';
        const value = (await this.#resolveTarget(target, undefined, [])) as T;
        this.#roots.add(target);
        this.#adHocRoots.delete(target);
        return value;
      } catch (error) {
        await this.#drain();
        this.#mutationPhase = 'changing';
        // 注册失败时回收本次独占的新实例, 已有入口保持原状
        const created = new Set([...this.#instances].filter(instance => !previous.has(instance)));
        const existingResources = new Set([...previous].map(instance => instance.resource));
        const preserved = new Set<Instance>();

        const queue = [...created].filter(
          instance => instance.resource && existingResources.has(instance.resource),
        );

        // 保留服务可能在本次初始化期间激活 lazy, 这些依赖不属于失败入口独占
        for (const instance of previous) {
          for (const dependency of instance.dependencies) {
            if (created.has(dependency)) {
              queue.push(dependency);
            }
          }
        }

        // 新别名若指向已有资源, 它新建的依赖也必须留到整体释放
        for (let index = 0; index < queue.length; index++) {
          const instance = queue[index]!;

          if (preserved.has(instance)) {
            continue;
          }

          preserved.add(instance);

          for (const dependency of instance.dependencies) {
            if (created.has(dependency)) {
              queue.push(dependency);
            }
          }
        }

        const cleanup = new Set([...created].filter(instance => !preserved.has(instance)));

        try {
          await this.#release(cleanup);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Failed to add and clean up dependency');
        } finally {
          this.#graph.detach(
            new Set([...this.#graph.nodes.keys()].filter(item => !existingNodes.has(item))),
          );
        }

        throw error;
      }
    });
  }

  remove(target: Resolvable): Promise<void> {
    return this.#remove(target, false);
  }

  prune(target: Resolvable): Promise<void> {
    return this.#remove(target, true);
  }

  override<T>(target: Resolvable<T>, replacement: Resolvable<T>): Promise<void> {
    return this.#mutate(async () => {
      await this.#requireStarted();
      this.#ensureGraph();

      if (!this.#graph.nodes.has(target)) {
        throw new InvalidDependencyError('Target is not attached');
      }

      if (target === replacement) {
        return;
      }

      const affected = this.#graph.consumersOf(target);

      const instances = new Set(
        [...this.#instances].filter(instance => affected.has(instance.target)),
      );

      const retained = new Set(
        [...this.#instances]
          .filter(instance => !instances.has(instance))
          .map(instance => instance.resource),
      );

      if ([...instances].some(instance => instance.resource && retained.has(instance.resource))) {
        throw new InvalidDependencyError(
          'Cannot override a resource shared with retained instances',
        );
      }

      // 先验证替代闭包和环; 验证失败时原有实例完全不受影响。
      this.#graph.replace(target, replacement);

      let releaseError: unknown;

      try {
        // override 只替换已初始化的 consumer; 旧依赖即使失去图入口也不自动释放。
        await this.#release(instances);
      } catch (error) {
        releaseError = error;
      }

      // 重建入口, lazy 分支按需恢复, 不重放历史 transient 实例
      this.#mutationPhase = 'rebuilding';
      // 即使 disposer 报错, 仍尝试恢复新图中的受影响入口。
      const roots = [...this.#allRoots()].filter(root => affected.has(root));
      let rebuildError: unknown;

      try {
        await settle(roots.map(root => this.#resolveTarget(root, undefined, [])));
      } catch (error) {
        rebuildError = error;
      }

      if (releaseError && rebuildError) {
        throw new AggregateError([releaseError, rebuildError], 'Failed to override dependency');
      }

      if (releaseError) {
        throw releaseError;
      }

      if (rebuildError) {
        throw rebuildError;
      }
    });
  }

  validate(target?: Resolvable): void {
    this.inspect(target);
  }

  inspect(target?: Resolvable): DependencyGraph {
    this.#assertActive();
    this.#ensureGraph();

    if (target === undefined) {
      return this.#graph.snapshot([...this.#allRoots()], true);
    }

    if (this.#graph.nodes.has(target)) {
      return this.#graph.snapshot([target]);
    }

    // 单独查看未接入的定义时借用同一图, 完成后撤销临时节点。
    const existing = new Set(this.#graph.nodes.keys());
    this.#graph.attach(target);

    try {
      return this.#graph.snapshot([target]);
    } finally {
      this.#graph.detach(
        new Set([...this.#graph.nodes.keys()].filter(item => !existing.has(item))),
      );
    }
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

  #allRoots(): Set<Resolvable> {
    return new Set([...this.#roots, ...this.#adHocRoots]);
  }

  #ensureGraph(): void {
    if (this.#graphReady) {
      return;
    }

    const existing = new Set(this.#graph.nodes.keys());

    try {
      for (const target of this.#roots) {
        this.#graph.attach(target);
      }

      this.#graphReady = true;
    } catch (error) {
      this.#graph.detach(
        new Set([...this.#graph.nodes.keys()].filter(item => !existing.has(item))),
      );
      throw error;
    }
  }

  async #requireStarted(): Promise<void> {
    if (!this.#startup) {
      throw new InvalidDependencyError('Start Cyrene before changing its graph');
    }

    await this.#startup;
  }

  async #drain(): Promise<void> {
    while (this.#pending.size) {
      await Promise.allSettled(this.#pending);
    }
  }

  #mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.#state !== 'active') {
      return Promise.reject(new DisposedError('Cyrene is disposing or disposed'));
    }

    if (this.#mutation) {
      return Promise.reject(new InvalidDependencyError('Graph mutation in progress'));
    }

    this.#mutationPhase = 'draining';

    const promise = (async () => {
      // 图变更开始前等待已接收的解析完成, 此后拒绝新的外部解析入口
      while (this.#pending.size) {
        await Promise.allSettled(this.#pending);
      }

      this.#mutationPhase = 'changing';

      try {
        return await action();
      } finally {
        // 重建阶段允许存活句柄解析, 返回前等待它们结束
        await this.#drain();
      }
    })();

    this.#mutation = promise;

    const finish = () => {
      this.#mutation = undefined;
      this.#mutationPhase = undefined;
    };

    void promise.then(finish, finish);
    return promise;
  }

  #remove(target: Resolvable, prune: boolean): Promise<void> {
    return this.#mutate(async () => {
      await this.#requireStarted();

      const roots = this.#allRoots();
      this.#ensureGraph();
      const removing = this.#graph.planRemoval(target, roots, prune);

      const instances = new Set(
        [...this.#instances].filter(instance => removing.has(instance.target)),
      );

      // 共享对象仍被保留实例持有时, 不能提前释放它或其依赖
      const retained = new Set(
        [...this.#instances]
          .filter(instance => !instances.has(instance))
          .map(instance => instance.resource),
      );

      if ([...instances].some(instance => instance.resource && retained.has(instance.resource))) {
        throw new InvalidDependencyError('Cannot remove a resource shared with retained instances');
      }

      try {
        await this.#release(instances);
      } finally {
        this.#graph.detach(removing);

        for (const item of removing) {
          this.#roots.delete(item);
          this.#adHocRoots.delete(item);
        }
      }
    });
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

    const replacement = this.#graph.replacementOf(target);

    if (replacement) {
      return this.#resolveTarget(replacement, owner, [...path, targetName(target)]);
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

            const dependencies = Array.isArray(definition.inputs)
              ? values.map(result => result.value)
              : Object.fromEntries(inputs.map(([key], index) => [key, values[index]!.value]));

            const value = await definition.invoke(dependencies, isRef(target) ? target.params : []);

            created.value = value;
            created.resource = this.#resourceFor(value);
            this.#configureDisposer(created.resource, value, definition.options.dispose);
            created.state = 'ready';
            return value;
          } catch (cause) {
            created.state = 'failed';

            // 已返回资源的失败别名仍携带依赖关系, 清理时不能丢弃
            if (!created.resource) {
              this.#instances.delete(created);
            }

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
      const target = this.#graph.lazyTargetOf(owner.target, input);
      return {
        value: Object.freeze({
          resolve: () => {
            if (this.#state !== 'active') {
              return Promise.reject(new DisposedError('Cyrene is disposing or disposed'));
            }

            if (this.#mutationPhase === 'changing' || !this.#instances.has(owner)) {
              return Promise.reject(
                new InvalidDependencyError('Lazy dependency is no longer active'),
              );
            }

            if (!this.#graph.nodes.has(target)) {
              return Promise.reject(new InvalidDependencyError('Lazy target is not attached'));
            }

            return this.#track(
              Promise.resolve().then(() => {
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

    if (isDependency(input) || isRef(input)) {
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

  #resourceFor(value: unknown): Resource {
    if (!isObject(value)) {
      return { dependencies: new Set() };
    }

    let resource = this.#resources.get(value);

    if (!resource) {
      resource = { dependencies: new Set() };
      this.#resources.set(value, resource);
    }

    return resource;
  }

  #configureDisposer(
    resource: Resource,
    value: unknown,
    dispose?: (value: unknown) => void | Promise<void>,
  ): void {
    if (dispose) {
      if (resource.explicitDispose && resource.explicitDispose !== dispose) {
        throw new InvalidDependencyError('Conflicting disposers for the same resource');
      }

      resource.explicitDispose = dispose;
      resource.dispose = () => dispose(value);
      return;
    }

    if (!isObject(value) || resource.dispose) {
      return;
    }

    const method = Reflect.get(value, Symbol.asyncDispose) ?? Reflect.get(value, Symbol.dispose);

    if (typeof method === 'function') {
      resource.dispose = () => method.call(value);
    }
  }

  async #release(instances: ReadonlySet<Instance>): Promise<void> {
    const retained = new Set(
      [...this.#instances]
        .filter(instance => !instances.has(instance))
        .map(instance => instance.resource),
    );

    const errors: unknown[] = [];

    for (const resource of removalOrder(instances, retained)) {
      if (!resource.dispose) {
        continue;
      }

      try {
        await resource.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const instance of instances) {
      if (this.#cache.get(instance.target) === instance) {
        this.#cache.delete(instance.target);
      }

      if (isObject(instance.value) && instance.resource && !retained.has(instance.resource)) {
        this.#resources.delete(instance.value);
      }

      instance.dependencies.clear();
      instance.waitingFor.clear();
      instance.resource = undefined;
      instance.value = undefined;
      this.#instances.delete(instance);
    }

    if (errors.length) {
      throw new AggregateError(errors, 'Failed to dispose removed resources');
    }
  }

  async #dispose(): Promise<void> {
    if (this.#mutation) {
      await Promise.allSettled([this.#mutation]);
    }

    // 已接收的任务仍可能创建间接依赖, 持续等待直到没有在途任务
    while (this.#pending.size) {
      await Promise.allSettled(this.#pending);
    }

    const instances = new Map<Instance, Resource>();

    const collect = (instance: Instance): Resource => {
      const existing = instances.get(instance);

      if (existing) {
        return existing;
      }

      const resource = instance.resource ?? { dependencies: new Set<Resource>() };
      instances.set(instance, resource);

      for (const dependency of instance.dependencies) {
        const child = collect(dependency);

        if (child !== resource) {
          resource.dependencies.add(child);
        }
      }

      return resource;
    };

    for (const instance of this.#instances) {
      collect(instance);
    }

    const visited = new Set<Resource>();
    const order: Resource[] = [];

    const visit = (resource: Resource) => {
      if (visited.has(resource)) {
        return;
      }

      visited.add(resource);

      for (const dependency of resource.dependencies) {
        visit(dependency);
      }

      order.push(resource);
    };

    for (const resource of instances.values()) {
      visit(resource);
    }

    const errors: unknown[] = [];

    // 后序遍历反转后先释放消费者, visited 同时避免延迟资源环重复遍历
    for (const resource of order.reverse()) {
      if (!resource.dispose) {
        continue;
      }

      try {
        await resource.dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    for (const resource of order) {
      resource.dependencies.clear();
      resource.dispose = undefined;
      resource.explicitDispose = undefined;
    }

    for (const instance of instances.keys()) {
      instance.dependencies.clear();
      instance.waitingFor.clear();
      instance.value = undefined;
      instance.resource = undefined;
      instance.promise = Promise.resolve();
    }

    this.#ripples = Object.freeze({}) as Readonly<TRipples>;
    this.#roots.clear();
    this.#adHocRoots.clear();
    this.#graph.detach(new Set(this.#graph.nodes.keys()));
    this.#cache.clear();
    this.#instances.clear();
    this.#resources.clear();
    this.#startup = undefined;
    this.#state = 'disposed';

    if (errors.length) {
      throw new AggregateError(errors, 'Failed to dispose Cyrene resources');
    }
  }
}
