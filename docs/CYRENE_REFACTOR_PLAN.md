# 具名声明与自动依赖收集重构

本轮按确认的契约实施：

- ripple(key, factory) / ripple(key, deps, factory)，key 属于不可变声明。
- use(...ripples) 替代 add 的对象映射与字符串注册，支持链式调用和多个入口。
- 只在 app.ripples 暴露显式 use 的声明，依赖闭包在运行时自动收集。
- 同一声明共享节点，重复 use 幂等；不同原声明同 key 报错。
- 首次解析或 inspect 构图，包含强依赖与 lazy 目标，成功后缓存。
- override(original, replacement) 保留原 key 和公开范围，检查返回值及同步/异步契约。
- 只收集有效实现的依赖；不可达覆盖目标报错，同一目标最后一次覆盖生效。
- 首次解析尝试锁定配置，inspect 不锁定；解析仍按需执行。
- 保留 singleton / transient、同步与异步结果、lazy 等待环检测和 Symbol 资源释放。
- 同步迁移类型、测试、示例、README、设计文档和随包发布的 skill。

现行规则以 [设计文档](./CYRENE_DESIGN.md) 和根 README 为准。
