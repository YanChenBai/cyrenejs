import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

import { Cyrene, lazy, ripple } from '../../src/index.ts';

export async function runAsync(): Promise<void> {
  let connections = 0;
  const events: string[] = [];
  const Config = ripple('config', () => ({ name: 'demo' }));

  const Database = ripple('database', async () => {
    connections++;
    await setTimeout(20);

    return {
      users: ['Alice', 'Bob'],
      async [Symbol.asyncDispose]() {
        await setTimeout(5);
        events.push('database');
      },
    };
  });

  const Users = ripple('users', { database: Database }, ({ database }) => ({
    list: () => database.users,
    [Symbol.dispose]() {
      events.push('users');
    },
  }));

  // Report 本身同步创建，只有 run() 才解析异步目标。
  const Report = ripple('report', { users: lazy(() => Users) }, ({ users }) => ({
    run: async () => (await users.resolve()).list().join(', '),
  }));

  {
    await using app = new Cyrene().use(Config, Users, Report);
    const report = app.ripples.report;
    assert.equal(Number(connections), 0);
    process.stdout.write(`${app.ripples.config.name}: Report 已创建, 数据库尚未连接\n`);

    const first = app.ripples.users;
    assert.equal(first, app.resolve(Users));
    assert.equal(first, app.resolve('users'));
    const [left, right, content] = await Promise.all([first, app.ripples.users, report.run()]);
    assert.equal(left, right);
    assert.equal(Number(connections), 1);
    assert.equal(app.ripples.users, first);
    process.stdout.write(`并发结果: ${content}; 数据库创建 ${connections} 次\n`);
  }

  assert.deepEqual(events, ['users', 'database']);
  process.stdout.write(`清理顺序: ${events.join(' -> ')}\n`);
}
