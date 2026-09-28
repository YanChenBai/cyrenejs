# Cyrene 固定依赖图设计

## 模型

Ripple 是携带非空字符串 key 的不可变工厂声明；容器以原声明 key 标识运行时节点。
每个容器独立拥有声明注册表、单例初始化缓存、待完成初始化集合和资源清理顺序。

工厂依赖继续引用 Ripple 对象，普通输入不参与图。
构图时建立声明到 key 的映射，再把输入转换为指向 key 的边。
不维护 Slot、实例版本、注入代理、反向删除边或候选事务。

## 模块职责

| 模块                    | 职责                                                  |
| ----------------------- | ----------------------------------------------------- |
| ripple / dependency     | 工厂重载、不可变配方与声明身份                        |
| registry                | 依赖闭包收集、覆盖应用、身份与 key 校验、强依赖环检查 |
| cyrene                  | 解析前配置、单例解析、等待环检测、容器关闭            |
| resources               | 对象所有权去重与逆创建顺序清理                        |
| lazy                    | 延迟依赖声明                                          |
| types / utils / symbols | 公共契约与输入校验                                    |
| format-graph            | 格式化诊断快照                                        |

## 配置阶段

new Cyrene 不接收选项；没有 start、init 或启动失败策略。
app.use(...declarations) 返回同一容器；返回类型只累积显式入口的 key。
入口整批验证身份和重名后写入；同一声明重复 use 幂等。
ripples 的运行时属性也只包含显式入口，内部依赖可以通过后续 use 提升为入口。

配置保存 roots 和 overrides，构图在首次解析或 inspect 时执行，成功后缓存。
从 roots 沿有效实现的直接输入遍历强依赖和 lazy 目标，普通嵌套对象不参与遍历。
每个节点保留 original、implementation 和 dependencies；同一原声明去重，不同原声明同 key 报错。
发布编译结果前检查全部强依赖环，失败不缓存半成品。有效配置变更使编译缓存失效。
lazy 回调必须稳定且无副作用，构图时求值，配置不变时无需重复求值。

override(original, replacement) 以原声明定位，保持原 key 与公开范围，结果和同步/异步契约由原声明约束。
只遍历替身使用的依赖，原实现独有依赖不会进入图。仍被其他路径引用的依赖继续保留。
允许先覆盖后 use，目标可达性在构图时检查；不可达覆盖（包括因上层替换而被裁剪的目标）报错。
同一目标最后一次覆盖生效；override(original, original) 恢复原实现。
原声明和当前替身都能解析到原 key，旧替身不再保留映射。
一个声明不能同时占据多个槽位；同一替身不能同时用于多个覆盖或独立入口。

首次读取 ripples.key / 调用 resolve 同步锁定配置，构图或初始化失败也不解锁。
没有激活后的 use、override、remove，不存在资源换代与引用更新。
inspect 不锁定配置也不执行工厂；roots 只包含显式入口，nodes 和 edges 包含整个有效图。
节点只包含 key 和 state，formatGraph 直接显示原声明 key。

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

ripple 推导 key 字面量、输入与 Awaited 工厂结果。
Dependency 的第二个泛型保留输入声明，第三个泛型保留同步/异步性，第四个泛型保留 key。
运行时公开只读 key，工厂配方仍保存在内部 WeakMap。
链式 use 仅映射显式入口的 key，不在类型层递归展开依赖图。
override 使用 NoInfer 从原声明约束替身结果和同步/异步契约，不受是否显式 use 的影响。
强依赖环仅按运行时对象身份检查，不进行结构类型循环推导。
独立 app.use(...) 不改变原变量泛型；接住返回值可以获得新增属性提示。
resolve(Ripple) 始终从声明推导实例类型；仅类型已累积的 key 可通过 resolve(key) 获得精确类型，其余返回 unknown。
显式将 Dependency 的 key 擦除为 string 会失去精确入口提示，应保留推导或标注第四个泛型。

消费方声明生成测试与库打包分别验证。
