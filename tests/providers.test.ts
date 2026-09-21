import { describe, expect, expectTypeOf, it } from 'vite-plus/test';

import { RIPPLE_SYMBOL, RIPPLE_PROVIDERS_SYMBOL } from '../src/brands.ts';
import {
  Cyrene,
  InvalidDependencyError,
  defineProviders,
  isRipple,
  isRippleProviders,
  ripple,
  token,
} from '../src/index.ts';
import type { Dependency, RippleProviders } from '../src/index.ts';

describe('Ripple 识别', () => {
  it('拒绝 Symbol 和不可枚举入口, 接受已标记及展开组合后的集合', async () => {
    const service = ripple({}, () => 1);
    const symbol = Symbol('entry');

    const invalid = [
      { [symbol]: service },
      Object.defineProperty({}, 'hidden', { value: service }),
      Object.defineProperty({}, symbol, { value: service }),
    ];

    for (const providers of invalid) {
      expect(() => defineProviders(providers as never)).toThrow(InvalidDependencyError);
      expect(() => new Cyrene({ providers: providers as never })).toThrow(InvalidDependencyError);
    }

    expect(() => defineProviders({ bad: 1 } as never)).toThrow(InvalidDependencyError);
    const first = defineProviders({ service });
    const combined = defineProviders({ ...first, other: service });
    const app = new Cyrene({ providers: combined });
    expect(await app.start()).toEqual({ service: 1, other: 1 });
    await app.dispose();
    expect(() => defineProviders(Object.freeze({ service }))).toThrow(TypeError);
    expect(defineProviders(Object.freeze(first))).toBe(first);

    const checkInvalidKeys = () => {
      // @ts-expect-error Symbol 不能作为入口名
      defineProviders({ [symbol]: service });
      // @ts-expect-error 普通入口对象也禁止 Symbol 键
      new Cyrene({ providers: { service, [symbol]: service } });
      // @ts-expect-error 数字入口名应显式写为字符串
      defineProviders({ 1: service });
      // @ts-expect-error 构造时同样限制数字入口名
      new Cyrene({ providers: { 1: service } });
    };

    expectTypeOf(checkInvalidKeys).toBeFunction();
  });

  it('分别识别定义与集合, 标识不可枚举或修改', () => {
    const service = ripple({}, () => 1);
    const source = { service };
    const providers = defineProviders(source);
    expect(providers).toBe(source);
    expect(defineProviders(providers)).toBe(providers);
    expect(isRipple(service)).toBe(true);
    expect(isRippleProviders(providers)).toBe(true);
    expect(isRipple(providers)).toBe(false);
    expect(isRippleProviders(service)).toBe(false);
    expect(isRipple(service())).toBe(false);
    expect(Object.keys(providers)).toEqual(['service']);
    expect(isRippleProviders({ ...providers })).toBe(false);

    for (const [value, symbol] of [
      [service, RIPPLE_SYMBOL],
      [providers, RIPPLE_PROVIDERS_SYMBOL],
    ] as const) {
      expect(Object.getOwnPropertyDescriptor(value, symbol)).toEqual({
        value: true,
        enumerable: false,
        writable: false,
        configurable: false,
      });
    }

    expectTypeOf(service[RIPPLE_SYMBOL]).toEqualTypeOf<true>();
    expectTypeOf(providers[RIPPLE_PROVIDERS_SYMBOL]).toEqualTypeOf<true>();
  });

  it('拒绝普通值, 错误标识与继承标识', () => {
    const service = ripple({}, () => 1);
    const providers = defineProviders({ service });

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
      { [RIPPLE_PROVIDERS_SYMBOL]: false },
      Object.assign(() => {}, { [RIPPLE_SYMBOL]: false }),
      Object.create(providers),
      Object.setPrototypeOf(() => {}, service),
    ]) {
      expect(isRipple(value)).toBe(false);
      expect(isRippleProviders(value)).toBe(false);
    }

    const checkNarrowing = (value: unknown) => {
      if (isRipple(value)) {
        expectTypeOf(value).toEqualTypeOf<Dependency<unknown, never[]>>();
      }

      if (isRippleProviders(value)) {
        expectTypeOf(value).toEqualTypeOf<RippleProviders>();
      }
    };

    expectTypeOf(checkNarrowing).toBeFunction();
  });

  it('保留入口和依赖输入的推导, 解析结果不包含集合标识', async () => {
    const Config = token<string>('Config');
    const service = ripple({}, (_deps, name: string) => name.length);

    const providers = defineProviders({
      config: Config,
      count: service('users'),
      ready: ripple({}, () => true),
    });

    const app = new Cyrene({ providers, bindings: [{ token: Config, value: 'test' }] });
    const result = await app.start();
    expectTypeOf(result.count).toEqualTypeOf<number>();
    expectTypeOf(result.config).toEqualTypeOf<string>();
    expectTypeOf(result.ready).toEqualTypeOf<boolean>();
    expectTypeOf<keyof typeof result>().toEqualTypeOf<'config' | 'count' | 'ready'>();
    expect(Reflect.ownKeys(result)).toEqual(['config', 'count', 'ready']);

    const combined = ripple(providers, inputs => {
      expectTypeOf<keyof typeof inputs>().toEqualTypeOf<'config' | 'count' | 'ready'>();
      return inputs.count;
    });

    expect(await app.resolve(combined)).toBe(5);
    await app.dispose();

    const checkInvalidCalls = () => {
      // @ts-expect-error 普通值不能作为入口
      defineProviders({ invalid: 123 });
      // @ts-expect-error 参数化定义必须先创建 Ref
      defineProviders({ service });
    };

    expectTypeOf(checkInvalidCalls).toBeFunction();
  });
});
