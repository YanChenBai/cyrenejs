import { describe, expect, expectTypeOf, it } from 'vite-plus/test';

import { RIPPLE_BRAND, POEM_BRAND } from '../src/brands.ts';
import { Cyrene, InvalidDependencyError, poem, isRipple, isPoem, ripple } from '../src/index.ts';
import type { Dependency, Poem } from '../src/index.ts';

describe('Ripple 识别', () => {
  it('拒绝 Symbol 和不可枚举入口, 接受已标记及展开组合后的集合', async () => {
    const service = ripple({}, () => 1);
    const symbol = Symbol('entry');

    const invalid = [
      { [symbol]: service },
      Object.defineProperty({}, 'hidden', { value: service }),
      Object.defineProperty({}, symbol, { value: service }),
    ];

    for (const ripples of invalid) {
      expect(() => poem(ripples as never)).toThrow(InvalidDependencyError);
      expect(() => new Cyrene({ ripples: ripples as never })).toThrow(InvalidDependencyError);
    }

    expect(() => poem({ bad: 1 } as never)).toThrow(InvalidDependencyError);
    const first = poem({ service });
    const combined = poem({ ...first, other: service });
    const app = new Cyrene({ ripples: combined });
    expect(await app.start()).toBeUndefined();
    expect(await app.resolve(service)).toBe(1);
    await app.dispose();
    expect(() => poem(Object.freeze({ service }))).toThrow(TypeError);
    expect(poem(Object.freeze(first))).toBe(first);

    const checkInvalidKeys = () => {
      // @ts-expect-error Symbol 不能作为入口名
      poem({ [symbol]: service });
      // @ts-expect-error 普通入口对象也禁止 Symbol 键
      new Cyrene({ ripples: { service, [symbol]: service } });
      // @ts-expect-error 数字入口名应显式写为字符串
      poem({ 1: service });
      // @ts-expect-error 构造时同样限制数字入口名
      new Cyrene({ ripples: { 1: service } });
    };

    expectTypeOf(checkInvalidKeys).toBeFunction();
  });

  it('分别识别定义与集合, 标识不可枚举或修改', () => {
    const service = ripple({}, () => 1);
    const source = { service };
    const ripples = poem(source);
    expect(ripples).toBe(source);
    expect(poem(ripples)).toBe(ripples);
    expect(isRipple(service)).toBe(true);
    expect(isPoem(ripples)).toBe(true);
    expect(isRipple(ripples)).toBe(false);
    expect(isPoem(service)).toBe(false);
    expect(isRipple(service())).toBe(false);
    expect(Object.keys(ripples)).toEqual(['service']);
    expect(isPoem({ ...ripples })).toBe(false);

    for (const [value, symbol] of [
      [service, RIPPLE_BRAND],
      [ripples, POEM_BRAND],
    ] as const) {
      expect(Object.getOwnPropertyDescriptor(value, symbol)).toEqual({
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }

    expectTypeOf(service[RIPPLE_BRAND]).toEqualTypeOf<true>();
    expectTypeOf(ripples[POEM_BRAND]).toEqualTypeOf<true>();
  });

  it('拒绝普通值, 错误标识与继承标识', () => {
    const service = ripple({}, () => 1);
    const ripples = poem({ service });

    for (const value of [
      undefined,
      null,
      false,
      1,
      'value',
      Symbol(),
      {},
      [],
      () => {},
      { [RIPPLE_BRAND]: true },
      { [POEM_BRAND]: false },
      Object.assign(() => {}, { [RIPPLE_BRAND]: false }),
      Object.create(ripples),
      Object.setPrototypeOf(() => {}, service),
    ]) {
      expect(isRipple(value)).toBe(false);
      expect(isPoem(value)).toBe(false);
    }

    const checkNarrowing = (value: unknown) => {
      if (isRipple(value)) {
        expectTypeOf(value).toEqualTypeOf<Dependency<unknown, never[]>>();
      }

      if (isPoem(value)) {
        expectTypeOf(value).toEqualTypeOf<Poem>();
      }
    };

    expectTypeOf(checkNarrowing).toBeFunction();
  });

  it('保留入口和依赖输入的推导, 解析结果不包含集合标识', async () => {
    const config = ripple({}, () => 'test');
    const service = ripple({}, (_deps, name: string) => name.length);

    const ripples = poem({
      config,
      count: service('users'),
      ready: ripple({}, () => true),
    });

    const app = new Cyrene({ ripples });
    await app.start();
    const result = await app.add(ripple(ripples, inputs => inputs));
    expectTypeOf(result.count).toEqualTypeOf<number>();
    expectTypeOf(result.config).toEqualTypeOf<string>();
    expectTypeOf(result.ready).toEqualTypeOf<boolean>();
    expectTypeOf<keyof typeof result>().toEqualTypeOf<'config' | 'count' | 'ready'>();
    expect(Reflect.ownKeys(result)).toEqual(['config', 'count', 'ready']);

    const combined = ripple(ripples, inputs => {
      expectTypeOf<keyof typeof inputs>().toEqualTypeOf<'config' | 'count' | 'ready'>();
      return inputs.count;
    });

    expect(await app.add(combined)).toBe(5);
    await app.dispose();

    const checkInvalidCalls = () => {
      // @ts-expect-error 普通值不能作为入口
      poem({ invalid: 123 });
      // @ts-expect-error 参数化定义必须先创建 Ref
      poem({ service });
    };

    expectTypeOf(checkInvalidCalls).toBeFunction();
  });
});
