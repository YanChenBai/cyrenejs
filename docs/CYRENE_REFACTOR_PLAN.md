# 固定依赖图重构

本轮取代原稳定槽位方案，按用户确认的契约实施：

- Ripple 不携带 ID；通过 app.add(entries) / app.add(key, ripple) 注册。
- 构造函数无参数，通过 ripples.key / resolve 按需创建，不提供 start / init。
- 所有依赖显式注册，配置阶段校验重复、缺失依赖和循环。
- 保留首次解析前 override，首次读取 ripples.key / 调用 resolve 后锁定注册。
- 删除运行时替换、remove、Slot、实例代理和候选事务。
- 注入真实实例，不更新消费者引用；同步服务直接返回，异步性沿强依赖传播。
- 只支持 lifetime?: 'singleton'，不实现 transient。
- 容器持有单例，Symbol.asyncDispose / Symbol.dispose 表达资源释放。
- 清理采用逆创建完成顺序，不再维护资源依赖图。
- 更新运行时、公共类型、示例、文档和声明消费测试。
- 普通对象组合替代 poem，移除品牌及公开 validate。
- 注册节点统一保存原声明、当前实现与依赖边，诊断节点只暴露 key 和 state。

现行规则以 CYRENE_DESIGN.md 和根 README 为准。
