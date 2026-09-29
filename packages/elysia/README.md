# @cyrenejs/elysia

Cyrene 的 Elysia 集成包，通过路由上下文访问带类型的服务，保留同步 / 异步类型推导、按需初始化与资源清理。

- `ElysiaCyrene()` 创建应用容器，并在 Elysia 停止时触发容器清理。
- `useRipples(...)` 注册路由需要的入口，通过 `context.ripples` 按需解析服务。
- 多个路由模块复用同一插件实例时，共享同一个容器。

Cyrene 的声明与依赖图用法见 [核心包文档](../cyrenejs/README.md)。

## 安装

```bash
npm install @cyrenejs/elysia cyrenejs elysia
```

也可以使用 `pnpm add` 或 `vp add`。`cyrenejs` 与 `elysia` 是由应用安装的 peer dependencies，Elysia 版本需满足 `^1.4.0`。

## 基本用法

```ts
import { ElysiaCyrene, useRipples } from '@cyrenejs/elysia';
import { ripple } from 'cyrenejs';
import { Elysia } from 'elysia';

const Config = ripple('config', () => ({ greeting: 'Hello' }));
const Service = ripple('service', { config: Config }, async ({ config }) => ({
  greet: (name: string) => `${config.greeting}, ${name}!`,
}));

const app = new Elysia()
  .use(ElysiaCyrene())
  .use(useRipples(Service))
  .get('/hello/:name', async ({ ripples, params }) => {
    const service = await ripples.service;
    return service.greet(params.name);
  });
```

`ElysiaCyrene()` 创建一个容器，通过 `context.cyrene` 和 `app.decorator.cyrene` 暴露。
`useRipples(...declarations)` 注册入口，并为后续路由提供带类型的 `context.ripples`。
必须先安装 `ElysiaCyrene()`，再调用 `useRipples()`。

- 注册不会运行工厂，首次读取属性才解析依赖。
- 同步入口返回实例，异步入口返回 `Promise`；异步路由请使用 `async` / `await`。
- 多次 `useRipples()` 会累积入口类型；同一声明可以重复注册，不同声明不能占用相同 key。
- 间接依赖自动收集，只有显式注册的入口会作为 `ripples` 属性公开。
- 首次解析后依赖图锁定，所有注册和 `cyrene.override()` 都应在处理请求前完成。
- `ripples` 是只读属性访问视图，不支持通过 `Object.keys()`、展开运算符或 JSON 序列化列出服务；查看依赖图请用 `cyrene.inspect()`。

## 多路由共享

复用同一个插件实例，让路由使用同一个容器。按照 Elysia 的显式依赖模式，每个路由模块自行安装插件并声明所需入口。

```ts
const container = ElysiaCyrene();

const first = new Elysia()
  .use(container)
  .use(useRipples(Config))
  .get('/first', ({ ripples }) => ripples.config.greeting);

const second = new Elysia()
  .use(container)
  .use(useRipples(Service))
  .get('/second', async ({ ripples }) => (await ripples.service).greet('Cyrene'));

const app = new Elysia().use(container).use(first).use(second);
```

分别调用 `ElysiaCyrene()` 会创建独立容器，应分别用于不同应用；同一个应用的路由请复用实例，避免同名 decorator 冲突。

## 生命周期

默认 `singleton` 在容器内共享，包含并发请求发起的异步初始化。
`transient` 每次读取属性都会新建实例，**不是每个请求一个实例**；其资源仍由容器统一持有并在关闭时释放。

插件的 `onStop` 钩子会调用 `cyrene.dispose()`，释放实现了 `Symbol.dispose` 或 `Symbol.asyncDispose` 的资源。清理顺序、借用资源和初始化等待沿用 Cyrene 的规则。

Elysia 适配器是否等待异步停止钩子取决于其实现。需要保证资源清理完成并捕获清理错误时，显式等待容器：

```ts
try {
  await app.stop();
} finally {
  await container.decorator.cyrene.dispose();
}
```

只使用 `app.handle()` / `app.fetch()`、没有启动监听服务器时，在应用自己的关闭流程中直接 `await container.decorator.cyrene.dispose()`。清理是幂等的；清理后不能继续解析服务。业务方法中仍在运行的任务由应用先行停止。

## 开发

在仓库根目录运行。先构建各包，生成类型检查所需的声明文件：

```bash
vp install
vp run -r build
vp check
vp test run
```
