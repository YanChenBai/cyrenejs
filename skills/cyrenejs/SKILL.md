---
name: cyrenejs
description: Build, refactor, or debug TypeScript dependency graphs using the cyrenejs package (Cyrene). Use when working with Ripple definitions, Poem collections, runtime startup, lazy resolution, or resource disposal in Cyrene applications.
---

# Cyrene

Use Cyrene as a declarative dependency graph runtime. Keep construction in `ripple()` definitions and let each `Cyrene` instance own resolution, caching, and disposal.

Import public APIs from `cyrenejs`. When adapting existing code, check the installed package's types and README for version-specific behavior; do not invent container APIs, decorators, or token bindings.

## Model the graph

- Pass concrete Ripples into graph composition functions; group them with `poem()`.
- Define construction with `ripple(factory, options?)` when there are no dependencies, or `ripple(inputs, factory, options?)` when there are dependencies.
- Pass ordinary values directly as inputs. Select concrete Ripple implementations when composing the graph; Token and Binding are not available.
- `ripple()` currently accepts a callable factory, not a class constructor. Use `deps => new Service(deps)` when constructing a class.
- With inputs, the factory receives resolved inputs first; later parameters belong to the caller. Without inputs, all factory parameters belong to the caller.
- Calling a Ripple records parameters in a Ref; it does not run the factory. Call a parameterized Ripple to create a Ref before using it as an input, entry or `resolve()` target. Default, optional, and rest parameters still require a Ref.
- Reuse the same Ref when consumers must share its identity. Calling the Ripple again creates another identity.
- Only top-level branded inputs are resolved. Nested objects, ordinary functions, classes, Promises, and other values pass through unchanged.

## Compose and start

Use `ripples` for startup entries as an object or array. `start()` returns `Promise<void>`; obtain all instances through `resolve()`. This example shares one logger Ref between two consumers:

```ts
import { Cyrene, poem, ripple } from 'cyrenejs';

const config = ripple(() => ({ prefix: 'app' }));
const logger = ripple({ config }, ({ config }, scope: string) => ({
  label: `${config.prefix}:${scope}`,
}));
const sharedLogger = logger('users');

const users = ripple({ logger: sharedLogger }, ({ logger }) => ({
  describe: () => logger.label,
}));
const audit = ripple({ logger: sharedLogger }, ({ logger }) => ({ logger }));

await using app = new Cyrene({
  ripples: poem({ users, audit }),
});

await app.start();
const userService = await app.resolve(users);
const auditService = await app.resolve(audit);
userService.describe(); // 'app:users'
await app.resolve(sharedLogger); // Same instance as auditService.logger
```

- `ripples` accepts an object with enumerable string keys or a dense array of zero-parameter Ripples and Refs. `start()` validates the full reachable graph before running factories, initializes the entries, and returns no instances.
- `poem({ service })` and `poem(() => ({ service }))` create branded objects. The callback runs synchronously once. Use `poem({})` for an empty object.
- Poem marks and returns the original object. The marker is non-enumerable; remark spread objects when recognition is needed. First marking requires an extensible object.
- `poem` is a collection helper, not a module or registration system. Pass a Poem as the first argument of `ripple` to resolve its properties into an object for the factory. Nested collections remain ordinary values.
- Array entries reject holes, extra properties, and non-enumerable elements. Cyrene snapshots entries at construction; later mutations do not change its graph.
- Use another `Cyrene` when an independent lifetime is required. All factory results follow the receiving Cyrene's lifecycle, including externally created objects; there is no borrowed-resource exemption.

## Change the running graph

`resolve()` accesses only an attached root or its dependencies. After `start()`, use `await app.add(target)` to validate, initialize, and attach a new Ripple or Ref. It returns the instance. A failed add leaves no new root and releases newly created resources that are not shared with retained resources.

Use `await app.remove(target)` to remove any attached node without consumers, retaining its dependencies. Use `await app.prune(target)` to remove its dependency closure except nodes protected by other roots or outside consumers. Lazy cycles can be removed together; reject pruning when the target itself is protected. Lazy edges count for protection. Retained orphan nodes remain visible in `inspect()` and can be removed directly. A removed target can only be activated again with `add()`. Graph changes wait for active resolution and run one at a time.

Use `await app.override(old, replacement)` to replace one attached dependency across the entire graph. Cyrene disposes initialized consumers, then immediately rebuilds affected roots. It does not automatically dispose old dependencies or other retained resources merely because they become unreachable from roots. `inspect()` exposes the replacement as an `override` edge. A strong dependency cycle is rejected before releasing instances. Lazy branches are recreated on demand, not eagerly replayed. Cleanup or rebuilding failures leave the replacement graph committed; callers can retry failed initialization through resolve. During rebuilding, live lazy handles can resolve, including handles held externally; graph mutation waits for those resolutions to settle. References already returned to callers cannot be rewritten.

## Defer resolution

Use `lazy(() => target)` as a Ripple input to receive a `Lazy<T>` handle. Call and await its `resolve()` method when the instance is needed; the injected value is not the instance or a callable getter.

```ts
import { lazy, ripple } from 'cyrenejs';

const report = ripple(() => ({ text: 'Report ready' }));
const dashboard = ripple({ report: lazy(() => report) }, ({ report }) => ({
  render: async () => (await report.resolve()).text,
}));
```

Lazy targets still participate in graph validation and must be valid resolvable targets before startup. The target callback can run during inspection; keep it free of construction side effects. A lazy edge can break a strong dependency cycle, but awaiting a cycle of lazy handles during initialization still fails. For cyclic TypeScript inference, annotate the relevant definition with `Dependency<T>` and its result with `T`.

## Respect lifecycle semantics

- The default lifetime is `singleton` per Cyrene and per definition or Ref identity; concurrent resolutions share initialization. Set `{ lifetime: 'transient' }` in Ripple options for a new instance on each resolution. A singleton consumer still retains the transient input it received at construction.
- `start()` is memoized, including failures. A failed singleton can be retried through `resolve()`, but the original `start()` result remains failed.
- Dispose the runtime with `await using` in a supporting TypeScript toolchain, or `try/finally` and `await app.dispose()`, including after startup failure. Disposal waits for in-flight initialization; new resolutions are rejected once disposal begins.
- Disposal runs consumers before dependencies. Cleanup priority is explicit `options.dispose`, then `Symbol.asyncDispose`, then `Symbol.dispose`.
- Shared result objects are disposed once. Do not give different explicit disposer function references to definitions that may return the same object.

## Inspect before execution

`inspect(target?)` and `validate(target?)` inspect all attached nodes (including retained orphans) or a supplied target closure without invoking factories. They throw for invalid targets or strong dependency cycles. `formatGraph()` renders an inspected graph without exposing Ref parameter values; the raw graph can contain those values.

```ts
import { formatGraph } from 'cyrenejs';

const graph = app.inspect();
console.log(formatGraph(graph));
```

Use `debugName` on important definitions so paths and rendered graphs remain understandable. A successful `isRipple()` or `isPoem()` check recognizes the public brand only; resolution still requires objects created by the same Cyrene runtime module copy.
