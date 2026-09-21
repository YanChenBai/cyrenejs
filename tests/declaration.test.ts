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
import { Cyrene, defineRipples, ripple } from './library/index.js';
const first = defineRipples({ count: ripple({}, () => 1) });
export const providers = defineRipples({ ...first, label: ripple({}, () => 'ready') });
export const combined = defineRipples({ ...providers });
export function createRuntime() { return new Cyrene({ ripples: combined }); }
export async function createApp() {
  const runtime = createRuntime();
  const container = await runtime.start();
  const count: number = container.count;
  const label: string = container.label;
  // @ts-expect-error 保留消费方容器的精确类型。
  const wrong: boolean = container.count;
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
    expect(declaration).toContain('RipplesBrand');
    expect(declaration).not.toContain('RIPPLES_SYMBOL');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
