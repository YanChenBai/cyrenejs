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

it('对象 Poem 与数组依赖可以通过消费方导出并生成声明', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cyrene-declarations-'));

  const compile = (config: object) => {
    const path = join(directory, 'tsconfig.json');
    writeFileSync(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, [compiler, '-p', path], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
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
import { Cyrene, poem, ripple } from './library/index.js';
const first = poem({ count: ripple(() => 1) });
export const providers = poem({ ...first, label: ripple(() => 'ready') });
export const combined = poem({ ...providers });
export const list = [first.count, providers.label] as const;
export const joined = ripple(list, ([count, label]) => ({ count, label }));
export function createRuntime() { return new Cyrene({ ripples: combined }); }
export async function createApp() {
  const runtime = createRuntime();
  const startup: void = await runtime.start();
  const container = await runtime.resolve(ripple(combined, inputs => inputs));
  const count: number = container.count;
  const label: string = container.label;
  // @ts-expect-error 保留消费方容器的精确类型。
  const wrong: boolean = container.count;
  const arrayRuntime = new Cyrene({ ripples: list });
  await arrayRuntime.start();
  const tuple: [number, string] = await arrayRuntime.resolve(ripple(list, inputs => inputs));
  // @ts-expect-error 元组保留元素顺序与类型
  const wrongTuple: [string, number] = tuple;
  return { runtime, container, count, label };
}
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
    expect(declaration).toContain('PoemBrand');
    expect(declaration).not.toContain('POEM_BRAND');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
