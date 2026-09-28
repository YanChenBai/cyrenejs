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
const first = { count: ripple('count', () => 1) };
export const providers = { ...first, label: ripple('label', () => 'ready') };
export const combined = { ...providers };
export function createRuntime() { return new Cyrene().use(...Object.values(combined)).use(ripple('enabled', () => true)); }
export async function createApp() {
  const runtime = createRuntime();
  const container = runtime;
  const count: number = await container.resolve('count');
  const label: string = await container.resolve('label');
  // @ts-expect-error 保留消费方容器的精确类型。
  const wrong: boolean = await container.resolve('count');
  // @ts-expect-error 替换结果必须兼容目标服务类型。
  runtime.override(providers.count, ripple('replacement1', () => 'wrong'));
  const transient = ripple('transient', () => ({ value: 1 }), { lifetime: 'transient' });
  const asyncTransient = ripple('asyncTransient', async () => 1, { lifetime: 'transient' });
  const transientApp = new Cyrene().use(transient, asyncTransient);
  const transientResult: { value: number } = transientApp.resolve(transient);
  const transientPromise: Promise<number> = transientApp.ripples.asyncTransient;
  // @ts-expect-error 不支持 scoped lifetime。
  ripple('replacement2', () => 1, { lifetime: 'scoped' });
  const enabled: boolean = await container.resolve('enabled');
  const byDeclaration: number = await container.resolve(providers.count);
  // @ts-expect-error 声明不再可调用。
  combined.count();
  return { runtime, container, count, label, enabled, byDeclaration };
}

// 内部节点不暴露为属性，但声明解析保留精确类型。
const internal = ripple('internal', () => ({ value: 42 }));
const entry = ripple('entry', { internal }, deps => deps.internal);
export const publicOnly = new Cyrene().use(entry);
const publicValue: { value: number } = publicOnly.ripples.entry;
const internalValue: { value: number } = publicOnly.resolve(internal);
// @ts-expect-error 自动收集不增加公开属性。
publicOnly.ripples.internal;
// @ts-expect-error 内部声明覆盖也必须满足原始结果契约。
publicOnly.override(internal, ripple('bad', () => 'wrong'));
// @ts-expect-error 不接受对象映射。
new Cyrene().use({ entry });
// @ts-expect-error 不再提供 add。
new Cyrene().add(entry);
// @ts-expect-error key 是必填参数。
ripple(() => 1);
// @ts-expect-error 不支持按字符串覆盖。
publicOnly.override('internal', internal);

// 同步/异步返回在发布声明中保持精确，lazy 不传播目标的异步性。
const sync = ripple('sync', () => ({ count: 1 }));
const asyncValue = ripple('asyncValue', async () => ({ value: 2 }));
const parent = ripple('parent', { sync, asyncValue, text: 'plain' }, ({ asyncValue }) => asyncValue.value);
const top = ripple('top', { parent }, ({ parent }) => String(parent));
const lazyParent = ripple('lazyParent', { asyncValue: lazy(() => asyncValue), sync: lazy(() => sync) }, deps => deps);
const typed = new Cyrene().use(sync, asyncValue, parent, top, lazyParent);
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
typed.override(sync, ripple('replacement3', async () => ({ count: 2 })));
// @ts-expect-error 替换不能改变异步契约。
typed.override(asyncValue, ripple('replacement4', () => ({ value: 2 })));
const dynamicApp = new Cyrene();
const registered = dynamicApp.use(sync);
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
const optionalParent = ripple('optionalParent', { maybe }, () => 1);
const alwaysAsync = ripple('alwaysAsync', { maybe }, async () => 1);
const uncertainApp = new Cyrene().use(maybe, optionalParent, alwaysAsync);
const uncertain: number | Promise<number> = uncertainApp.ripples.optionalParent;
// @ts-expect-error 动态选择的依赖无法保证异步。
const uncertainPromise: Promise<number> = uncertainApp.ripples.optionalParent;
const definitePromise: Promise<number> = uncertainApp.ripples.alwaysAsync;

// 输入对象的联合分支分别传播异步性，包括没有公共 key 的分支。
function chooseAsyncInputs(): { left: typeof asyncValue } | { right: typeof asyncValue } {
  return choose ? { left: asyncValue } : { right: asyncValue };
}
function chooseMixedInputs(): { source: typeof asyncValue } | { count: number } {
  return choose ? { source: asyncValue } : { count: 1 };
}
function chooseEmptyInputs(): { source: typeof asyncValue } | { source?: never } {
  return choose ? { source: asyncValue } : {};
}
const unionAsync = ripple('unionAsync', chooseAsyncInputs(), () => 42);
const unionMixed = ripple('unionMixed', chooseMixedInputs(), () => 42);
const unionEmpty = ripple('unionEmpty', chooseEmptyInputs(), () => 42);
const unionApp = new Cyrene().use(unionAsync, unionMixed, unionEmpty);
const unionPromise: Promise<number> = unionApp.ripples.unionAsync;
const unionResult: number | Promise<number> = unionApp.ripples.unionMixed;
const unionEmptyResult: number | Promise<number> = unionApp.ripples.unionEmpty;
// @ts-expect-error 所有输入分支都异步时不能当作同步值。
const wrongUnionSync: number = unionApp.ripples.unionAsync;
// @ts-expect-error 混合同步与异步分支不能保证同步。
const wrongMixedSync: number = unionApp.ripples.unionMixed;
// @ts-expect-error 混合同步与异步分支也不能保证异步。
const wrongMixedPromise: Promise<number> = unionApp.ripples.unionMixed;
// @ts-expect-error 空分支可能同步完成。
const wrongEmptyPromise: Promise<number> = unionApp.ripples.unionEmpty;

// 替换保留返回值契约，依赖图由运行时检查。
const database = ripple('database', () => ({ query: (): number => 1 }));
const users = ripple('users', { database }, ({ database }) => ({ count: () => database.query() }));
const graph = new Cyrene().use(database).use(users);
graph.override(database, ripple('replacement5', { users }, ({ users }) => ({ query: () => users.count() })));
graph.override(database, ripple('replacement6', { database }, ({ database }) => ({ query: () => database.query() })));
graph.override(database, ripple('replacement7', { users: lazy(() => users) }, () => ({ query: () => 2 })));

// 不同声明结构相同，不能把同形对象当作相同运行时身份。
const left = ripple('left', () => ({ value: 1 }));
const right = ripple('right', () => ({ value: 2 }));
const independent = new Cyrene().use(left, right);
independent.override(left, ripple('replacement8', { right }, ({ right }) => ({ value: right.value })));

// 链式 override 允许中间配置形成环。
const a = ripple('a', () => ({ a: 1 }));
const b = ripple('b', () => ({ b: 1 }));
const updated = new Cyrene().use(a, b)
  .override(a, ripple('replacement9', { b }, () => ({ a: 2 })));
updated.override(b, ripple('replacement10', { a }, () => ({ b: 2 })));

// 类型可见的递归声明也允许注册，完整图留给运行时检查。
interface A extends Dependency<{ a: number }, { b: B }> {}
interface B extends Dependency<{ b: number }, { a: A }> {}
declare const recursiveA: A;
declare const recursiveB: B;
new Cyrene().use(recursiveA, recursiveB);
new Cyrene().use(recursiveA).use(recursiveB);

// 依赖类型擦除或动态 key 不产生假阳性，仍由运行时检查。
const erased: Dependency<{ query: () => number }> = database;
new Cyrene().use(erased, users);
declare const dynamic: Record<string, Dependency>;
new Cyrene().use(...Object.values(dynamic));
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
    expect(declaration).toContain('Dependency<number, {}, false, "count">');
    expect(declaration).toContain('Dependency<string, {}, false, "label">');

    writeFileSync(
      join(directory, 'cycle.ts'),
      `
import { Cyrene, ripple } from './library/index.js';
const database = ripple('database', () => ({ query: (): number => 1 }));
const users = ripple('users', { database }, ({ database }) => ({ count: () => database.query() }));
const app = new Cyrene().use(database, users);
app.override(database, ripple('replacement11', { users }, ({ users }) => ({ query: () => users.count() })));
`,
    );
    compile({
      compilerOptions: {
        target: 'ESNext',
        module: 'NodeNext',
        strict: true,
        noEmit: true,
        types: [],
      },
      files: [join(directory, 'cycle.ts')],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
