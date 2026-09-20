import { describe, expect, expectTypeOf, it, vi } from 'vite-plus/test';

import { Cyrene, ripple, token } from '../src/index.ts';
import type { Binding, DependencyRef } from '../src/index.ts';

describe('依赖定义与输入', () => {
  it('推导参数和异步实例类型, 声明时不执行工厂', async () => {
    const Config = token<{ prefix: string }>('Config');

    const factory = vi.fn(
      async ({ config }: { config: { prefix: string } }, name: string, count: number = 1) => ({
        label: config.prefix + name,
        count,
      }),
    );

    const service = ripple({ config: Config }, factory);
    const ref = service('users', 2);
    expect(factory).not.toHaveBeenCalled();

    const app = new Cyrene({
      providers: { users: ref },
      bindings: [{ token: Config, value: { prefix: 'test:' } }],
    });

    expect(factory).not.toHaveBeenCalled();
    const result = await app.start();
    expectTypeOf(result.users).toEqualTypeOf<{ label: string; count: number }>();
    expect(result.users).toEqual({ label: 'test:users', count: 2 });
    expect(await app.resolve(ref)).toBe(result.users);
    await app.dispose();
  });

  it('保留普通值, 函数, 嵌套对象和 Symbol 键', async () => {
    const symbol = Symbol('input');
    const callback = vi.fn();
    class Example {}
    const hidden = ripple({}, vi.fn());
    const nested = { hidden };
    const factory = ripple({ callback, nested, Example, [symbol]: 42 }, values => values);
    const app = new Cyrene();
    const result = await app.resolve(factory);
    expect(result.callback).toBe(callback);
    expect(result.nested).toBe(nested);
    expect(result.Example).toBe(Example);
    expect(result[symbol]).toBe(42);
    expect(callback).not.toHaveBeenCalled();
    const fn = ripple({}, () => callback);
    expect(await app.resolve(fn)).toBe(callback);
    await app.dispose();
  });

  it('区分定义与 Ref 身份, 隔离不同运行时的缓存', async () => {
    const service = ripple({}, () => ({}));
    const a = service();
    const b = service();
    const app = new Cyrene();
    const other = new Cyrene();
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
    const Value = token<undefined>('Value');
    const Handler = token<() => void>('Handler');
    const handler = vi.fn();
    const inputs = { value: 1 };
    const source = ripple(inputs, ({ value }) => value);
    inputs.value = 2;
    const providers = { value: source, empty: Value, handler: Handler };
    const binding = { token: Handler, value: handler };

    const app = new Cyrene({
      providers,
      bindings: [{ token: Value, value: undefined }, binding],
    });

    providers.value = ripple({}, () => 3);
    binding.value = vi.fn();
    const result = await app.start();
    expect(result).toEqual({ value: 1, empty: undefined, handler });
    expect(handler).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('校验公开 API 的类型边界', () => {
    const required = ripple({}, (_deps, value: string) => value.length);
    const optional = ripple({}, (_deps, value = 1) => value);
    const rest = ripple({}, (_deps, ...values: number[]) => values.length);
    const mixed = ripple({}, (_deps, name: string, retry = 3) => ({ name, retry }));
    const Count = token<number>('Count');
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
      new Cyrene({ providers: { required } });
      // @ts-expect-error 可选参数也需显式创建 Ref
      void new Cyrene().resolve(optional);
      // @ts-expect-error rest 参数也需显式创建 Ref
      void new Cyrene().resolve(rest);
      // @ts-expect-error 参数化定义不能直接注入
      ripple({ required }, () => 1);
      // @ts-expect-error 精确绑定类型检查
      const bad: Binding<number> = { token: Count, value: 'no' };
      void bad;
      // @ts-expect-error 异构 bindings 也应校验 Token 与实现的关系
      new Cyrene({ bindings: [{ token: Count, value: 'no' }] });
      // @ts-expect-error dependency binding 的实例类型必须匹配
      new Cyrene({ bindings: [{ token: Count, dependency: ripple({}, () => 'no') }] });
      // @ts-expect-error 已移除 scoped
      ripple({}, () => 1, { lifetime: 'scoped' });
      // @ts-expect-error 已移除 add
      new Cyrene().add({});
      // @ts-expect-error 已移除 createScope
      new Cyrene().createScope();
    };

    expectTypeOf(checkInvalidCalls).toBeFunction();
  });
});
