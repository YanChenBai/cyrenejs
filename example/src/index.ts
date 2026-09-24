import { Cyrene, poem, formatGraph, lazy, ripple } from '../../src/index.ts';

const write = (message: string) => process.stdout.write(`${message}\n`);

const config = ripple({}, () => ({ databaseUrl: 'memory://demo', logLevel: 'info' }), {
  debugName: 'Config',
});

const logger = ripple(
  { config },
  ({ config }, scope: string) => ({
    info: (message: string) => write(`[${config.logLevel}][${scope}] ${message}`),
  }),
  { debugName: 'Logger' },
);

// 复用同一个 Ref, 让两个服务共享日志实例
const appLogger = logger('demo');

const database = ripple(
  { config },
  ({ config }) => {
    write(`连接数据库: ${config.databaseUrl}`);
    return { users: ['Alice', 'Bob'] };
  },
  {
    debugName: 'Database',
    dispose: () => {
      write('释放数据库');
    },
  },
);

const report = ripple(
  { database },
  ({ database }) => {
    write('初始化报表服务');
    return { count: () => database.users.length };
  },
  { debugName: 'Report' },
);

const users = ripple(
  { database, logger: appLogger, report: lazy(() => report) },
  inputs => ({
    list: () => inputs.logger.info(`用户: ${inputs.database.users.join(', ')}`),
    report: inputs.report,
  }),
  {
    debugName: 'Users',
    dispose: () => {
      write('释放用户服务');
    },
  },
);

const audit = ripple(
  { logger: appLogger },
  ({ logger }) => ({
    record: () => logger.info('审计完成'),
  }),
  { debugName: 'Audit' },
);

const app = new Cyrene({
  ripples: poem({ users, audit }),
});

try {
  write('=== 完整依赖图（此时尚未初始化） ===');
  write(formatGraph(app.inspect()));
  write('\n=== 单个入口 ===');
  write(formatGraph(app.inspect(users)));
  write('\n=== 启动 ===');
  await app.start();
  const userService = await app.resolve(users);
  const auditService = await app.resolve(audit);
  userService.list();
  auditService.record();
  write('\n=== 按需解析报表 ===');
  const reports = await userService.report.resolve();
  write(`报表用户数: ${reports.count()}`);
} finally {
  write('\n=== 释放资源 ===');
  await app.dispose();
}
