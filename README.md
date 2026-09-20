<h1 align="center">Cyrene</h1>

<p align="center">
  让依赖关系留在代码里, 让初始化与释放交给运行时
</p>

<p align="center">
  [<a href="#quick-start">快速开始</a>]
  [<a href="#features">能力一览</a>]
  [<a href="./CYRENE_DESIGN.md">设计文档</a>]
  [<a href="#development">参与开发</a>]
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cyrenejs"><img src="https://img.shields.io/npm/v/cyrenejs?style=flat&labelColor=18212f&color=a78bfa" alt="npm 版本" /></a>
  <img src="https://img.shields.io/badge/TypeScript-type_safe-3178c6?style=flat&labelColor=18212f" alt="TypeScript 类型推导" />
  <img src="https://img.shields.io/badge/module-ESM-a78bfa?style=flat&labelColor=18212f" alt="ESM 模块" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.18.0-5fa777?style=flat&labelColor=18212f" alt="Node.js 22.18.0 及以上" />
</p>

<br />

构造一个服务, 往往也意味着准备配置, 连接数据库, 等待初始化, 并在结束时把资源逐一释放

**Cyrene 把这些关系写成一张显式的依赖图**, 由 TypeScript 推导输入与实例类型, 由运行时负责解析, 缓存和清理

一个 `Cyrene` 就是一个独立运行作用域, 构造时声明入口和外部能力, 然后启动它

> [!NOTE]
> 当前仓库配置为 private, 示例以本地构建为准
> 可以先在本仓库构建并运行示例, API 约定见 [设计文档](./CYRENE_DESIGN.md)

<a id="quick-start"></a>

## 🌱 快速开始

在本仓库执行 `vp install` 和 `vp pack`, 即可通过包入口 `cyrenejs` 使用构建结果

```ts
import { Cyrene, ripple, token } from 'cyrenejs';

// 外部配置由运行环境提供
const Config = token<{ prefix: string }>('Config');

const logger = ripple({ config: Config }, ({ config }, scope: string) => ({
  label: `${config.prefix}:${scope}`,
}));

// 调用 logger 只记录参数, 实例会在启动时创建
const users = ripple({ logger: logger('users') }, ({ logger }) => ({
  describe: () => logger.label,
}));

await using app = new Cyrene({
  providers: { users },
  bindings: [{ token: Config, value: { prefix: 'app' } }],
});

const services = await app.start();
services.users.describe(); // 返回 app:users
```

`providers` 声明需要启动的命名入口, `bindings` 提供 Token 的外部实现

`start()` 会先校验全部入口的依赖图, 再按依赖关系初始化, 返回值保留入口名称和实例类型

<a id="features"></a>

## ✨ 能力一览

- **依赖显式** - 使用 `ripple()` 组合依赖, 普通函数和对象仍然是普通值
- **参数自然** - 直接调用依赖定义传入参数, 支持默认参数, 可选参数和 rest 参数
- **异步初始化** - 独立分支并行执行, 同一 singleton 的并发解析共享初始化 Promise
- **生命周期明确** - 默认每个 Cyrene 内 singleton, 也支持每次解析创建的 transient
- **延迟解析** - `lazy()` 注入解析句柄, 在真正需要时初始化目标
- **先校验后执行** - 初始化前检查缺失绑定与强依赖环, `inspect()` 可以查看依赖图
- **统一清理** - 先释放消费者再释放依赖, 支持自定义清理方法和 `await using`

## 🫧 定义, 引用与实例

```text
ripple(inputs, factory)  → 定义依赖
依赖定义(...params)      → 创建带参数的 Ref
cyrene.start()          → 初始化所有命名入口
cyrene.resolve(target)  → 按需解析单个目标
cyrene.dispose()        → 释放持有的资源
```

同一份定义或 Ref 在同一个 Cyrene 内按 lifetime 复用实例, 不同 Cyrene 的缓存彼此隔离

> [!TIP]
> 每次调用依赖定义都会创建新的 Ref, 即使参数相同也不会自动合并
> 需要共享实例时, 先保存 Ref, 再把它传给多个依赖

```ts
const usersLogger = logger('users');

const users = ripple({ logger: usersLogger }, ({ logger }) => ({ logger }));
const audit = ripple({ logger: usersLogger }, ({ logger }) => ({ logger }));
```

## 🍃 资源释放

`await using` 会在离开作用域时释放 Cyrene, 也可以显式调用 `await app.dispose()`

运行时等待已经开始的初始化结束, 再按依赖关系清理实例
清理方法优先使用 `ripple` 配置中的 `dispose`, 其次是 `Symbol.asyncDispose` 和 `Symbol.dispose`

通过 `bindings` 传入的外部值由原持有者管理, Cyrene 不会自动释放它们

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

欢迎从 [设计文档](./CYRENE_DESIGN.md) 和 [测试用例](./tests/cyrene.test.ts) 了解行为边界
