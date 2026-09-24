# Cyrene 架构设计

## 目标与范围

Cyrene 是面向 TypeScript 的声明式依赖图运行时, 将依赖声明、异步初始化和资源释放统一在一个显式作用域内。业务工厂接收声明的输入与参数, 不需要访问容器

一个 Cyrene 是独立的缓存与资源所有权边界。定义可以复用, 实例不会在运行时之间自动共享。需要不同生命周期时创建不同 Cyrene, 不提供父子作用域、隐式全局容器、Token/Binding、装饰器或扫描注册

动态图支持接入、删除、剪枝与实现替换。它管理定义身份、实例和资源, 不代理业务对象, 不改写已返回的引用, 不提供业务请求的暂停或事务回滚

## 分层与数据模型

### 声明层

ripple.ts 创建可调用的 Dependency, metadata.ts 在模块内 WeakMap 保存工厂、输入和选项。定义与 Ref 本身不保存运行时实例

| 概念          | 身份与职责                                     |
| ------------- | ---------------------------------------------- |
| Dependency    | ripple() 返回的函数对象, 描述一个工厂          |
| DependencyRef | 调用 Dependency 得到的对象, 保存定义和参数快照 |
| LazyRef       | lazy() 返回的声明, 描述延迟解析的目标          |
| Poem          | 带标识的命名对象, 组织具体 Dependency 或 Ref   |

每次调用 Dependency 都生成新的 Ref, 即使参数相同也不合并。无参数 Dependency 本身与 dependency() 得到的 Ref 也是不同身份。共享实例需要复用同一目标引用

定义的输入、选项和 Ref 参数数组做浅快照, 嵌套对象不深拷贝。内部品牌不从包入口导出, isRipple/isPoem 仅识别标识。定义和 Cyrene 必须来自同一份运行时模块, 跨副本品牌识别不等于元数据共享

### 运行图

RuntimeGraph 保存当前 Cyrene 已接入的目标, 维护 consumer → dependency 的双向邻接索引。节点按确切 Dependency/Ref 对象区分

| 边         | 语义                                        |
| ---------- | ------------------------------------------- |
| dependency | 初始化消费者之前先初始化依赖                |
| lazy       | 构图时校验并保留目标, 激活句柄时才初始化    |
| override   | 解析旧身份时重定向到替代身份                |
| definition | 仅在诊断中展示 Ref 的定义身份, 不参与初始化 |

入口集合与节点集合分开。构造入口、成功 add 的目标以及成功直接 resolve 的非入口目标都作为独立入口保留。remove/override 可能留下没有入口可达的节点, 它们仍已接入且可以显式解析或清理

图首次使用时统一接入构造入口。后续解析复用已校验的图, add/override 在修改拓扑时校验, 不在每次 resolve 时重建声明图

### 实例与资源

Cyrene 维护三组互不等价的状态:

1. 实例记录: 目标、初始化 Promise、状态和实际依赖实例
2. 等待关系: 只在初始化等待期间存在, 用于检测异步等待环
3. 资源记录: 按返回对象或函数的引用合并, 保存清理方法和资源依赖

singleton 缓存键是目标身份, transient 每次解析创建新的实例记录。并发 singleton 解析共享初始化 Promise。实例失败后移除 singleton 缓存, 后续解析可以重试

多个实例可能返回同一个对象, 因而共享一个资源。图删除按目标选择实例, 释放按合并后的资源身份执行。若待删除或失效的资源仍被保留实例共享, 操作在释放之前拒绝

## 声明 API

| API                               | 契约                                       |
| --------------------------------- | ------------------------------------------ |
| ripple(factory, options?)         | 无注入输入, 工厂参数全部是业务参数         |
| ripple(inputs, factory, options?) | 首个工厂参数是已解析的输入, 后续是业务参数 |
| dependency(...params)             | 创建新的 Ref, 不执行工厂                   |
| lazy(() => target)                | 声明 lazy 边, 工厂收到 Lazy<T>             |
| poem(object)                      | 标记并返回原命名对象                       |
| poem(() => object)                | 同步执行一次组合函数, 标记返回对象         |
| isRipple/isPoem                   | 判断自身品牌                               |

inputs 支持对象和数组, 仅解析顶层的 Dependency、Ref 和 LazyRef。普通函数不执行, 普通对象不递归解析, Promise 输入不自动等待。对象输入支持 Symbol 键

带参数定义必须先创建 Ref, 包括只有可选参数或 rest 参数的定义。TypeScript 负责参数约束, 运行时不通过 factory.length 推断参数类型。class 通过普通工厂显式构造

Poem 是组合辅助对象, 不引入模块作用域或独立生命周期。品牌不可枚举, 对象展开不会复制品牌; 首次标记需要对象可扩展。Cyrene 的 ripples 可直接使用命名对象或稠密数组, 不强制使用 Poem。入口只接受无参数 Dependency 和 Ref, 不接受 LazyRef。命名入口只允许自身可枚举字符串键; 数组拒绝空洞和额外属性

```ts
const report = ripple((name: string) => ({ read: () => name }));
const monthly = report('monthly');
const dashboard = ripple({ report: lazy(() => monthly) }, ({ report }) => ({
  load: async () => (await report.resolve()).read(),
}));

await using app = new Cyrene({ ripples: poem({ dashboard }) });
await app.start();
const page = await app.resolve(dashboard);
await page.load();
```

构造与 start 不初始化 monthly, 第一次 page.load 才激活报表

## 生命周期 API

| API                                       | 契约                                               |
| ----------------------------------------- | -------------------------------------------------- |
| new Cyrene({ ripples? })                  | 浅快照保存入口, 不执行工厂                         |
| start(): Promise<void>                    | 校验构造入口图, 并行初始化入口及强依赖             |
| resolve(target): Promise<T>               | 解析已接入目标, 成功后将非入口目标保留为独立入口   |
| add(target): Promise<T>                   | 启动成功后接入、初始化并保留新入口                 |
| remove(target): Promise<void>             | 删除没有 consumer 的已接入节点及实例, 保留依赖     |
| prune(target): Promise<void>              | 删除目标及其闭包中不再被保留图需要的子图           |
| override(old, replacement): Promise<void> | 替换解析映射, 使受影响实例失效, 立即重建受影响入口 |
| validate(target?): void                   | 校验图, 不执行工厂                                 |
| inspect(target?): DependencyGraph         | 返回图快照, 不执行工厂                             |
| dispose(): Promise<void>                  | 关闭解析入口并释放资源                             |
| [Symbol.asyncDispose](<>)                 | 委托 dispose, 支持 await using                     |

### 启动与解析

start 在任何工厂执行前校验完整入口图, 包括 lazy 可达目标。入口与独立依赖分支可并行, 某分支失败仍等待其他分支完成, 避免遗漏稍后创建的资源

start 的 Promise 包括失败结果都会缓存, 重复调用不重放启动。resolve 可以在 start 前使用, 但只能解析已接入目标。resolve 不重置失败的 start; 动态变更要求 start 已成功, 启动失败后可解析或释放, 不能用 override 修复启动状态

成功直接 resolve 非入口目标会将其保留为独立入口, 防止 prune 隐式释放已交给调用者的依赖。通过 Lazy.resolve 激活的目标不提升为独立入口。直接解析会改变后续剪枝边界

singleton 是每个 Cyrene 内每个身份一个实例。transient 每次解析创建实例, 所有历史实例仍由该 Cyrene 管理, 直到对应节点被删除、失效或整个运行时释放。singleton 捕获 transient 是允许的

### 删除与剪枝

remove 接受任何已接入节点, 不要求它是入口。任何 dependency、lazy 或 override 入边都会阻止单节点删除。目标的所有 transient 实例也一起释放。依赖即使因此孤立仍保留, 可通过 inspect 查看并继续 remove/prune

prune 采用闭包保护而非入边计数:

1. 收集目标沿全部依赖边可达的候选集合
2. 保护候选集合中的其他独立入口、具有集合外 consumer 的节点及它们的依赖闭包
3. 如果目标也被保护, 整次操作拒绝
4. 删除其余候选节点, 不扫描本次闭包之外的历史孤立节点

没有外部保护的 lazy 环可以整体删除; 环内互相引用不构成保留理由。其他入口或外部 consumer 仍需要环时不能删除。未激活的 lazy 边也参与保护

删除后旧 lazy 句柄失效, 即使同一目标重新 add 也不会恢复旧实例的句柄。已返回的普通业务对象无法撤销, 调用者应停止使用已释放对象

### 实现替换

override 针对确切目标身份, 不按工厂名称、参数或共同定义匹配。替换一个 Dependency 不会替换它创建的其他 Ref。替代目标可以尚未接入, 其闭包在提交前校验

操作先计算旧目标及其传递 consumer, 验证共享资源边界与替换后的强依赖环, 再提交重定向、释放受影响实例, 最后重新解析受影响入口

lazy 边参与失效范围, 但不强制恢复其历史激活状态。已经激活的 lazy 分支会被释放, 新入口再次使用该分支时才创建新实例。transient 历史实例不会按原数量重放。保留的非受影响实例和缓存继续复用

旧目标的依赖、先前替换实现和其他保留节点不会因为失去入口可达性而自动释放。可显式清理无 consumer 的旧节点。连续 override 更新指定身份的重定向; override(target, target) 对已接入目标是无操作, 不是撤销之前的替换

已交给外部的引用不会自动更新。调用者应 await override 后重新 resolve 入口, 不应继续使用旧对象

## Lazy 与循环依赖

lazy 回调在运行图接入该声明时求值, 解析出的目标绑定在该消费者图节点上, 后续实例初始化复用这个目标。允许回调创建 Ref, 不会因为再次解析而生成不在图中的另一个 Ref

inspect 未接入目标会临时构图后撤销, 因而之后真正接入时可能再次求值。回调应只构造声明, 不创建业务资源, 也不依赖精确调用次数

强依赖环在工厂执行前拒绝。lazy 可以打断初始化依赖环, 但不能解决工厂之间互相 await 的死锁。运行时通过实例等待关系检测这种环; transient 不使用缓存, 还需检查正在等待的目标链, 防止无限创建

Lazy.resolve 绑定具体消费者实例与 Cyrene, 激活时记录实际实例依赖。消费者被释放或运行时开始 dispose 后句柄拒绝解析。循环声明的 TypeScript 推导必要时需显式标注结果类型

## 并发与失败边界

运行时整体状态为 active → disposing → disposed。图变更只允许一个在途操作, 其他变更及新的公开 resolve 在此期间拒绝, 不隐式排队

| 变更阶段   | 行为                                                 |
| ---------- | ---------------------------------------------------- |
| draining   | 等待已接收解析结束, 存活 lazy 句柄可继续解析         |
| changing   | 验证、改图与释放, 禁止 lazy 解析                     |
| rebuilding | 初始化新入口或重建受影响入口, 允许存活 lazy 句柄解析 |

重建时保留服务可能通过自己的 lazy 句柄提供能力, 因此不能仅凭消费者已经 ready 就拒绝解析。此规则也适用于外部持有的存活句柄; 不依赖隐式异步上下文区分调用来源。操作返回前等待这些解析任务结束, 外部调用者仍须自行处理其 Promise 的失败

运行时只等待依赖解析任务, 不知道业务对象正在处理哪些请求。调用者负责协调请求与图变更。工厂或 disposer 不应反向等待当前变更或整体 dispose, 否则可能形成运行时无法检测的业务等待环。无限持续的解析、未结束的工厂会延长等待, 没有超时或取消协议

| 失败位置              | 状态与恢复                                                                   |
| --------------------- | ---------------------------------------------------------------------------- |
| 接入或替换图验证失败  | 撤销新图节点/边, 原有实例不释放                                              |
| remove/prune 清理失败 | 继续清理并完成删除, 最后抛 AggregateError                                    |
| override 清理失败     | 新图已提交, 仍尝试重建入口, 最后报告错误                                     |
| override 重建失败     | 新图保留, 旧实例已失效, 成功的新实例继续持有; 可重新 resolve 重试失败分支    |
| add 初始化失败        | 不保留新入口, 清理本次独占实例; 与已有资源共享的别名及必要依赖保留到后续释放 |
| dispose 清理失败      | 继续清理, 进入 disposed, 重复调用返回同一失败 Promise                        |

释放具有不可逆副作用, remove/prune/override 不承诺事务回滚。Promise 拒绝不等于图保持不变。多个分支错误使用 AggregateError 汇总

## 资源所有权与释放顺序

工厂返回值统一由当前 Cyrene 管理, 包括工厂返回的外部对象。普通输入不单独登记资源; 工厂原样返回输入时按返回值管理。不递归释放返回对象的嵌套字段

对象与函数按引用合并, 每个资源释放一次。原始值按实例单独处理。清理优先级是 options.dispose → Symbol.asyncDispose → Symbol.dispose, 只调用一种。共享资源上不同显式 disposer 引用是错误, 应复用同一函数

释放按实际实例依赖合并后的资源关系排序, 无环部分先消费者后依赖。lazy 激活或别名合并可能形成资源环, 环内没有严格拓扑顺序, 按确定的遍历顺序打破环并确保每个资源仅释放一次

整体 dispose 先关闭新解析, 等待在途变更和解析, 再释放所有持有资源。局部删除不会提前释放保留实例共享的资源。运行时无法替业务工厂回收尚未作为返回值登记的资源, 工厂初始化失败前的局部资源应自行清理

## 诊断与可观察性

inspect() 的 roots 仅列真实入口, nodes/edges 包含全部已接入节点, 包括 remove/override 留下的孤立节点; 不可从入口到达的实际节点标记 retained: true。inspect(target) 只展示目标闭包; 未接入目标可临时校验和查看, 不因此保留或初始化

快照 ID 只在当前快照内有意义。图表示当前解析拓扑, 不表示历史实例数量或完整资源所有权图。Ref 的参数会出现在原始快照中, 调用者应自行控制敏感数据输出

formatGraph 返回文本而不打印, 标记 lazy、override、definition、共享节点和循环, 在入口之外展示 retained 节点。它不输出参数值

ResolutionError 保留 cause 与依赖路径; CircularDependencyError 表示声明环或初始化等待环; InvalidDependencyError 表示目标、图操作或所有权约束无效; DisposedError 表示运行时已关闭解析。debugName 是可选诊断标签, 不参与身份或查找

## 验证策略

类型检查约束参数、输入和公开 API。运行时测试覆盖身份缓存、并发初始化、lazy 环、共享资源、动态图保护与失败后的状态, 并验证已删除句柄不能复活。vp check、vp test run 和 vp pack 分别验证静态约束、行为与发布产物
