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

一个 `Cyrene` 就是一个独立运行作用域, 构造时声明入口, 然后启动它

<a id="quick-start"></a>

## 🌱 快速开始

安装公开包 `cyrenejs`:

```sh
npm install cyrenejs
```

也可以使用 `pnpm add cyrenejs` 或 `vp add cyrenejs`

需要 Node.js 22.0.0 及以上, 包提供 ESM 入口和 TypeScript 类型声明
下面的 TypeScript 示例使用 `await using`, 请通过支持该语法的 TypeScript 工具链编译运行; 也可以使用 `try/finally` 配合 `await app.dispose()` 显式释放资源

```ts
import { Cyrene, poem, ripple } from 'cyrenejs';

const config = ripple(() => ({ prefix: 'app' }));

const logger = ripple({ config }, ({ config }, scope: string) => ({
  label: `${config.prefix}:${scope}`,
}));

// 调用 logger 只记录参数, 实例会在启动时创建
const users = ripple({ logger: logger('users') }, ({ logger }) => ({
  describe: () => logger.label,
}));

await using app = new Cyrene({
  ripples: poem({ users }),
});

await app.start();
const userService = await app.resolve(users);
userService.describe(); // 返回 app:users
```

`ripples` 声明需要启动的入口, 支持对象和数组

`start(): Promise<void>` 先校验全部入口的依赖图, 再按依赖关系初始化; 已接入图的实例通过 `resolve()` 获取

<a id="features"></a>

## ✨ 能力一览

- **依赖显式** - 使用 `ripple()` 组合依赖, 普通函数和对象仍然是普通值
- **参数自然** - 直接调用依赖定义传入参数, 支持默认参数, 可选参数和 rest 参数
- **异步初始化** - 独立分支并行执行, 同一 singleton 的并发解析共享初始化 Promise
- **生命周期明确** - 默认每个 Cyrene 内 singleton, 也支持每次解析创建的 transient
- **延迟解析** - `lazy()` 注入解析句柄, 在真正需要时初始化目标
- **先校验后执行** - 初始化前检查非法依赖与强依赖环, `inspect()` 可以查看依赖图
- **统一清理** - 先释放消费者再释放依赖, 支持自定义清理方法和 `await using`
- **动态入口** - 启动后通过 `add()` 接入新图, 通过 `remove()` 或 `prune()` 显式释放

## 🫧 定义, 引用与实例

```text
ripple(inputs, factory)  → 定义依赖
依赖定义(...params)      → 创建带参数的 Ref
cyrene.start()          → 初始化所有入口, 不返回实例
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

## Poem 集合与运行时识别

`poem` 将具体 Ripple 或 Ref 组合为命名对象, 支持两种形式:

```ts
import { Cyrene, isPoem, isRipple, poem, ripple } from 'cyrenejs';

const logger = ripple(() => ({ name: 'logger' }));
const ready = ripple(() => true);

const named = poem({ logger, ready });
const created = poem(() => ({ logger, ready }));
await using app = new Cyrene({ ripples: named });
await app.start();
const instance = await app.resolve(logger);

isRipple(logger); // true
isPoem(named); // true
isPoem(created); // true
```

对象形式保留名称。参数化定义需要先创建 Ref。数组入口仍可直接传给 `Cyrene`, 但不由 `poem` 创建。
集合也可以直接作为 `ripple` 的输入, 用组合函数传入不同实现:

```ts
import type { Dependency } from 'cyrenejs';

const createServices = (logger: Dependency<{ name: string }>) => {
  const dependencies = poem({ logger });
  const users = ripple(dependencies, ({ logger }) => ({ label: logger.name }));
  return poem({ users });
};

const services = createServices(logger);
const combined = ripple(poem({ logger, ready }), ({ logger, ready }) => ({ logger, ready }));
```

`poem({ ... })` 在原对象上添加标识并返回它; `poem(() => ({ ... }))` 同步调用构图函数一次, 标记其返回对象。空集合使用 `poem({})`。
首次标记要求对象可扩展, 不冻结对象, 可以重复标记。对象入口仅接受自身可枚举的字符串键。
`Cyrene` 浅拷贝入口, 后续修改原集合不影响运行时。普通对象和数组也可直接传入 `ripples`。

`ripple()` 和 `poem()` 分别通过 `isRipple()` 和 `isPoem()` 识别。
内部 Symbol 不从包入口导出, 不可枚举、不可修改、不可删除, 不会随展开复制。
识别方法检查自身标识严格等于 `true`, 不代表依赖可以被当前运行时解析。
v0 要求定义与 Cyrene 共享同一份运行时模块, 不支持跨包副本解析。

## 动态入口

`start()` 后可将新的 Ripple 或 Ref 接入当前 Cyrene:

```ts
const inspector = ripple({ users }, ({ users }) => ({ describe: users.describe }));
const instance = await app.add(inspector);

await app.remove(inspector); // 只移除 inspector
// await app.prune(inspector); // 同时清理因此失去 consumer 的依赖
// await app.override(oldService, newService); // 按身份替换并重建受影响入口
```

`resolve()` 只访问已接入图的入口或依赖, 新目标先调用 `add()`。`add()` 会校验并初始化新入口, 返回实例; 失败时撤销入口并清理本次独占创建的资源。`remove()` 删除没有 consumer 的已接入节点, 保留依赖; 孤立依赖也可以直接删除。`prune()` 删除目标及其闭包中不再被其他入口或外部 consumer 需要的子图, 支持整体清理 lazy 环; 如果目标仍被保留图需要则拒绝。`inspect()` 展示全部已接入节点, 包括保留的孤立节点。图变更会等待已开始的解析, 同一时刻只允许一次图变更。删除后的定义如需再次解析, 应先调用 `add()`。

`override(old, replacement)` 修改当前唯一的依赖图, 所有引用 `old` 的 consumer 随后得到 `replacement`。运行中调用会先释放受影响的已初始化实例, 再立即重建受影响入口; 不会凭图可达性自动释放旧依赖或其他保留资源。`inspect()` 会显示 `override` 边。若新关系形成强依赖环, 原图和实例不变。lazy 分支失效后按需恢复, 不立即重放历史实例。清理或重建失败时新图仍生效, 操作不承诺回滚。已交给外部的旧实例引用不会被自动改写。

普通值直接作为 Ripple 输入; 不需要 Token 或 Binding。`ripple()` 当前接收 factory, class 构造器仍通过 `deps => new Class(deps)` 显式调用。

## 查看依赖图

`formatGraph()` 将 `inspect()` 的结果转换为终端文本, 由调用方决定打印或写入文件:

```ts
import { formatGraph } from 'cyrenejs';

console.log(formatGraph(app.inspect()));
console.log(formatGraph(app.inspect(users)));
```

```text
Users #0
├─ Database #1
│  └─ Config #2
└─ Logger(ref) #3 [ref]
   └─ Logger #4 [definition]
```

节点名称来自 `debugName`。`#id` 区分同名节点,
`↗` 表示已展开的共享节点, `↻` 表示当前路径中的循环引用。
延迟边标记为 `[lazy]`, Ref 的定义关系标记为 `[definition]` 且不沿该边展开。
空图输出 `(empty graph)`。格式化不会执行工厂, 也不会输出 Ref 参数值。

## 🍃 资源释放

`await using` 会在离开作用域时释放 Cyrene, 也可以显式调用 `await app.dispose()`

运行时等待已经开始的初始化结束, 再按依赖关系清理实例
清理方法优先使用 `ripple` 配置中的 `dispose`, 其次是 `Symbol.asyncDispose` 和 `Symbol.dispose`

factory 返回的资源统一由当前 Cyrene 管理, 即使对象在外部创建也遵循相同的清理规则。
普通输入不会单独登记为资源, 但工厂原样返回它时会进入生命周期管理。
多个定义返回同一对象时合并资源依赖并只释放一次; 显式清理优先于自动清理。
共享对象的多个显式清理方法必须是同一函数引用, 否则后完成的解析报错, 已登记的资源仍会清理。

<a id="agent"></a>

## 🤖 Agent

Cyrene 随 npm 包提供 [cyrenejs skill](./skills/cyrenejs/SKILL.md), 帮助编码 Agent 正确使用依赖定义、Poem 组合、延迟解析和资源释放。

在使用 Cyrene 的项目中安装 `cyrenejs` 后, 可以通过 [skills-npm](https://github.com/antfu/skills-npm) 将 skill 链接到 Agent 的技能目录:

```sh
npm install -D skills-npm
npx skills-npm setup
```

`setup` 会自动检测 Agent、完成首次同步, 并将同步命令追加到 `package.json` 的 `prepare` 脚本, 同时为生成的链接添加 `.gitignore` 规则。之后安装或更新依赖时会自动同步, 让 skill 随项目使用的包版本一起更新。

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
