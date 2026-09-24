import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test';

import { Cyrene, ripple } from '../src/index.ts';
import type { DependencyRef } from '../src/index.ts';

describe('依赖定义与输入', () => {
  it('无依赖工厂可省略 inputs, 保留 options、参数与异步结果推导', async () => {
    const dispose = vi.fn();
    const factory = vi.fn(async (name: string, retry: number = 2) => ({ name, retry }));
    const service = ripple(factory, { debugName: 'Service', dispose });
    const ref = service('users');

    expect(factory).not.toHaveBeenCalled();
    const app = new Cyrene({ ripples: { ref } });
    await app.start();
    const result = await app.resolve(ref);
    expectTypeOf(result.name).toEqualTypeOf<string>();
    expectTypeOf(result.retry).toEqualTypeOf<number>();
    expect(result).toEqual({ name: 'users', retry: 2 });
    expect(factory).toHaveBeenCalledWith('users');
    await app.dispose();
    expect(dispose).toHaveBeenCalledOnce();

    const checkTypes = () => {
      // @ts-expect-error 有业务参数的定义必须先创建 Ref
      new Cyrene({ ripples: { service } });
      // @ts-expect-error 无依赖写法不接受第三个参数
      ripple(() => 1, {}, {});
      // @ts-expect-error Ripple 暂不直接支持 class 构造器
      ripple(class Service {});
    };

    expectTypeOf(checkTypes).toBeFunction();
  });

  it('推导参数和异步实例类型, 声明时不执行工厂', async () => {
    const config = ripple({}, () => ({ prefix: 'test:' }));

    const factory = vi.fn(
      async ({ config }: { config: { prefix: string } }, name: string, count: number = 1) => ({
        label: config.prefix + name,
        count,
      }),
    );

    const service = ripple({ config }, factory);
    const ref = service('users', 2);
    expect(factory).not.toHaveBeenCalled();

    const app = new Cyrene({
      ripples: { users: ref },
    });

    expect(factory).not.toHaveBeenCalled();
    await app.start();
    const result = await app.resolve(ref);
    expectTypeOf(result).toEqualTypeOf<{ label: string; count: number }>();
    expect(result).toEqual({ label: 'test:users', count: 2 });
    expect(await app.resolve(ref)).toBe(result);
    await app.dispose();
  });

  it('保留普通值, 函数, 嵌套对象和 Symbol 键', async () => {
    const symbol = Symbol('input');
    const callback = vi.fn();
    class Example {}

    const hidden = ripple({}, vi.fn());

    const nested = { hidden };
    const factory = ripple({ callback, nested, Example, [symbol]: 42 }, values => values);
    const app = new Cyrene({ ripples: { factory } });
    await app.start();
    const result = await app.resolve(factory);
    expect(result.callback).toBe(callback);
    expect(result.nested).toBe(nested);
    expect(result.Example).toBe(Example);
    expect(result[symbol]).toBe(42);
    expect(callback).not.toHaveBeenCalled();
    const fn = ripple({}, () => callback);
    expect(await app.add(fn)).toBe(callback);
    await app.dispose();
  });

  it('区分定义与 Ref 身份, 隔离不同运行时的缓存', async () => {
    const service = ripple({}, () => ({}));
    const a = service();
    const b = service();
    const app = new Cyrene({ ripples: { service, a, b } });
    const other = new Cyrene({ ripples: { service } });
    const instance = await app.resolve(service);
    expect(await app.resolve(service)).toBe(instance);
    expect(await other.resolve(service)).not.toBe(instance);
    const first = await app.resolve(a);
    expect(first).not.toBe(instance);
    expect(await app.resolve(a)).toBe(first);
    expect(await app.resolve(b)).not.toBe(first);
    await Promise.all([app.dispose(), other.dispose()]);
  });

  it('快照保存声明, 支持外部 undefined 和函数值', async () => {
    const handler = vi.fn();
    const inputs = { value: 1 };
    const source = ripple(inputs, ({ value }) => value);
    inputs.value = 2;

    const ripples = {
      value: source,
      empty: ripple({}, () => undefined),
      handler: ripple({}, () => handler),
    };

    const app = new Cyrene({
      ripples,
    });

    ripples.value = ripple({}, () => 3);
    await app.start();
    expect(await app.add(source)).toBe(1);
    expect(await app.resolve(ripples.empty)).toBeUndefined();
    expect(await app.resolve(ripples.handler)).toBe(handler);
    expect(handler).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('校验公开 API 的类型边界', () => {
    const required = ripple({}, (_deps, value: string) => value.length);
    const optional = ripple({}, (_deps, value = 1) => value);
    const rest = ripple({}, (_deps, ...values: number[]) => values.length);
    const mixed = ripple({}, (_deps, name: string, retry = 3) => ({ name, retry }));
    expectTypeOf(optional()).toEqualTypeOf<DependencyRef<number>>();
    expectTypeOf(rest(1, 2)).toEqualTypeOf<DependencyRef<number>>();
    expectTypeOf(mixed('users')).toEqualTypeOf<DependencyRef<{ name: string; retry: number }>>();
    expectTypeOf(required('abc')).toEqualTypeOf<ReturnType<typeof required>>();

    // 仅做编译期检查, 非法调用不进入运行时
    const checkInvalidCalls = () => {
      // @ts-expect-error 参数类型必须匹配
      required(123);
      // @ts-expect-error 默认参数保留类型约束
      optional('no');
      // @ts-expect-error 缺少必填参数
      required();
      // @ts-expect-error 参数化定义不能直接作为入口
      new Cyrene({ ripples: { required } });
      // @ts-expect-error 可选参数也需显式创建 Ref
      void new Cyrene().resolve(optional);
      // @ts-expect-error rest 参数也需显式创建 Ref
      void new Cyrene().resolve(rest);
      // @ts-expect-error 参数化定义不能直接注入
      ripple({ required }, () => 1);
      // @ts-expect-error 已移除 bindings
      new Cyrene({ bindings: [] });
      // @ts-expect-error 已移除 scoped
      ripple({}, () => 1, { lifetime: 'scoped' });
      // @ts-expect-error ripple 暂不直接接受 class 构造器
      ripple({}, class Service {});
      // @ts-expect-error add 只接受 Ripple 或 Ref
      void new Cyrene().add({});
      // @ts-expect-error 已移除 createScope
      new Cyrene().createScope();
    };

    expectTypeOf(checkInvalidCalls).toBeFunction();
  });
});
