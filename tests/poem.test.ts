import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test';

import { Cyrene, InvalidDependencyError, isPoem, lazy, poem, ripple } from '../src/index.ts';
import type { Dependency, Resolvable } from '../src/index.ts';

describe('Poem 对象入口', () => {
  it('标记原对象并保留精确类型, 声明时不执行 Ripple factory', async () => {
    const factory = vi.fn(() => 1);
    const count = ripple(factory);
    const label = ripple((_value: string) => 'unused');
    const ref = label('ready');
    const source = { count, label: ref };
    const collection = poem(source);

    expect(collection).toBe(source);
    expect(poem(collection)).toBe(collection);
    expect(isPoem(collection)).toBe(true);
    expect(isPoem({ ...collection })).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    expectTypeOf(collection.count).toEqualTypeOf<typeof count>();
    expectTypeOf(collection.label).toEqualTypeOf<typeof ref>();

    await using app = new Cyrene({ ripples: collection });
    await app.start();
    expect(await app.resolve(count)).toBe(1);
    expect(await app.resolve(ref)).toBe('unused');
  });

  it('支持空对象以及直接传给 Cyrene 的数组入口', async () => {
    const service = ripple(() => 1);
    await using empty = new Cyrene({ ripples: poem({}) });
    await using array = new Cyrene({ ripples: [service] });

    expect(await empty.start()).toBeUndefined();
    expect(empty.inspect()).toEqual({ roots: [], nodes: [], edges: [] });
    expect(await array.start()).toBeUndefined();
    expect(await array.resolve(service)).toBe(1);
  });

  it('同步调用构图函数一次, 保留入口类型并校验返回值', async () => {
    const service = ripple(() => 7);
    const create = vi.fn(() => ({ service }));
    const collection = poem(create);

    expect(create).toHaveBeenCalledOnce();
    expect(collection).toEqual({ service });
    expectTypeOf(collection.service).toEqualTypeOf<typeof service>();

    await using app = new Cyrene({ ripples: collection });
    await app.start();
    expect(await app.resolve(collection.service)).toBe(7);

    expect(() => poem(() => null as never)).toThrow(InvalidDependencyError);
    expect(() => poem(() => ({ invalid: 1 }) as never)).toThrow(InvalidDependencyError);

    const checkTypes = () => {
      // @ts-expect-error 构图函数只能返回可解析的对象入口
      poem(() => ({ invalid: 1 }));
      // @ts-expect-error 异步构图函数不能作为 Poem 入口
      poem(async () => ({ service }));
    };

    expectTypeOf(checkTypes).toBeFunction();
  });

  it('Poem 可作为 ripple 输入, 工厂收到已解析对象', async () => {
    const count = ripple(() => 2);
    const label = ripple(() => 'ready');
    const inputs = poem({ count, label });

    const combined = ripple(inputs, values => {
      expectTypeOf(values.count).toEqualTypeOf<number>();
      expectTypeOf(values.label).toEqualTypeOf<string>();
      expectTypeOf<keyof typeof values>().toEqualTypeOf<'count' | 'label'>();
      expect(Reflect.ownKeys(values)).toEqual(['count', 'label']);
      return `${values.label}:${values.count}`;
    });

    await using app = new Cyrene({ ripples: { combined } });
    await app.start();
    expect(await app.resolve(combined)).toBe('ready:2');

    const callback = vi.fn();

    const withValues = ripple([count, callback, lazy(() => label)], async ([value, fn, later]) => {
      expectTypeOf(value).toEqualTypeOf<number>();
      expect(fn).toBe(callback);
      return `${await later.resolve()}:${value}`;
    });

    expect(await app.add(withValues)).toBe('ready:2');
    expect(callback).not.toHaveBeenCalled();
  });

  it('组合时传入具体 ripple, 不同图使用不同实现', async () => {
    const compose = (name: Dependency<string>) => {
      const dependencies = poem({ name });
      const service = ripple(dependencies, ({ name }) => ({ name }));
      return poem({ service });
    };

    const productionGraph = compose(ripple(() => 'production'));
    const testGraph = compose(ripple(() => 'test'));
    await using production = new Cyrene({ ripples: productionGraph });
    await using testing = new Cyrene({ ripples: testGraph });
    await production.start();
    await testing.start();
    expect((await production.resolve(productionGraph.service)).name).toBe('production');
    expect((await testing.resolve(testGraph.service)).name).toBe('test');
  });

  it('数组入口启动仍先校验全部可达依赖', async () => {
    const factory = vi.fn(() => 1);
    const invalid = ripple({ later: lazy(() => 1 as never) }, () => 2);
    await using app = new Cyrene({ ripples: [ripple(factory), invalid] });
    await expect(app.start()).rejects.toBeInstanceOf(InvalidDependencyError);
    expect(factory).not.toHaveBeenCalled();
  });

  it('拒绝数组、展开参数、空调用和非法对象', () => {
    const service = ripple(() => 1);
    const sparse: Resolvable[] = [];
    sparse.length = 1;

    for (const value of [null, 1, [service], sparse, { invalid: 1 }]) {
      expect(() => poem(value as never)).toThrow(InvalidDependencyError);
    }

    expect(() => poem(() => [service] as never)).toThrow(InvalidDependencyError);
    expect(() => poem(service as never)).toThrow(InvalidDependencyError);
    expect(() => (poem as (...args: unknown[]) => unknown)()).toThrow(InvalidDependencyError);
    expect(() => (poem as (...args: unknown[]) => unknown)(service, service)).toThrow(
      InvalidDependencyError,
    );

    const checkTypes = () => {
      const parameterized = ripple((value: number) => value);
      // @ts-expect-error 数组不是 Poem 入口
      poem([service]);
      // @ts-expect-error 不再提供展开参数形式
      poem(service, service);
      // @ts-expect-error 不再提供空调用形式
      poem();
      // @ts-expect-error 参数化定义必须先创建 Ref
      poem({ parameterized });
      // @ts-expect-error 构图函数不能返回数组
      poem(() => [service]);
      const app = new Cyrene({ ripples: [service] });
      expectTypeOf(app.start()).toEqualTypeOf<Promise<void>>();
    };

    expectTypeOf(checkTypes).toBeFunction();
  });
});
