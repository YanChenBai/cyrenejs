import { describe, expect, expectTypeOf, it } from 'vite-plus/test';

import { RIPPLE_SYMBOL, RIPPLES_SYMBOL } from '../src/brands.ts';
import {
  Cyrene,
  InvalidDependencyError,
  defineRipples,
  isRipple,
  isRipples,
  ripple,
  token,
} from '../src/index.ts';
import type { Dependency, Ripples } from '../src/index.ts';

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
      expect(() => defineRipples(ripples as never)).toThrow(InvalidDependencyError);
      expect(() => new Cyrene({ ripples: ripples as never })).toThrow(InvalidDependencyError);
    }

    expect(() => defineRipples({ bad: 1 } as never)).toThrow(InvalidDependencyError);
    const first = defineRipples({ service });
    const combined = defineRipples({ ...first, other: service });
    const app = new Cyrene({ ripples: combined });
    expect(await app.start()).toEqual({ service: 1, other: 1 });
    await app.dispose();
    expect(() => defineRipples(Object.freeze({ service }))).toThrow(TypeError);
    expect(defineRipples(Object.freeze(first))).toBe(first);

    const checkInvalidKeys = () => {
      // @ts-expect-error Symbol 不能作为入口名
      defineRipples({ [symbol]: service });
      // @ts-expect-error 普通入口对象也禁止 Symbol 键
      new Cyrene({ ripples: { service, [symbol]: service } });
      // @ts-expect-error 数字入口名应显式写为字符串
      defineRipples({ 1: service });
      // @ts-expect-error 构造时同样限制数字入口名
      new Cyrene({ ripples: { 1: service } });
    };

    expectTypeOf(checkInvalidKeys).toBeFunction();
  });

  it('分别识别定义与集合, 标识不可枚举或修改', () => {
    const service = ripple({}, () => 1);
    const source = { service };
    const ripples = defineRipples(source);
    expect(ripples).toBe(source);
    expect(defineRipples(ripples)).toBe(ripples);
    expect(isRipple(service)).toBe(true);
    expect(isRipples(ripples)).toBe(true);
    expect(isRipple(ripples)).toBe(false);
    expect(isRipples(service)).toBe(false);
    expect(isRipple(service())).toBe(false);
    expect(Object.keys(ripples)).toEqual(['service']);
    expect(isRipples({ ...ripples })).toBe(false);

    for (const [value, symbol] of [
      [service, RIPPLE_SYMBOL],
      [ripples, RIPPLES_SYMBOL],
    ] as const) {
      expect(Object.getOwnPropertyDescriptor(value, symbol)).toEqual({
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }

    expectTypeOf(service[RIPPLE_SYMBOL]).toEqualTypeOf<true>();
    expectTypeOf(ripples[RIPPLES_SYMBOL]).toEqualTypeOf<true>();
  });

  it('拒绝普通值, 错误标识与继承标识', () => {
    const service = ripple({}, () => 1);
    const ripples = defineRipples({ service });

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
      { [RIPPLE_SYMBOL]: true },
      { [RIPPLES_SYMBOL]: false },
      Object.assign(() => {}, { [RIPPLE_SYMBOL]: false }),
      Object.create(ripples),
      Object.setPrototypeOf(() => {}, service),
    ]) {
      expect(isRipple(value)).toBe(false);
      expect(isRipples(value)).toBe(false);
    }

    const checkNarrowing = (value: unknown) => {
      if (isRipple(value)) {
        expectTypeOf(value).toEqualTypeOf<Dependency<unknown, never[]>>();
      }

      if (isRipples(value)) {
        expectTypeOf(value).toEqualTypeOf<Ripples>();
      }
    };

    expectTypeOf(checkNarrowing).toBeFunction();
  });

  it('保留入口和依赖输入的推导, 解析结果不包含集合标识', async () => {
    const Config = token<string>('Config');
    const service = ripple({}, (_deps, name: string) => name.length);

    const ripples = defineRipples({
      config: Config,
      count: service('users'),
      ready: ripple({}, () => true),
    });

    const app = new Cyrene({ ripples, bindings: [{ token: Config, value: 'test' }] });
    const result = await app.start();
    expectTypeOf(result.count).toEqualTypeOf<number>();
    expectTypeOf(result.config).toEqualTypeOf<string>();
    expectTypeOf(result.ready).toEqualTypeOf<boolean>();
    expectTypeOf<keyof typeof result>().toEqualTypeOf<'config' | 'count' | 'ready'>();
    expect(Reflect.ownKeys(result)).toEqual(['config', 'count', 'ready']);

    const combined = ripple(ripples, inputs => {
      expectTypeOf<keyof typeof inputs>().toEqualTypeOf<'config' | 'count' | 'ready'>();
      return inputs.count;
    });

    expect(await app.resolve(combined)).toBe(5);
    await app.dispose();

    const checkInvalidCalls = () => {
      // @ts-expect-error 普通值不能作为入口
      defineRipples({ invalid: 123 });
      // @ts-expect-error 参数化定义必须先创建 Ref
      defineRipples({ service });
    };

    expectTypeOf(checkInvalidCalls).toBeFunction();
  });
});
