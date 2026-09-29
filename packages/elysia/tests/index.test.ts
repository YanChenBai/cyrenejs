import type { Cyrene } from 'cyrenejs';
import { DisposedError, ripple } from 'cyrenejs';
import { Elysia } from 'elysia';
import { expect, expectTypeOf, test, vi } from 'vite-plus/test';

import { ElysiaCyrene, useRipples } from '../src/index.ts';

const request = (path = '/') => new Request(`http://localhost${path}`);

test('requires the container plugin before registration', () => {
  expect(() => new Elysia().use(useRipples())).toThrow('Register ElysiaCyrene()');
});

test('registers lazily and preserves existing context and accumulated types', async () => {
  const factory = vi.fn(() => ({ name: 'Cyrene' }));
  const Config = ripple('config', factory);
  const Count = ripple('count', () => 42);

  const app = new Elysia()
    .decorate('label', 'hello')
    .use(ElysiaCyrene())
    .use(useRipples(Config))
    .use(useRipples(Count))
    .get('/', ({ ripples, cyrene, label }) => {
      expectTypeOf(ripples.config).toEqualTypeOf<{ name: string }>();
      expectTypeOf(ripples.count).toEqualTypeOf<number>();
      expectTypeOf(cyrene).toEqualTypeOf<Cyrene>();
      expectTypeOf(label).toEqualTypeOf<string>();

      return `${label} ${ripples.config.name} ${ripples.count}`;
    });

  expect(factory).not.toHaveBeenCalled();
  expect(await (await app.handle(request())).text()).toBe('hello Cyrene 42');
  expect(factory).toHaveBeenCalledTimes(1);
  await app.decorator.cyrene.dispose();
});

test('shares an async singleton across composed routes and concurrent requests', async () => {
  const factory = vi.fn(async () => ({ value: 7 }));
  const Service = ripple('service', factory);
  const Other = ripple('other', () => 'other');
  const plugin = ElysiaCyrene();

  const first = new Elysia()
    .use(plugin)
    .use(useRipples(Service))
    .get('/first', async ({ ripples }) => {
      expectTypeOf(ripples.service).toEqualTypeOf<Promise<{ value: number }>>();

      return (await ripples.service).value;
    });

  const second = new Elysia()
    .use(plugin)
    .use(useRipples(Service, Other))
    .get('/second', async ({ ripples }) => `${(await ripples.service).value} ${ripples.other}`);

  const app = new Elysia().use(plugin).use(first).use(second);

  expect(factory).not.toHaveBeenCalled();

  const responses = await Promise.all([
    app.handle(request('/first')),
    app.handle(request('/second')),
  ]);

  expect(await responses[0]!.text()).toBe('7');
  expect(await responses[1]!.text()).toBe('7 other');
  expect(factory).toHaveBeenCalledTimes(1);
  expect(app.event.stop).toHaveLength(1);
  await plugin.decorator.cyrene.dispose();
});

test('preserves transient resolution and rejects changes after the first resolution', async () => {
  let count = 0;
  const Value = ripple('value', () => ++count, { lifetime: 'transient' });

  const app = new Elysia()
    .use(ElysiaCyrene())
    .use(useRipples(Value))
    .get('/', ({ ripples }) => [ripples.value, ripples.value]);

  expect(await (await app.handle(request())).json()).toEqual([1, 2]);
  expect(await (await app.handle(request())).json()).toEqual([3, 4]);
  expect(() => app.use(useRipples(Value))).toThrow('Registrations are locked');
  expect(Reflect.set(app.decorator.ripples, 'value', 100)).toBe(false);
  await app.decorator.cyrene.dispose();
});

test('keeps separate plugin containers independent', async () => {
  const Value = ripple('value', () => ({}));
  const first = new Elysia().use(ElysiaCyrene()).use(useRipples(Value));
  const second = new Elysia().use(ElysiaCyrene()).use(useRipples(Value));

  expect(first.decorator.ripples.value).not.toBe(second.decorator.ripples.value);
  await Promise.all([first.decorator.cyrene.dispose(), second.decorator.cyrene.dispose()]);
});

test('registers an async stop hook and releases resources exactly once', async () => {
  const dispose = vi.fn(async () => {});
  const Resource = ripple('resource', () => ({ [Symbol.asyncDispose]: dispose }));
  const app = new Elysia().use(ElysiaCyrene()).use(useRipples(Resource));
  void app.decorator.ripples.resource;

  // 无监听服务器时直接执行框架收集的 stop hook，验证 Promise 与清理结果。
  for (const hook of app.event.stop ?? []) {
    await hook.fn(app);
  }

  await app.decorator.cyrene.dispose();
  expect(dispose).toHaveBeenCalledTimes(1);
  expect(() => app.decorator.ripples.resource).toThrow(DisposedError);
});

test('rejects conflicting keys and lets Elysia handle resolution failures', async () => {
  const Value = ripple('value', () => 1);
  const app = new Elysia().use(ElysiaCyrene()).use(useRipples(Value));
  expect(() => app.use(useRipples(ripple('value', () => 2)))).toThrow('Duplicate Ripple key');

  const Failure = ripple('failure', async () => {
    throw new Error('unavailable');
  });

  app.use(useRipples(Failure)).get('/', async ({ ripples }) => await ripples.failure);
  expect((await app.handle(request())).status).toBe(500);
  await app.decorator.cyrene.dispose();
});

test('collects indirect dependencies and respects overrides before requests', async () => {
  const Config = ripple('config', () => 'original');
  const Service = ripple('service', { config: Config }, ({ config }) => config);
  const plugin = ElysiaCyrene();

  const app = new Elysia()
    .use(plugin)
    .use(useRipples(Service))
    .get('/', ({ ripples }) => ripples.service);

  plugin.decorator.cyrene.override(
    Config,
    ripple('replacement', () => 'overridden'),
  );

  expect('config' in app.decorator.ripples).toBe(false);
  expect('service' in app.decorator.ripples).toBe(true);
  expect(await (await app.handle(request())).text()).toBe('overridden');
  await plugin.decorator.cyrene.dispose();
});

test('the stop hook waits for pending initialization and propagates cleanup errors', async () => {
  const error = new Error('cleanup failed');

  const dispose = vi.fn(() => {
    throw error;
  });

  const resource = { [Symbol.dispose]: dispose };
  let finish!: (value: typeof resource) => void;

  const Resource = ripple(
    'resource',
    () =>
      new Promise<typeof resource>(resolve => {
        finish = resolve;
      }),
  );

  const app = new Elysia().use(ElysiaCyrene()).use(useRipples(Resource));
  const pending = app.decorator.ripples.resource;
  const closing = app.event.stop![0]!.fn(app);
  expect(dispose).not.toHaveBeenCalled();
  finish(resource);

  await expect(pending).resolves.toBe(resource);
  await expect(closing).rejects.toMatchObject({ errors: [error] });
  expect(dispose).toHaveBeenCalledTimes(1);
});
