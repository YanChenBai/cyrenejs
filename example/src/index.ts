import { runAsync } from './async.ts';
import { runBasic } from './basic.ts';
import { runRegistration } from './registration.ts';

process.stdout.write('\n=== 同步服务、替换与清理 ===\n');
await runBasic();
process.stdout.write('\n=== 异步依赖、lazy 与并发 ===\n');
await runAsync();
process.stdout.write('\n=== 分步注册与外部资源 ===\n');
await runRegistration();
