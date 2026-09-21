# Cyrene 设计架构

Cyrene 是面向 TypeScript 的声明式依赖图 Runtime。一个 Cyrene 就是一个独立运行作用域：构造时声明入口与外部能力，之后启动、按需解析、释放。依赖显式、类型安全、支持异步初始化，不依赖装饰器、反射或框架。

## 1. 最终 API

```ts
const Config = token<{ databaseUrl: string }>('Config');
const logger = ripple({}, (_dependencies, options: { scope: string }) => new Logger(options.scope));
const database = ripple(
  { config: Config, logger: logger({ scope: 'database' }) },
  async ({ config, logger }) => {
    const database = new Database(config.databaseUrl, logger);
    await database.connect();
    return database;
  },
  { dispose: database => database.close(), debugName: 'Database' },
);
const users = ripple(
  { database, logger: logger({ scope: 'users' }) },
  ({ database, logger }) => new UserService(database, logger),
);
const app = new Cyrene({
  providers: { database, users },
  bindings: [{ token: Config, value: { databaseUrl: 'postgres://localhost/app' } }],
});
const services = await app.start();
// services.database: Database; services.users: UserService
await app.dispose();
```

| API                                 | 职责                                   |
| ----------------------------------- | -------------------------------------- |
| ripple(inputs, factory, options?)   | 返回可调用的依赖定义                   |
| defineProviders(providers)          | 约束并标记命名入口集合                 |
| isRipple(value)                     | 判断是否带有 Ripple 定义标识           |
| isRippleProviders(value)            | 判断是否带有入口集合标识               |
| dependency(...params)               | 记录参数，创建新的 DependencyRef       |
| token<T>(name)                      | 声明外部能力身份                       |
| lazy(() => target)                  | 声明延迟依赖边                         |
| new Cyrene({ providers, bindings }) | 创建独立作用域，快照保存入口和绑定     |
| cyrene.start()                      | 校验并初始化全部命名入口，返回对应实例 |
| cyrene.resolve(target)              | 按需解析单个目标                       |
| cyrene.validate(target?)            | 校验单个目标或全部入口，不执行 factory |
| cyrene.inspect(target?)             | 返回单个目标或全部入口的依赖图         |
| cyrene.dispose()                    | 释放持有的资源                         |

不提供 bind()、add()、createScope()、CyreneScope 或 scoped lifetime，不保留兼容接口。

## 2. Dependency 与参数

ripple 统一使用依赖映射、factory、可选配置，没有依赖时显式传 {}。factory 的第一个参数由 Cyrene 注入，后续参数由调用者提供。泛型元组推导参数，具体 factory 声明实际参数，不统一写 ...args: any[]。异步结果由 Awaited 解包。

```ts
const client = ripple(
  { config: Config },
  ({ config }, name: string, timeout: number, retry = 3) =>
    new Client(config, name, timeout, retry),
);
const github = client('github', 5000);
```

所有 Dependency 在运行时和类型层均可调用。调用只创建 Ref，不执行 factory。无参数定义可以直接引用，也可调用创建独立 Ref：

```ts
await app.resolve(database);
const separateDatabase = database();
await app.resolve(separateDatabase);
```

带参数定义必须先调用生成 Ref，不能作为裸入口、裸依赖或解析目标。只有可选参数或 rest 参数的定义也显式调用。TypeScript 校验参数；运行时不使用 factory.length 猜测被擦除的参数类型，JavaScript 使用者遵守相同约定。

## 3. Identity 与输入

直接引用无参数 Dependency 时以定义对象为 identity；Ref 以 Ref 对象为 identity，包括无参数 Ref。每次调用创建新 identity，不做参数深比较、哈希或自动合并。共享缓存实例必须复用同一引用。Token 查找绑定后沿用绑定目标的缓存策略。

输入支持 Dependency、Ref、Token、LazyRef 及普通对象、函数、class 和值。只解析映射顶层带内部 brand 的值；普通对象不递归解析，普通函数不自动执行。factory 返回函数也作为普通实例值。

依赖映射和配置浅拷贝后保存为只读 metadata。参数元组快照保存，但普通对象值和参数对象不深拷贝。

## 4. providers 与 bindings

providers 是命名入口映射，每个值必须是可解析目标：无参数 Dependency、DependencyRef 或 Token。start 初始化所有入口及其非 lazy 可达依赖，返回值保留入口名称并推导实例类型。入口名不参与 identity。

入口使用自身可枚举的字符串键。类型层拒绝数字键和 Symbol 键；JavaScript 数字属性在运行时已转换为字符串，按字符串入口处理。运行时拒绝 Symbol 键与自身不可枚举入口，内部集合标识除外，避免静默忽略声明。依赖 inputs 仍支持 Symbol 键。

defineProviders 在原对象上添加不可枚举、不可修改、不可删除的内部标识，返回原对象并保留类型推导。它校验入口形状及目标身份，不校验尚未绑定的依赖图，也不冻结集合。首次标记需要可扩展对象；已经标记的集合可以重复传入。组合使用对象展开后重新调用 defineProviders；标识本身不随展开复制。普通入口对象仍可直接传给 Cyrene。

defineProviders 不是模块系统，不引入 imports、exports、注册顺序或独立生命周期。内部 RIPPLE_SYMBOL 与 RIPPLE_PROVIDERS_SYMBOL 不从包入口导出；isRipple 与 isRippleProviders 只判断自身标识严格等于 true，不表示目标可由当前运行时解析。

v0 要求依赖定义、Ref、Token、LazyRef 与 Cyrene 共享同一份运行时模块。Symbol.for 标识可以跨副本识别，但 metadata 不跨副本共享；跨副本解析不受支持。插件应复用宿主的 cyrenejs 依赖。

bindings 专门提供 Token 的外部实现：

```ts
type Binding<T = unknown> =
  | { token: Token<T>; value: T; dependency?: never }
  | { token: Token<T>; dependency: Resolvable<T>; value?: never };
```

绑定必须且只能包含 value 或 dependency。同一 Token 重复绑定拒绝，名称相同但 identity 不同的 Token 是不同能力。value: undefined 合法，按属性存在性区分。

复杂构造统一使用 ripple。未被入口引用的 dependency binding 不主动初始化。函数 value 不执行，所有外部 value 不自动 dispose。

构造函数推导 bindings 元组，逐项校验 Token 与 value/dependency 的实例类型。单独声明绑定时也可以使用 satisfies Binding<Config>。如果使用方提前把列表擦除为 Binding[]，关联类型信息就会丢失；运行时无法恢复被擦除的 TypeScript 类型。

构造时浅拷贝并冻结入口映射及绑定声明；原始映射或绑定列表的后续修改无效，普通对象值保留引用。构造不执行 factory，不支持后续添加入口。

## 5. 独立运行作用域

```ts
interface CyreneOptions<
  TProviders extends DependencyEntries = {},
  TBindings extends readonly Binding[] = readonly Binding[],
> {
  providers?: TProviders & ValidProviders<TProviders>;
  bindings?: TBindings & ValidBindings<TBindings>;
}
class Cyrene<
  TProviders extends DependencyEntries = {},
  const TBindings extends readonly Binding[] = readonly Binding[],
> {
  constructor(options?: CyreneOptions<TProviders, TBindings>);
  start(): Promise<ResolveEntries<TProviders>>;
  resolve<T>(target: Resolvable<T>): Promise<T>;
  validate(target?: Resolvable<unknown>): void;
  inspect(target?: Resolvable<unknown>): DependencyGraph;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

没有 providers 时 start 返回空对象。需要独立生命周期，就创建另一个 Cyrene；没有父子查找、继承或递归启动。共享实例显式通过 Token value 传入：

```ts
const task = new Cyrene({
  providers: { job },
  bindings: [{ token: Database, value: services.database }],
});
await task.start();
await task.dispose();
await app.dispose();
```

消费者先结束，再释放共享资源的原持有者。支持 await using，不依赖隐式全局上下文。

## 6. start 与 resolve

start 首次调用记录唯一 Promise；收集构造时声明的全部入口，统一校验可达图，然后先依赖后消费者初始化，独立分支可并行。等待所有入口分支结束后返回命名实例；多个错误由 AggregateError 汇总。

启动不扫描其他定义或其他 Cyrene，lazy 目标不提前初始化。并发及后续 start 返回同一个 Promise，包括成功和失败，不重复创建 transient 入口。失败时等待已开始的分支结束，成功创建的资源仍由 Cyrene 持有直到 dispose。

resolve 在启动前后均可使用，不增加入口。先校验目标图，再解析，与 start 共用缓存和并发去重。singleton 的初始化 Promise 先缓存再运行 factory，成功缓存结果，失败删除状态，后续 resolve 可以重试，但不重置 start 的失败结果。

## 7. Lifetime

```ts
type Lifetime = 'singleton' | 'transient';
```

默认 singleton：每个 Cyrene 内按 identity 缓存，不是进程全局。不同 Cyrene 始终隔离。

transient：每次解析创建，由当前 Cyrene 持有。被 singleton 引用的 transient 随消费者存活，不额外禁止这种捕获。重复 start 复用自身结果，显式 resolve transient 仍每次创建。

scoped 与单个 Cyrene 内的 singleton 重合，因此删除。

## 8. Lazy 与循环

```ts
const a = ripple({ b: lazy(() => b) }, ({ b }): A => new A(b));
const b = ripple({ a }, ({ a }): B => new B(a));
interface Lazy<T> {
  resolve(): Promise<T>;
}
```

强依赖环在 factory 执行前抛 CircularDependencyError。lazy 边不参与强初始化环，也不提前实例化目标。validate/inspect 可以求值 lazy 的声明 thunk，但不运行 factory；thunk 必须无副作用且返回稳定目标。lazy 可达图仍校验缺失绑定、非法目标和纯强依赖环。

注入的 Lazy 绑定当前 Cyrene。显式 Lazy.resolve 才解析目标并记录实际资源依赖边。factory 在初始化期间主动等待 lazy 目标，如果形成运行时等待环，必须报错而不是挂起。递归定义必要时由使用方补结果类型。

## 9. Ownership 与 dispose

factory 返回值由当前 Cyrene 管理，但 bindings.value 中的对象或函数始终视为借用资源，即使绑定未使用、或 factory 原样返回同一引用，也不自动释放。对借用对象配置显式 dispose 会使该次解析失败，cause 为 InvalidDependencyError，不转移所有权。仅比较顶层对象身份，不递归推断包装对象、嵌套字段或 Promise 解包后的资源归属；外部资源应直接作为 value 提供，异步构造使用 dependency binding。

对象和函数按返回值引用合并为资源节点，同一资源最多清理一次；原始值按每次实例记录分别清理。合并所有别名的实际依赖边后，再计算资源释放顺序，避免某个别名导致资源早于其他消费者被释放。

释放优先级：options.dispose → Symbol.asyncDispose → Symbol.dispose，只执行一个。

同一资源的显式 dispose 优先于所有别名的自动清理方法，与初始化完成顺序无关。多个别名使用同一显式函数引用合法；不同显式函数引用视为冲突，后完成的解析以 ResolutionError 失败，cause 为 InvalidDependencyError。已登记的清理方法保留，冲突别名的依赖边也保留，最终仍统一清理。不能依赖并发顺序选择冲突函数，调用者应复用同一个 disposer。

dispose 首次调用立即禁止新的 start/resolve，等待已经开始的初始化结束，再按合并后的实际资源依赖边先消费者后依赖释放。lazy 激活或对象别名合并造成资源环时无法严格拓扑排序，确定性打破环，仍每个资源只释放一次。

清理失败继续释放其他资源，最后抛 AggregateError。重复 dispose 返回相同 Promise，包括失败结果；完成后清空缓存与持有引用。释放期间和之后解析抛 DisposedError。

## 10. 诊断

错误类型：CyreneError、CircularDependencyError、MissingBindingError、InvalidDependencyError、ResolutionError、DisposedError。多个并行错误和释放错误使用原生 AggregateError。

ResolutionError 保留 cause 与依赖路径。debugName 为可选手工标签，Token 名称仅用于诊断。

inspect 返回 nodes/edges，节点包括 Dependency、Ref、Token，边区分强依赖、lazy 及 Ref 的定义关系。参数保留为 Ref metadata，不生成参数节点。不会执行 factory。

## 11. v0 范围

实现 callable Dependency、Ref、Token、binding、lazy、命名入口启动、按需解析、validate/inspect、两种 lifetime、并发去重、失败重试和资源释放。

暂不实现插件 hooks、DevTools、自动命名 transform、子作用域、动态入口、装饰器、扫描、Proxy、可选 Token 或框架适配器。

每次 resolve 都会重新校验目标图，包括 lazy 可达图；暂不缓存校验结果。transient 创建的资源会被当前 Cyrene 持有直到整体释放，高频短任务应使用独立 Cyrene 控制生命周期。dispose 不提供超时或取消，未结束的初始化会延长清理等待；这两类优化需根据实际负载另行设计。

测试覆盖类型推导、普通值函数、identity、入口统一校验、未使用的绑定、并发失败、lazy 循环、资源归属/顺序及初始化与释放竞争。使用 vp check、vp test、vp pack 验证，vp run ready 聚合执行。
