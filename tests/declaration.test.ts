import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vite-plus/test';

const require = createRequire(import.meta.url);
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const root = fileURLToPath(new URL('../', import.meta.url));

it('组合后的 Ripples 可以通过消费方导出并生成声明', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cyrene-declarations-'));

  const compile = (config: object, expectedError?: string) => {
    const path = join(directory, 'tsconfig.json');
    writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, [compiler, '-p', path], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();

    if (expectedError) {
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(expectedError);

      return;
    }

    expect(result.status, result.stdout + result.stderr).toBe(0);
  };

  try {
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));

    compile({
      extends: resolve(root, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: join(directory, 'library'),
        rootDir: resolve(root, 'src'),
        types: [],
      },
      files: [resolve(root, 'src/index.ts')],
      include: [],
    });

    writeFileSync(
      join(directory, 'consumer.ts'),
      `
import { Cyrene, ripple, lazy } from './library/index.js';
import type { Dependency } from './library/index.js';
const first = { count: ripple(() => 1) };
export const providers = { ...first, label: ripple(() => 'ready') };
export const combined = { ...providers };
export function createRuntime() { return new Cyrene().add(combined).add('enabled', ripple(() => true)); }
export async function createApp() {
  const runtime = createRuntime();
  const container = runtime;
  const count: number = await container.resolve('count');
  const label: string = await container.resolve('label');
  // @ts-expect-error 保留消费方容器的精确类型。
  const wrong: boolean = await container.resolve('count');
  // @ts-expect-error 替换结果必须兼容目标服务类型。
  runtime.override('count', ripple(() => 'wrong'));
  const transient = ripple(() => ({ value: 1 }), { lifetime: 'transient' });
  const asyncTransient = ripple(async () => 1, { lifetime: 'transient' });
  const transientApp = new Cyrene().add({ transient, asyncTransient });
  const transientResult: { value: number } = transientApp.resolve(transient);
  const transientPromise: Promise<number> = transientApp.ripples.asyncTransient;
  // @ts-expect-error 不支持 scoped lifetime。
  ripple(() => 1, { lifetime: 'scoped' });
  const enabled: boolean = await container.resolve('enabled');
  const byDeclaration: number = await container.resolve(providers.count);
  // @ts-expect-error 声明不再可调用。
  combined.count();
  return { runtime, container, count, label, enabled, byDeclaration };
}

// 同步/异步返回在发布声明中保持精确，lazy 不传播目标的异步性。
const sync = ripple(() => ({ count: 1 }));
const asyncValue = ripple(async () => ({ value: 2 }));
const parent = ripple({ sync, asyncValue, text: 'plain' }, ({ asyncValue }) => asyncValue.value);
const top = ripple({ parent }, ({ parent }) => String(parent));
const lazyParent = ripple({ asyncValue: lazy(() => asyncValue), sync: lazy(() => sync) }, deps => deps);
const typed = new Cyrene().add({ sync, asyncValue, parent, top, lazyParent });
const syncResult: { count: number } = typed.ripples.sync;
const asyncResult: Promise<{ value: number }> = typed.ripples.asyncValue;
const parentResult: Promise<number> = typed.resolve(parent);
const topResult: Promise<string> = typed.ripples.top;
const lazyResult: Promise<{ value: number }> = typed.ripples.lazyParent.asyncValue.resolve();
const lazySync: { count: number } = typed.ripples.lazyParent.sync.resolve();
// @ts-expect-error 异步服务不能当作就绪实例访问。
typed.ripples.asyncValue.value;
// @ts-expect-error 属性入口只读。
typed.ripples.sync = { count: 2 };
// @ts-expect-error 替换不能改变同步契约。
typed.override('sync', ripple(async () => ({ count: 2 })));
// @ts-expect-error 替换不能改变异步契约。
typed.override('asyncValue', ripple(() => ({ value: 2 })));
const dynamicApp = new Cyrene();
const registered = dynamicApp.add('sync', sync);
// @ts-expect-error 单独调用不能修改原变量的泛型。
dynamicApp.ripples.sync;
const captured: { count: number } = registered.ripples.sync;
const declared: { count: number } = dynamicApp.resolve(sync);
const unknownResult: unknown = dynamicApp.resolve('sync');
// @ts-expect-error 未累积的 key 只能得到 unknown。
const badDynamic: { count: number } = dynamicApp.resolve('sync');
// @ts-expect-error 没有启动阶段。
typed.start();
// @ts-expect-error 没有初始化入口。
typed.init();
// @ts-expect-error 不再接收启动失败选项。
new Cyrene({ startupFailure: 'dispose' });

// 不确定的分支保留联合类型，显式异步工厂始终返回 Promise。
declare const choose: boolean;
const maybe = choose ? sync : asyncValue;
const optionalParent = ripple({ maybe }, () => 1);
const alwaysAsync = ripple({ maybe }, async () => 1);
const uncertainApp = new Cyrene().add({ maybe, optionalParent, alwaysAsync });
const uncertain: number | Promise<number> = uncertainApp.ripples.optionalParent;
// @ts-expect-error 动态选择的依赖无法保证异步。
const uncertainPromise: Promise<number> = uncertainApp.ripples.optionalParent;
const definitePromise: Promise<number> = uncertainApp.ripples.alwaysAsync;

// 强依赖元数据跨 declaration emit 仍可用于检查替换。
const database = ripple(() => ({ query: (): number => 1 }));
const users = ripple({ database }, ({ database }) => ({ count: () => database.query() }));
const graph = new Cyrene().add({ database }).add('users', users);
// @ts-expect-error database -> users -> database。
graph.override('database', ripple({ users }, ({ users }) => ({ query: () => users.count() })));
// @ts-expect-error 直接自依赖。
graph.override('database', ripple({ database }, ({ database }) => ({ query: () => database.query() })));
graph.override('database', ripple({ users: lazy(() => users) }, () => ({ query: () => 2 })));

// 不同声明结构相同，不能把同形对象当作相同运行时身份。
const left = ripple(() => ({ value: 1 }));
const right = ripple(() => ({ value: 2 }));
const independent = new Cyrene().add({ left, right });
independent.override('left', ripple({ right }, ({ right }) => ({ value: right.value })));

// 链式 override 保留新边，检查后续替换形成的环。
const a = ripple(() => ({ a: 1 }));
const b = ripple(() => ({ b: 1 }));
const updated = new Cyrene().add({ a, b })
  .override('a', ripple({ b }, () => ({ a: 2 })));
// @ts-expect-error a -> b -> a。
updated.override('b', ripple({ a }, () => ({ b: 2 })));

// 类型可见的递归声明在批量 add 时拒绝。
interface A extends Dependency<{ a: number }, { b: B }> {}
interface B extends Dependency<{ b: number }, { a: A }> {}
declare const recursiveA: A;
declare const recursiveB: B;
// @ts-expect-error 注册图存在强依赖环。
new Cyrene().add({ a: recursiveA, b: recursiveB });
// @ts-expect-error 单项 add 闭合已有的强依赖路径。
new Cyrene().add('a', recursiveA).add('b', recursiveB);

// 依赖类型擦除或动态 key 不产生假阳性，仍由运行时检查。
const erased: Dependency<{ query: () => number }> = database;
new Cyrene().add({ database: erased, users });
declare const dynamic: Record<string, Dependency>;
new Cyrene().add(dynamic);
`,
    );

    compile({
      compilerOptions: {
        target: 'ESNext',
        module: 'NodeNext',
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: join(directory, 'output'),
        types: [],
      },
      files: [join(directory, 'consumer.ts')],
    });

    const declaration = readFileSync(join(directory, 'output/consumer.d.ts'), 'utf8');
    expect(declaration).toContain('count: number');
    expect(declaration).toContain('label: string');
    expect(declaration).toContain('Dependency<number, {}, false>');
    expect(declaration).toContain('Dependency<string, {}, false>');

    writeFileSync(
      join(directory, 'cycle.ts'),
      `
import { Cyrene, ripple } from './library/index.js';
const database = ripple(() => ({ query: (): number => 1 }));
const users = ripple({ database }, ({ database }) => ({ count: () => database.query() }));
const app = new Cyrene().add({ database, users });
app.override('database', ripple({ users }, ({ users }) => ({ query: () => users.count() })));
`,
    );
    compile(
      {
        compilerOptions: {
          target: 'ESNext',
          module: 'NodeNext',
          strict: true,
          noEmit: true,
          types: [],
        },
        files: [join(directory, 'cycle.ts')],
      },
      'Circular dependency',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
