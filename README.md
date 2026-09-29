<h1 align="center">Cyrene</h1>

<p align="center">
  <a href="#quick-start">快速开始</a> ·
  <a href="#packages">项目结构</a> ·
  <a href="./packages/cyrenejs/README.md">使用文档</a> ·
  <a href="./packages/elysia/README.md">Elysia 集成</a> ·
  <a href="./packages/cyrenejs/docs/CYRENE_DESIGN.md">设计文档</a> ·
  <a href="#development">参与开发</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/cyrenejs"><img src="https://img.shields.io/npm/v/cyrenejs?style=flat&labelColor=18212f&color=a78bfa" alt="npm 版本" /></a>
  <img src="https://img.shields.io/badge/TypeScript-type_safe-3178c6?style=flat&labelColor=18212f" alt="TypeScript 类型推导" />
  <img src="https://img.shields.io/badge/module-ESM-a78bfa?style=flat&labelColor=18212f" alt="ESM 模块" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22.6.0-5fa777?style=flat&labelColor=18212f" alt="Node.js 22.6.0 及以上" />
</p>

<br />

<p align="center">
  <strong>Cyrene 把服务之间的关系写成一张显式的依赖图</strong>
  <br />
  由 TypeScript 推导输入与实例类型, 由运行时负责按需初始化、实例复用和资源清理
</p>

<br />

<a id="quick-start"></a>

## 🌱 快速开始

安装核心包, 需要 Node.js 22.6.0 及以上:

```sh
npm install cyrenejs
```

也可以使用 `pnpm add cyrenejs` 或 `vp add cyrenejs`

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

const users = app.ripples.users;
users.describe(); // [app] users
```

`ripple()` 声明依赖与工厂, `use()` 注册公开入口并自动收集依赖, 首次解析时才创建实例
同步服务直接返回实例, 异步服务返回 Promise; 每个 `Cyrene` 容器独立管理实例与资源

示例使用 `await using`, 请通过支持该语法的运行时或 TypeScript 工具链运行
也可以使用 `try/finally` 配合 `await app.dispose()` 显式释放资源

## ✨ 能力一览

- **依赖显式** — 通过 Ripple 对象引用服务, 自动推导工厂输入与实例类型
- **按需初始化** — 同步解析保留同步返回值, 独立异步分支并行初始化
- **生命周期** — 默认 `singleton` 共享实例, `transient` 每次解析重新创建
- **首次解析前替换** — 使用 `override()` 替换实现, 便于测试与环境配置
- **延迟解析** — 使用 `lazy()` 注入解析句柄, 在需要时创建目标
- **诊断与清理** — 使用 `inspect()` 检查依赖图, 通过 Symbol 清理协议统一释放资源

完整 API、行为边界与示例见 [核心包文档](./packages/cyrenejs/README.md)

## 🌐 Elysia 集成

`@cyrenejs/elysia` 将 Cyrene 接入 Elysia 路由上下文, 保留类型推导、按需初始化与资源清理:

```sh
npm install @cyrenejs/elysia cyrenejs elysia
```

通过 `ElysiaCyrene()` 创建应用容器, 使用 `useRipples(...)` 注册路由所需的入口,
随后从路由上下文的 `ripples` 读取服务。多个路由模块可以复用同一个插件实例和容器。

接入示例、共享方式与生命周期说明见 [Elysia 集成文档](./packages/elysia/README.md)

<a id="packages"></a>

## 🧩 项目结构

仓库使用 Vite+ 与 pnpm workspace 管理多个包:

| 目录                                       | 用途                                               |
| ------------------------------------------ | -------------------------------------------------- |
| [`packages/cyrenejs`](./packages/cyrenejs) | 核心运行时, 包含源码、测试、设计文档与 Agent skill |
| [`packages/elysia`](./packages/elysia)     | Elysia 集成, 提供路由上下文注入与容器生命周期管理  |
| [`example`](./example)                     | 同步依赖图、异步初始化与注册场景的可运行示例       |

## 🤖 Agent

核心包随 npm 包提供 [cyrenejs skill](./packages/cyrenejs/skills/cyrenejs/SKILL.md), 帮助编码 Agent 使用声明注册、延迟解析与资源释放
安装和同步方式见 [Agent 使用说明](./packages/cyrenejs/README.md#agent)

<a id="development"></a>

## 🛠️ 参与开发

在仓库根目录安装依赖并构建各包, 再执行检查与测试。首次构建会生成示例和集成包需要的类型声明:

```sh
vp install
vp run -r build
vp check
vp test run
```

| 命令                                      | 用途                          |
| ----------------------------------------- | ----------------------------- |
| `vp check`                                | 格式、lint 与类型检查         |
| `vp test run`                             | 运行工作区测试                |
| `vp run -r build`                         | 构建各包                      |
| `vp run --filter cyrenejs build`          | 仅构建核心包的 ESM 与类型声明 |
| `vp run --filter @cyrenejs/example start` | 构建核心包并运行示例          |
| `vp run changeset`                        | 为需要发布的包记录变更        |

示例不需要数据库或外部服务, 场景说明见 [示例文档](./example/README.md)
各包使用独立版本, changeset、Release PR 与自动发布流程见 [发布说明](./.changeset/README.md)
欢迎从 [设计文档](./packages/cyrenejs/docs/CYRENE_DESIGN.md) 和 [测试用例](./packages/cyrenejs/tests) 了解运行时的行为边界
