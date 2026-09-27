# Cyrene 固定依赖图设计

## 模型

Ripple 是无名称的不可变工厂声明；容器注册 key 是运行时服务身份。
每个容器独立拥有声明注册表、单例初始化缓存、待完成初始化集合和资源清理顺序。

工厂依赖继续引用 Ripple 对象，普通输入不参与图。
构图时建立声明到 key 的映射，再把输入转换为指向 key 的边。
不维护 Slot、实例版本、注入代理、反向删除边或候选事务。

## 模块职责

| 模块                                 | 职责                                          |
| ------------------------------------ | --------------------------------------------- |
| ripple / dependency                  | 工厂重载、不可变配方与声明身份                |
| registry                             | 完整注册校验、声明到 key 的映射、强依赖环检查 |
| cyrene                               | 解析前配置、单例解析、等待环检测、容器关闭    |
| resources                            | 对象所有权去重与逆创建顺序清理                |
| lazy                                 | 延迟依赖声明                                  |
| types / validation / utils / symbols | 公共契约与输入校验                            |
| format-graph                         | 格式化诊断快照                                |

## 配置阶段

new Cyrene 不接收选项；没有 start、init 或启动失败策略。
app.add(entries) 和 app.add(key, declaration) 返回同一容器；返回类型累积注册 key。
每次配置先构建并校验新注册表，再同步发布。失败不会污染原表。
只维护一张注册表：每个节点保存 original、implementation 和 dependencies。
original 保留原声明的定位关系，implementation 指定当前工厂；重建时邻接集合独立复制。
普通对象及对象展开承担注册集合组合，无需品牌类型。
依赖必须已注册或在同批 add 中；同一 Ripple 只能对应一个 key。

override(key, replacement) 保留原注册声明的定位关系，使用替身的工厂和依赖。
不同 key 不允许共用同一个原声明或当前替身。反复 override 只保留原声明与当前替身的映射。

首次读取 ripples.key / 调用 resolve 同步锁定配置，失败也不解锁。
没有运行时 add、override、remove，不存在资源换代与引用更新。
合法性在配置修改时自动校验，不再提供公开 validate。
inspect 导出的节点只包含 key 和 state，formatGraph 直接显示 key。

## 解析

支持 singleton（默认）与 transient，使用当前 implementation 的 lifetime。
singleton 执行工厂前先缓存初始化记录，防止同步重入。同步创建直接保存值，异步创建缓存 Promise。
singleton 并发解析共享同一 Promise，完成后仍保留 Promise；失败结果缓存。
transient 每次解析创建独立 Resolution，不缓存实例、Promise 或失败；每个强依赖输入和每次 lazy.resolve 都独立解析。
singleton 消费者只在首次初始化时创建并持有其 transient 依赖，不在后续业务调用时重新注入。
Resolution 保存创建方，尚在初始化的创建链不得递归展开同一声明；同步执行栈另行拦截公共解析重入。
等待边以具体 Resolution 为单位，互不关联的并发 transient 不合并。
inspect 的 state 记录该 key 最近一次初始化状态变化，不是全部并发实例的聚合状态。
强依赖并行初始化；失败等待同批所有分支结束，避免丢失晚到资源。
工厂成功返回后，按真实对象登记所有权，再完成初始化。

ripples.key、resolve(key) / resolve(Ripple) 按需初始化目标，不预热其他注册项。
属性入口使用只读访问器视图，服务实例本身不代理。
同步工厂且强依赖均同步则直接返回实例，否则等待异步强依赖后执行工厂。
普通 Promise 输入不展开；lazy 目标异步不改变消费者的同步性。
同步创建失败和入口错误直接抛错；异步创建失败拒绝 Promise，资源由调用方关闭容器释放。
声明解析按原声明或当前实现的对象身份查找注册 key，不自动注册未知声明。
lazy 提供绑定容器的解析句柄，不代理服务实例。
lazy 边不参与强环检查，初始化期间的 waiting 集合检测 Promise 消费形成的等待环。
仅调用 lazy.resolve() 启动异步目标不建立等待边；await、返回给异步工厂和 then 消费才登记。
初始化期间同一句柄按目标 Resolution 复用 Promise 子类包装，身份与公共解析入口不同；owner 就绪后直接返回解析结果。
singleton 仍复用缓存 Promise；transient 每次调用拥有独立实例记录和 Promise 包装。
then/catch/finally 也视为等待，运行时不能判断回调链是否只用于旁路观察。
owner 初始化成功或失败时清空其等待边，避免后台启动的目标留下过期关系。
waiting 只服务于解析，不承担资源释放排序。

## 关闭

状态依次为 configuring、active、disposing、disposed。
dispose 立即关闭公共入口；已接收初始化可以继续解析强依赖。
正在初始化的工厂也可以完成其 lazy 解析。已就绪服务的 lazy 句柄停止接受新工作。

等所有初始化结束后，资源按首次成功登记的逆序释放。
成功创建的 owned transient 同样保留到容器关闭，不在一次业务调用结束时释放。
优先 Symbol.asyncDispose，其次 Symbol.dispose；错误聚合后报告。
同一对象只登记一次；owned 和 borrowed 冲突报错。
不识别普通 dispose 方法，也不接受选项式 disposer。

强依赖先创建，因此消费者先清理；实例是真实引用，不会提前撤销。
lazy 在创建后激活以及对象别名不承诺额外的依赖拓扑释放顺序。
容器不追踪业务方法、流或后台任务；应用先停止并等待这些工作，再 dispose。
工厂创建后尚未返回的资源由工厂负责错误清理。

## 类型边界

ripple 推导输入与 Awaited 工厂结果。
Dependency 的第二个泛型保留输入声明，第三个泛型保留同步/异步性，只在类型层存在，不增加运行时元数据。
链式 add 保留 key 与结果对应关系，override 使用 NoInfer 约束替身结果和同步/异步契约，避免旧 lazy 句柄类型失真。
容器第二个泛型保存当前实现类型，链式 override 更新它。
graph-types 只在声明结构能唯一对应 key 时建立类型边，以路径搜索检查强依赖环。
lazy 边不参与类型搜索，同形声明、宽字符串 key、类型擦除及未捕获返回值的变更
可能无法静态检出，仍依赖运行时检查。
独立 app.add(...) 修改对象不会改变原变量的泛型；ripples 不会出现未捕获的新增 key 类型提示，resolve(key) 返回 unknown，
也可通过 resolve(Ripple) 直接推导实例类型。运行时仍检查注册身份，不要用 any 掩盖此边界。

消费方声明生成测试与库打包分别验证。
