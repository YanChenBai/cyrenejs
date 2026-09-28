<h1 align="center">Cyrene</h1>

<p align="center">
  让依赖关系留在代码里, 让初始化与释放交给运行时
</p>

<p align="center">
  <a href="#quick-start">快速开始</a> ·
  <a href="#features">能力一览</a> ·
  <a href="#agent">Agent</a> ·
  <a href="./docs/CYRENE_DESIGN.md">设计文档</a> ·
  <a href="#development">参与开发</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cyrenejs"><img src="https://img.shields.io/npm/v/cyrenejs?style=flat&labelColor=18212f&color=a78bfa" alt="npm 版本" /></a>
  <img src="https://img.shields.io/badge/TypeScript-type_safe-3178c6?style=flat&labelColor=18212f" alt="TypeScript 类型推导" />
  <img src="https://img.shields.io/badge/module-ESM-a78bfa?style=flat&labelColor=18212f" alt="ESM 模块" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.0.0-5fa777?style=flat&labelColor=18212f" alt="Node.js 22.0.0 及以上" />
</p>

<br />

构造一个服务, 往往也意味着准备配置, 连接数据库, 等待初始化, 并在结束时把资源逐一释放

**Cyrene 把这些关系写成一张显式的依赖图**, 由 TypeScript 推导输入与实例类型, 由运行时负责解析, 缓存和清理

一个 `Cyrene` 就是一个独立运行作用域, 首次解析前注册服务和替换实现, 按需创建真实实例

<a id="quick-start"></a>

## 🌱 快速开始

安装公开包 `cyrenejs`:

```sh
npm install cyrenejs
```

也可以使用 `pnpm add cyrenejs` 或 `vp add cyrenejs`

需要 Node.js 22.0.0 及以上, 包提供 ESM 入口和 TypeScript 类型声明
下面的 TypeScript 示例使用 `await using`, 请通过支持该语法的运行时或 TypeScript 工具链运行; 也可以使用 `try/finally` 配合 `await app.dispose()` 显式释放资源

```ts
import { Cyrene, ripple } from 'cyrenejs';

const Config = ripple(() => ({ prefix: 'app' }));

const Logger = ripple({ config: Config }, ({ config }) => ({
  format: (message: string) => `[${config.prefix}] ${message}`,
}));

const Users = ripple({ logger: Logger }, ({ logger }) => ({
  describe: () => logger.format('users'),
}));

await using app = new Cyrene().add({ config: Config, logger: Logger }).add('users', Users);

app.override(
  'config',
  ripple(() => ({ prefix: 'demo' })),
);

const users = app.ripples.users;
users.describe(); // [demo] users
```

`add()` 只注册声明, 首次读取 `app.ripples.key` 时才创建目标及其强依赖
同步服务直接返回实例, 异步服务返回 Promise; `resolve(key)` 和 `resolve(Ripple)` 遵循同样的规则

<a id="features"></a>

## ✨ 能力一览

- **依赖显式** - 用 `ripple()` 描述依赖和工厂, 普通输入值原样传递
- **类型推导** - 工厂输入与实例类型自动推导, 链式 `add()` 累积注册 key 的类型
- **异步初始化** - 独立分支并行执行, 并发解析共享同一次单例初始化
- **首次解析前替换** - `override()` 更换尚未执行的配方, 首次解析前自动校验完整依赖图
- **延迟解析** - `lazy()` 提供解析句柄, 按目标生命周期创建实例
- **统一清理** - 按逆创建顺序释放资源, 支持 Symbol 清理协议和 `await using`

## 🫧 定义, 引用与实例

```text
ripple(factory)        → 声明无依赖服务
ripple(deps, factory)  → 声明带依赖服务
app.add(entries)      → 批量注册命名服务
app.add(key, ripple)  → 注册单个服务
app.ripples.key       → 按需获取真实实例
app.resolve(key)      → 获取真实实例
app.resolve(Ripple)   → 通过声明获取真实实例
app.dispose()         → 释放容器持有的资源
```

Ripple 不携带 ID, 名称由 `app.add()` 决定; 使用无参数的 `new Cyrene()` 创建容器
声明不可调用, 依赖通过 Ripple 对象表达; 普通输入和嵌套对象保持原样

支持 `lifetime?: 'singleton' | 'transient'`, 默认即为 singleton
singleton 在同一容器共享实例, transient 每次解析重新执行工厂; 两者都支持同步或异步工厂

```ts
const logger = (scope: string) => ripple(() => ({ scope }), { lifetime: 'singleton' });

const app = new Cyrene()
  .add('auditLogger', logger('audit'))
  .add('requestLogger', logger('request'));
```

## 注册与组合

两种 `add()` 都修改并返回同一个容器, 也可以分开调用:

```ts
const app = new Cyrene();
app.add({ config: Config, logger: Logger });
app.add('users', Users);
const users = app.resolve(Users);
```

> [!TIP]
> 链式调用或接住 `add()` 的返回值, 才能累积注册 key 的类型
> 分开追加并丢弃返回值时, TypeScript 无法改变原变量的泛型, `app.ripples` 不会出现新增 key 的类型提示
> 此时使用 `app.resolve(Users)` 可以从声明推导类型; `app.resolve('users')` 仍可解析, 但返回 `unknown`
> 追加注册仅限首次解析前, 读取 `app.ripples.key` 后也会锁定注册表

```ts
const app = new Cyrene().add({ config: Config, logger: Logger }).add('users', Users);

app.ripples.users.describe(); // 链式注册保留 users 的类型提示
```

所有 Ripple 依赖都必须显式注册, 同一容器中 key 不可重复, 一个 Ripple 只能占用一个 key
注册阶段仅保存声明, 不构建依赖图; 首次解析或显式诊断时编译, 配置未变更则复用结果。

分批注册不要求依赖顺序, 可以先注册消费者, 再注册依赖; 相互 lazy 引用也可以分批添加

组合服务直接使用普通对象和对象展开:

```ts
const infrastructure = { config: Config, logger: Logger };
const app = new Cyrene().add({ ...infrastructure, users: Users });
```

`isRipple()` 用于识别由当前库创建的声明
每次 `add()` 只检查声明合法性和重复注册, 失败不会改变原注册表。首次解析时检查完整依赖图中的缺失依赖和强依赖环, 检查通过后才执行工厂

## 查看依赖图

`inspect()` 返回节点和边的快照, 不会执行工厂
`formatGraph()` 将快照转换为终端文本, 由调用方决定打印或写入文件:

```ts
import { formatGraph } from 'cyrenejs';

console.log(formatGraph(app.inspect()));
```

`inspect()` 会显式检查当前依赖图, 但不会锁定配置或执行工厂; 依赖尚未补齐时会报错。

节点只包含注册 `key` 和初始化 `state`; 边标明消费者, 输入属性, 目标与初始化策略
`↗` 表示已展开的共享节点, `↻` 表示当前路径中的循环引用
空图输出 `(empty graph)`

## 🔄 首次解析前替换

`app.override(key, replacement)` 同步更换配方并返回容器, 新依赖和循环留到首次解析或显式诊断时检查
原声明与当前替身都定位这个 key, 新依赖可以稍后添加, 但必须在首次解析前注册
在类型已累积的容器上, 替身结果必须兼容原服务类型, 并保持原声明的同步/异步契约
这让已经声明的消费者和 lazy 句柄继续保有正确的返回类型
通过原声明或当前替身调用 `resolve()`, 都会使用替换后的配方和 lifetime; 未注册的声明会报错

第一次读取 `app.ripples.key` 或调用 `resolve()` 时立即锁定注册表, 即使初始化失败也不再允许配置变更
需要另一套服务时创建新的容器; 已创建的消费者始终持有原来的真实依赖

## 🔎 运行时依赖检查

`add()` 和 `override()` 允许暂时不完整或成环的配置, 不做类型层面的循环检查。
首次解析或显式调用 `inspect()` 时, 按真实声明身份检查缺失依赖和强依赖环。
TypeScript 继续检查输入、返回值和替换的同步／异步契约。
lazy 边不参与强依赖环检查, 实际初始化等待环在运行时检测。

## 🌿 延迟解析与失败处理

```ts
import { lazy, ripple } from 'cyrenejs';

const Report = ripple({ users: lazy(() => Users) }, ({ users }) => ({
  run: () => users.resolve().describe(),
}));
```

`lazy()` 回调只返回声明, 应保持稳定且无副作用
回调在首次解析或显式 `inspect()` 构图时求值; 配置未变更时复用构图结果。强依赖环在工厂执行前校验, 实际异步等待环在运行时检测

读取 `app.ripples.key` 或调用 `resolve()` 时, 未使用的 lazy 目标不初始化
没有 `start()` / `init()`, 也不会预先创建全部注册项

工厂通过 deps / lazy 表达依赖, 避免在工厂内等待同一容器的公共解析或关闭操作而形成自等待

初始化期间, 仅调用异步 lazy 的 `resolve()` 不建立等待边; `await`、返回给异步工厂或调用 `then` / `catch` / `finally` 时才登记
此时句柄按目标实例复用 Promise 包装, 与公共解析入口的 Promise 身份不同; 消费者就绪后直接返回解析结果
回调链也计入等待关系, 即使调用方只用它观察结果

同步创建失败直接抛错, 异步创建失败通过 Promise 拒绝; singleton 缓存失败, transient 下次解析重新创建
解析失败保留已创建资源以便诊断, 调用方负责 `dispose()`
未知 key, 未注册声明或关闭后的访问会同步抛错

## ⏳ 同步与异步

工厂和全部强依赖都同步时, 直接返回实例; 工厂或任意强依赖异步时, 返回 Promise
异步性沿强依赖传播, 工厂收到的依赖仍然是已经创建好的实例
lazy 目标的异步性不影响消费者, 只影响句柄 `resolve()` 的返回值
普通 Promise 输入原样传递, 不视为异步依赖

```ts
const Config = ripple(() => ({ name: 'demo' }));
const Database = ripple(async () => ({ query: () => ['Alice'] }));
const Users = ripple({ database: Database }, ({ database }) => ({
  list: () => database.query(),
}));
const app = new Cyrene().add({ config: Config, database: Database, users: Users });

app.ripples.config.name; // 同步, 无需 await
const users = await app.ripples.users; // 强依赖异步, 需要 await
users.list();
await app.dispose();
```

属性入口只读, 返回真实实例; 同一异步单例完成后仍返回同一个 Promise
工厂返回 `T | Promise<T>` 时, 解析结果也保留该联合类型; 擦除声明类型后可能需要 `await`

## 🌱 Transient 与创建时机

`transient` 适合需要独立可变状态的工作对象, 如每次任务的收集器或构建器
它保证每次解析重新执行工厂; 如果工厂主动返回同一对象, 容器不会复制该对象

```ts
const Job = ripple(() => ({ messages: [] as string[] }), { lifetime: 'transient' });
const Worker = ripple({ job: Job }, ({ job }) => ({ job }));
const Runner = ripple({ job: lazy(() => Job) }, ({ job }) => ({
  createJob: () => job.resolve(),
}));
const app = new Cyrene().add({ job: Job, worker: Worker, runner: Runner });

app.resolve(Job) !== app.resolve(Job); // 每次创建
app.ripples.worker.job === app.ripples.worker.job; // singleton 保留首次注入
app.ripples.runner.createJob() !== app.ripples.runner.createJob(); // lazy 每次创建
await app.dispose();
```

| 操作                                                 | transient 的创建时机                         |
| ---------------------------------------------------- | -------------------------------------------- |
| `ripple()`、`add()`、`override()`、`inspect()`       | 不执行工厂                                   |
| 读取 `app.ripples.key`、调用 `resolve(key / Ripple)` | 每次解析执行工厂                             |
| 注入强依赖                                           | 消费者初始化时, 每个输入属性分别解析一次     |
| 注入 singleton                                       | singleton 首次初始化时创建, 之后持有同一引用 |
| 注入 transient                                       | 每次消费者初始化时重新创建                   |
| `lazy.resolve()`                                     | 每次调用创建, 仅注入句柄不会创建             |
| 并发异步解析                                         | 各自初始化, 返回不同 Promise, 不合并请求     |

创建时先解析强依赖, 等异步强依赖就绪后才执行工厂; transient 自身也可以共享 singleton 依赖
失败不会自动重试, 但下一次显式解析会重新尝试; singleton 依赖的失败缓存仍然有效
初始化链中递归创建同一声明会被拒绝, 避免 transient 无限展开; 就绪后的 lazy 可再次创建同声明实例
`inspect()` 的 state 表示该注册项最近一次初始化状态变化, 不枚举 transient 实例或表示全部并发任务的状态

成功返回的 owned transient 与 singleton 一样保留到容器 `dispose()` 时统一释放
不会在一次方法调用结束后自动释放, 也不提供请求级作用域; 长期运行的容器应控制创建数量

## 🍃 资源释放

`await using` 会在离开作用域时释放 Cyrene, 也可以显式调用 `await app.dispose()`

实例通过 `Symbol.asyncDispose` 或 `Symbol.dispose` 表达清理行为, 前者优先
容器按首次成功创建完成的逆序逐一等待清理, 同一对象只释放一次

```ts
const Database = ripple(async () => {
  const connection = await openConnection();

  return {
    query: connection.query.bind(connection),

    async [Symbol.asyncDispose]() {
      await connection.close();
    },
  };
});
```

示例中的 `openConnection` 由应用选择的数据库驱动提供
不带 Symbol 清理方法的实例直接跳过; 普通 `.dispose()` 和选项式清理回调不参与此协议

默认资源由容器持有; 对外部实例使用 `ownership: 'borrowed'`, 或作为普通输入传递
同一对象混用 owned / borrowed 会报所有权冲突, 清理错误聚合后报告

`dispose()` 幂等, 立即停止接收新解析, 等待已接收的初始化结束后再清理资源
强依赖先创建后释放, 消费者的清理方法仍可使用它们
后来激活的 lazy 依赖和资源别名不额外进行拓扑排序, 清理顺序仍按首次创建完成的时间决定

应用应先停止接收业务任务并等待已有任务结束, 再关闭容器
工厂返回前抛错时, 内部已分配但未交付的资源由工厂自行清理

<a id="agent"></a>

## 🤖 Agent

Cyrene 随 npm 包提供 [cyrenejs skill](./skills/cyrenejs/SKILL.md), 帮助编码 Agent 正确使用声明注册, 首次解析前替换, 延迟解析和资源释放

在使用 Cyrene 的项目中安装 `cyrenejs` 后, 可以通过 [skills-npm](https://github.com/antfu/skills-npm) 将 skill 链接到 Agent 的技能目录:

```sh
npm install -D skills-npm
npx skills-npm setup
```

`setup` 会自动检测 Agent, 完成首次同步, 并将同步命令追加到 `package.json` 的 `prepare` 脚本, 同时为生成的链接添加 `.gitignore` 规则
之后安装或更新依赖时会自动同步, 让 skill 随项目使用的包版本一起更新

如果只想手动同步, 可以运行:

```sh
npx skills-npm
```

<a id="development"></a>

## 🛠️ 参与开发

实现放在 [`src/`](./src), 测试放在 [`tests/`](./tests), 构建输出 ESM 与类型声明到 `dist/`

```sh
vp install
vp run ready
```

| 命令           | 用途                   |
| -------------- | ---------------------- |
| `vp check`     | 格式, lint 与类型检查  |
| `vp test run`  | 运行测试               |
| `vp pack`      | 构建 ESM 与类型声明    |
| `vp run ready` | 依次执行以上检查与构建 |

欢迎从 [设计文档](./docs/CYRENE_DESIGN.md) 和 [测试用例](./tests/) 了解行为边界
