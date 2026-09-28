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

const Config = ripple('config', () => ({ prefix: 'app' }));

const Logger = ripple('logger', { config: Config }, ({ config }) => ({
  format: (message: string) => `[${config.prefix}] ${message}`,
}));

const Users = ripple('users', { logger: Logger }, ({ logger }) => ({
  describe: () => logger.format('users'),
}));

await using app = new Cyrene().use(Users);

app.override(
  Config,
  ripple('demoConfig', () => ({ prefix: 'demo' })),
);

const users = app.ripples.users;
users.describe(); // [demo] users
```

`use()` 只登记公开入口, 其依赖会自动收集, 首次读取 `app.ripples.key` 时才创建目标及其强依赖
同步服务直接返回实例, 异步服务返回 Promise; `resolve(key)` 和 `resolve(Ripple)` 遵循同样的规则

<a id="features"></a>

## ✨ 能力一览

- **依赖显式** - 用 `ripple()` 描述依赖和工厂, 普通输入值原样传递
- **类型推导** - 工厂输入与实例类型自动推导, 链式 `use()` 累积公开入口的 key 类型
- **异步初始化** - 独立分支并行执行, 并发解析共享同一次单例初始化
- **首次解析前替换** - `override()` 更换尚未执行的配方, 首次解析前自动校验完整依赖图
- **延迟解析** - `lazy()` 提供解析句柄, 按目标生命周期创建实例
- **统一清理** - 按首次创建完成的逆序释放资源, 支持 Symbol 清理协议和 `await using`

## 🫧 定义, 引用与实例

**先声明, 再注册, 按需解析**

```text
ripple(key, factory)       → 描述如何创建服务
new Cyrene().use(Service)  → 注册公开入口, 自动收集依赖
app.ripples.service       → 获取实例, 首次访问时初始化
await app.dispose()       → 等待初始化结束, 释放资源
```

- **声明** — `ripple(key, factory)` 或 `ripple(key, deps, factory)`, key 是不可变的非空字符串
- **依赖** — 引用 Ripple 对象, 输入属性名可以与目标 key 不同
- **普通输入** — 原样传入工厂, 包括嵌套对象和普通 Promise

| 生命周期           | 创建与复用                               |
| ------------------ | ---------------------------------------- |
| `singleton` (默认) | 同一容器共享实例, 并发初始化共享 Promise |
| `transient`        | 每次解析重新执行工厂                     |

## 🧩 注册与组合

`use()` 只决定公开入口, 内部依赖会自动收集:

```ts
const app = new Cyrene().use(Users);

app.ripples.users.describe(); // 公开入口
app.resolve(Config).prefix; // 内部依赖, 通过声明获取
// app.ripples.config 不存在
```

需要更多公开入口时, 可以写成 `new Cyrene().use(Users).use(Logger, Config)`

> [!TIP]
> 链式调用或接住 `use()` 的返回值, 才能累积公开 key 的类型
> 动态追加后, 仍可通过 `resolve(Ripple)` 获得精确的实例类型

<details>
<summary>声明身份与注册规则</summary>

- `use()` 修改并返回同一个容器, 整批入口验证通过后才登记
- 同一声明重复注册幂等; 不同声明在有效图中使用相同 key 会报错
- 显式注册内部依赖可将其提升为公开入口
- `resolve(Ripple)` 按声明身份查找; `resolve(key)` 也能访问内部节点, 但未累积类型的 key 返回 `unknown`
- `isRipple()` 可以识别由当前库创建的声明

复用声明逻辑时, 用普通函数创建具有不同 key 的 Ripple:

```ts
const logger = <const K extends string>(key: K, scope: string) => ripple(key, () => ({ scope }));

const app = new Cyrene().use(logger('auditLogger', 'audit'), logger('requestLogger', 'request'));
```

</details>

## 🔄 首次解析前替换

通过原声明指定替换目标, 公开入口与内部依赖使用同一规则:

```ts
const MockConfig = ripple('mockConfig', () => ({ prefix: 'test' }));
const app = new Cyrene().use(Users).override(Config, MockConfig);

app.ripples.users.describe(); // [test] users
app.resolve(Config) === app.resolve(MockConfig); // 同一单例
```

- **保持不变** — 原 key、公开范围、返回值与同步 / 异步契约
- **使用替身** — 工厂、依赖与 `lifetime`
- **锁定时机** — 第一次读取属性或调用 `resolve()`, 即使解析失败也不解锁

<details>
<summary>覆盖顺序与可达性</summary>

- 允许先 `override()` 后 `use()`; 同一目标最后一次覆盖生效
- `override(original, original)` 恢复原实现
- 构图只收集有效实现的依赖, 原实现独有的依赖被裁剪
- 覆盖目标必须在有效图中可达, 被上层覆盖裁剪掉的目标也会报错
- 同一个替身只能代表一个注册项, 不能同时占据其他入口或依赖节点
- 原声明与当前替身都可解析; 已被替换掉的旧替身不再映射到该节点

</details>

## ⏳ 同步与异步

**强依赖先就绪, 工厂再执行**

```ts
const Config = ripple('config', () => ({ name: 'demo' }));
const Database = ripple('database', async () => ({ query: () => ['Alice'] }));
const Users = ripple('users', { database: Database }, ({ database }) => ({
  list: () => database.query(),
}));

await using app = new Cyrene().use(Config, Users);

app.ripples.config.name; // 同步, 直接返回实例
const users = await app.ripples.users; // 强依赖异步, 等待初始化
users.list();
```

| 情况                       | 解析结果                               |
| -------------------------- | -------------------------------------- |
| 工厂与全部强依赖同步       | 直接返回实例                           |
| 工厂或任意强依赖异步       | 返回 Promise, 工厂收到已就绪的依赖     |
| 只有 lazy 目标异步         | 消费者保持同步, 句柄解析时返回 Promise |
| 工厂返回 `T \| Promise<T>` | 保留联合类型                           |

属性入口只读, 服务实例本身不代理; 异步单例完成后仍返回同一个 Promise

## 🌿 延迟解析

`lazy()` 注入解析句柄, 调用 `resolve()` 时才创建目标:

```ts
import { lazy, ripple } from 'cyrenejs';

const Report = ripple('report', { users: lazy(() => Users) }, ({ users }) => ({
  run: () => users.resolve().describe(),
}));
```

- 回调只返回声明, 保持稳定且无副作用
- 回调在构图时求值, 配置未变更时复用结果
- 工厂通过 deps / lazy 表达依赖, 避免等待同一容器的公共解析或关闭操作

<details>
<summary>初始化期间的 Promise 与等待环</summary>

| 操作                              | 是否登记等待关系           |
| --------------------------------- | -------------------------- |
| 仅调用异步 `lazy.resolve()`       | 否, 只启动初始化           |
| `await` 或返回给异步工厂          | 是                         |
| 调用 `then` / `catch` / `finally` | 是, 包括仅观察结果的回调链 |

初始化期间, 同一句柄按目标实例复用 Promise 包装, 与公共入口的 Promise 身份不同
消费者就绪后, 句柄直接返回目标的解析结果

强依赖环在构图时拒绝, 实际的异步等待环在初始化时拒绝

</details>

## 🌱 Transient 与创建时机

`transient` 适合每次任务独立的收集器、构建器等工作对象:

```ts
const Job = ripple('job', () => ({ messages: [] as string[] }), { lifetime: 'transient' });
const Worker = ripple('worker', { job: Job }, ({ job }) => ({ job }));

await using app = new Cyrene().use(Worker);

app.resolve(Job) !== app.resolve(Job); // 每次解析都创建
app.ripples.worker.job === app.ripples.worker.job; // singleton 持有首次注入
```

| 操作                       | transient 的创建时机                 |
| -------------------------- | ------------------------------------ |
| 声明、注册、覆盖、检查图   | 不执行工厂                           |
| 读取属性或调用 `resolve()` | 每次解析创建                         |
| 注入强依赖                 | 消费者初始化时, 每个输入属性分别创建 |
| `lazy.resolve()`           | 每次调用创建, 仅注入句柄不创建       |
| 并发异步解析               | 独立初始化, 返回不同 Promise         |

> [!NOTE]
> transient 保证重新执行工厂; 工厂主动返回同一对象时不会复制它
> 带 Symbol 清理协议的 owned 实例保留到容器关闭, 长期运行时需控制此类资源的创建数量

更多关于失败重试、递归创建与状态记录的规则见 [解析设计](./docs/CYRENE_DESIGN.md#解析)

## 🌳 诊断与失败处理

`inspect()` 校验依赖图并返回快照, **不执行工厂, 也不锁定配置**:

```ts
import { formatGraph } from 'cyrenejs';

console.log(formatGraph(app.inspect()));
```

| 快照字段 | 含义                                       |
| -------- | ------------------------------------------ |
| `roots`  | 显式注册的公开入口                         |
| `nodes`  | 完整有效图中的 key 与最近一次初始化状态    |
| `edges`  | 消费者、输入属性、目标与强依赖 / lazy 策略 |

树形输出中, `↗` 表示共享节点, `↻` 表示循环引用; ANSI 序列和终端控制字符会被清除

| 失败场景                       | 行为               |
| ------------------------------ | ------------------ |
| 图无效、入口无效或同步创建失败 | 直接抛错           |
| 异步创建失败                   | Promise 拒绝       |
| singleton 初始化失败           | 缓存失败结果       |
| transient 初始化失败           | 下一次解析重新尝试 |

**失败后仍由调用方关闭容器**, 释放已经登记的待清理资源

## 🍃 资源释放

用 `await using` 自动关闭容器, 或显式调用 `await app.dispose()`
资源在工厂返回时声明 `Symbol.asyncDispose` 或 `Symbol.dispose`, 前者优先:

```ts
const Database = ripple('database', async () => {
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

| 实例                    | 资源表如何处理                           |
| ----------------------- | ---------------------------------------- |
| owned + Symbol 清理协议 | 保留到关闭, 按首次创建完成的逆序释放     |
| 普通对象                | 只弱引用记录所有权, 无其他引用时可回收   |
| `ownership: 'borrowed'` | 由应用管理, 容器不负责清理               |
| 同一对象重复返回        | 只清理一次; 混用 owned / borrowed 会报错 |

> [!TIP]
> 应用先停止接收业务任务并等待已有任务结束, 再关闭容器
> 容器会等待已接收的初始化, 业务方法、流和后台任务由应用管理

<details>
<summary>关闭顺序与责任边界</summary>

- `dispose()` 幂等, 立即关闭新解析入口, 等待已接收的初始化结束后清理资源
- 强依赖通常先完成, 消费者先清理; 后来激活的 lazy 和对象别名按实际首次完成顺序处理
- 清理失败后继续处理其他资源, 最后聚合报告错误
- singleton 的解析缓存仍持有结果; 资源表的弱引用不改变单例缓存
- 普通 `.dispose()` 和选项式清理回调不参与协议
- transient 不提供请求级作用域或每次调用后的自动释放
- 工厂抛错前已分配但尚未交付的资源, 由工厂自行清理

</details>

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
