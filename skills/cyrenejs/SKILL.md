---
name: cyrenejs
description: Build, refactor, or debug TypeScript dependency graphs using the cyrenejs package (Cyrene). Use when working with Ripple definitions, Token bindings, runtime startup, lazy resolution, or resource disposal in Cyrene applications.
---

# Cyrene

Use Cyrene as a declarative dependency graph runtime. Keep construction in `ripple()` definitions and let each `Cyrene` instance own resolution, caching, and disposal.

Import public APIs from `cyrenejs`. When adapting existing code, check the installed package's types and README for version-specific behavior; do not invent container APIs, decorators, or registration methods.

## Model the graph

- Define external capabilities with `token<T>(name)`.
- Define construction with `ripple(inputs, factory, options?)`. Pass `{}` when there are no inputs.
- The factory receives resolved inputs first; later parameters belong to the caller.
- Calling a Ripple records parameters in a Ref; it does not run the factory. Call a parameterized Ripple to create a Ref before using it as an input, entry, binding target, or `resolve()` target. Default, optional, and rest parameters still require a Ref.
- Reuse the same Ref when consumers must share its identity. Calling the Ripple again creates another identity.
- Only top-level branded inputs are resolved. Nested objects, ordinary functions, classes, Promises, and other values pass through unchanged.

## Compose and start

Use `ripples` for named startup entries and `bindings` for Token implementations. This example shares one logger Ref between two consumers:

```ts
import { Cyrene, ripple, token } from 'cyrenejs';

const Config = token<{ prefix: string }>('Config');
const logger = ripple({ config: Config }, ({ config }, scope: string) => ({
  label: `${config.prefix}:${scope}`,
}));
const sharedLogger = logger('users');

const users = ripple({ logger: sharedLogger }, ({ logger }) => ({
  describe: () => logger.label,
}));
const audit = ripple({ logger: sharedLogger }, ({ logger }) => ({ logger }));

await using app = new Cyrene({
  ripples: { users, audit },
  bindings: [{ token: Config, value: { prefix: 'app' } }],
});

const services = await app.start();
services.users.describe(); // 'app:users'
await app.resolve(sharedLogger); // Same instance as services.audit.logger
```

- A binding supports exactly one of `value` or `dependency`. Tokens match by identity, not name; reuse the exported Token rather than recreating one with the same name.
- `value` is borrowed external state. Cyrene never disposes it, even when a factory returns the same top-level object or function. Attaching an explicit disposer to that borrowed result makes resolution fail.
- A function supplied through `value` remains a function value and is never called automatically.
- `dependency` points to a Ripple, Ref, or Token and initializes only when reachable or explicitly resolved.
- Do not add a direct factory form to bindings; wrap construction in `ripple()` so dependency and lifecycle semantics stay unified.
- `ripples` contains enumerable string keys mapped to zero-parameter Ripples, Refs, or Tokens. `start()` validates the full reachable graph before running factories and returns the same named shape.
- `defineRipples()` is an optional typed, branded collection helper. It is not a module or registration system.
- Use another `Cyrene` when an independent lifetime is required. Share externally owned instances through Token value bindings.

## Defer resolution

Use `lazy(() => target)` as a Ripple input to receive a `Lazy<T>` handle. Call and await its `resolve()` method when the instance is needed; the injected value is not the instance or a callable getter.

```ts
import { lazy, ripple } from 'cyrenejs';

const report = ripple({}, () => ({ text: 'Report ready' }));
const dashboard = ripple({ report: lazy(() => report) }, ({ report }) => ({
  render: async () => (await report.resolve()).text,
}));
```

Lazy targets still participate in graph validation, so their Token bindings must exist before startup. The target callback can run during inspection; keep it free of construction side effects. A lazy edge can break a strong dependency cycle, but awaiting a cycle of lazy handles during initialization still fails. For cyclic TypeScript inference, annotate the relevant definition with `Dependency<T>` and its result with `T`.

## Respect lifecycle semantics

- The default lifetime is `singleton` per Cyrene and per definition or Ref identity; concurrent resolutions share initialization. Set `{ lifetime: 'transient' }` in Ripple options for a new instance on each resolution. A singleton consumer still retains the transient input it received at construction.
- `start()` is memoized, including failures. A failed singleton can be retried through `resolve()`, but the original `start()` result remains failed.
- Dispose the runtime with `await using` in a supporting TypeScript toolchain, or `try/finally` and `await app.dispose()`, including after startup failure. Disposal waits for in-flight initialization; new resolutions are rejected once disposal begins.
- Disposal runs consumers before dependencies. Cleanup priority is explicit `options.dispose`, then `Symbol.asyncDispose`, then `Symbol.dispose`.
- Shared result objects are disposed once. Do not give different explicit disposer function references to definitions that may return the same object.

## Inspect before execution

`inspect(target?)` and `validate(target?)` walk either the named entries or a supplied target without invoking factories. They throw for missing bindings or strong dependency cycles. `formatGraph()` renders an inspected graph without exposing Ref parameter values; the raw graph can contain those values.

```ts
import { formatGraph } from 'cyrenejs';

const graph = app.inspect();
console.log(formatGraph(graph));
```

Use `debugName` on important definitions so paths and rendered graphs remain understandable. A successful `isRipple()` or `isRipples()` check recognizes the public brand only; resolution still requires objects created by the same Cyrene runtime module copy.
