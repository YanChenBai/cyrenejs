# Cyrene 示例

示例按三个场景依次运行, 不需要数据库或外部服务

| 文件                  | 内容                                                               |
| --------------------- | ------------------------------------------------------------------ |
| `src/basic.ts`        | 八个同步服务的多层与菱形依赖, 共享缓存, override, 依赖图与逆序清理 |
| `src/async.ts`        | 异步强依赖传播, 同步 lazy 消费者, 并发解析共享 Promise 与实例      |
| `src/registration.ts` | 分步追加注册的类型边界, resolve(Ripple), borrowed 外部资源         |

`src/index.ts` 是统一入口, 异步与注册示例中的断言会检查实例身份、工厂创建次数和清理责任

basic 只 use(Dashboard), 自动收集其依赖。从 Dashboard 进入 Users 和 Orders, Orders 再依赖 Users 与 Catalog
Users 和 Catalog 共享 Database 与 Cache, 各层共享 Logger, Database 与 Logger 共同依赖 Config
运行时先打印完整依赖图, 再展示按需创建、两次渲染的缓存复用和逆序清理
清理日志还会展示 Orders 释放时仍能访问 Users, Users 和 Catalog 释放时仍能访问 Database

在仓库根目录安装依赖后运行：

```sh
vp install
vp run --filter @cyrenejs/example start
```

也可在 example 目录运行 `vp run start`。
示例使用 await using，需要支持显式资源管理语法的 Node.js 版本。

同步服务无需 await, 异步服务完成后再次访问仍返回同一个 Promise
Report 创建时数据库连接数为 0, 并发请求 Users 和 Report 后连接数为 1
离开作用域时先清理 Users, 再清理数据库; borrowed 实例由应用自行释放

单独调用 `app.use(...)` 不改变原变量的泛型, 新 key 不会出现在 `app.ripples` 的类型提示中
使用 `app.resolve(Ripple)` 可以保留结果推导, `app.resolve('key')` 返回 unknown
链式调用或接住 use 返回值可累积 key 类型; 所有追加和替换必须在首次解析前完成

并发保证针对同一容器的初始化: 普通强依赖、lazy 和直接解析共享单例缓存
容器不串行业务方法, 也不追踪方法中的在途工作; 关闭前应由应用停止并等待业务任务
