---
name: cyrenejs
description: Build TypeScript service graphs with singleton and transient lifetimes, named entrypoints and automatic dependency collection, pre-resolution overrides, lazy resolution, and Symbol resource disposal.
---

# Cyrene

Use ripple(key, factory, options?) or ripple(key, deps, factory, options?).
Keys are immutable non-empty strings. Input property names are local factory parameters, not global keys.
Dependencies reference Ripple objects; ordinary inputs and nested objects retain their values and types.

Create new Cyrene() with no options. Use app.use(Ripple) or app.use(First, Second), optionally chained.
Only explicit use entries appear in app.ripples, both at runtime and in types.
Strong dependencies and lazy targets are collected automatically on first resolution or inspect.
Do not enumerate all children unless they should also be public entries.
The same declaration is deduplicated by identity; repeated use is idempotent.
Distinct declarations with the same key in the effective graph are rejected.
use validates the entire entry batch before mutation; full graph checks are deferred to compilation.
There is no add, object-map use, start/init, or startupFailure.

use mutates and returns the same container. Chain calls or capture the result to accumulate public key types.
Standalone use cannot change the original variable's generic type; resolve(key) returns unknown for keys
not captured in that type. resolve(Ripple) infers directly from the declaration, including internal dependencies.
Preserve inferred key literals; annotating Dependency without its fourth key generic erases precise entry keys.

Use override(original, replacement), referencing the original Ripple instead of a string.
It preserves the original key and public visibility. The replacement key does not create a new slot or property.
Consumers and lazy handles referencing the original resolve the replacement. Both original and current
replacement declarations locate the slot; previous replacements no longer do.
Replacement results must be compatible with the original and preserve its sync/async contract.
Only the replacement's dependencies are collected; old dependencies survive only if another effective path needs them.
Overrides may precede use; graph compilation rejects unreachable override targets, including ones pruned by a parent override.
Repeated override on the same original uses the last replacement; override(original, original) restores the original.
One replacement cannot occupy multiple slots or also be a separate entry/dependency node.
Configuration locks on the first resolution attempt, even if graph compilation or initialization fails.
Graph cycles are checked by runtime identity, not structural TypeScript types.
Strong cycles are rejected before factories run; lazy waiting cycles are detected during initialization.

app.ripples.key, resolve(key), and resolve(Ripple) initialize on demand. Synchronous factories with
synchronous strong dependencies return real instances directly; an async factory or strong dependency
makes the result a Promise. Async singletons keep returning the same Promise after completion.
The ripples accessor is read-only; instances are not proxied. Singleton requests share initialization; failures remain cached.
There is no runtime replacement, remove, reactive proxy, or scope API.
Lifetime is 'singleton' (default) or 'transient'. Transient executes the factory on every resolution,
including each property read, each strong dependency input, and each lazy.resolve call. Async attempts
have independent Promises; failed attempts do not prevent a fresh explicit resolution.
A singleton keeps its initially injected transient; method calls do not recreate that dependency.
Transient can share singleton dependencies. Factories returning the same object do not get cloned.
Recursive creation of a declaration along a still-initializing creation chain is rejected;
a ready instance can use lazy to create another instance of the same transient declaration.

Use lazy(() => Declaration) for deferred resolution and forward declaration references.
The factory receives a handle with resolve(). Actual async waiting cycles are rejected.
Lazy targets stay uninitialized until resolved. Lazy async targets do not make consumers async;
only the handle resolve() returns a Promise. Plain Promise inputs are passed through unchanged.
Factories must express dependencies through deps/lazy rather than awaiting container operations.
During initialization, async lazy handles reuse a wrapper per handle and target instance. Starting resolution
alone adds no wait edge; awaiting, returning it from an async factory, or consuming it through
then/catch/finally does. Callback chains count even when used only for observation. Once the owner
is ready, the handle returns the resolution result directly (cached for singleton, fresh for transient).

Owned singleton and transient resources are retained until container disposal and released in reverse first-completion order.
Transient has no per-call disposal or request scope; bound its usage in long-lived containers.
Prefer Symbol.asyncDispose, otherwise Symbol.dispose. Ordinary dispose methods and option disposers
are not supported. Borrowed resources and plain inputs remain application-owned.
Shared object identities are disposed once; conflicting owned/borrowed declarations are rejected.
Late lazy dependencies and aliases do not receive additional topology-based disposal ordering.

dispose closes new resolution, waits for accepted initialization, then cleans resources.
Business calls are not tracked: stop and drain work before disposing the container.
Factories clean resources allocated before they throw; the container only owns returned instances.
Use await using or try/finally with await app.dispose(). No automatic failure disposal.
Synchronous creation failures and entry errors throw; asynchronous creation failures reject.

Use inspect and formatGraph for diagnostics: roots are explicit entries, nodes and edges cover the full effective graph.
Nodes contain only the original key and state.
State is the latest initialization state transition for that key, not an aggregate of concurrent transient instances.
Graph validation runs on first resolution or explicit inspect. inspect does not lock configuration;
configuration changes invalidate the cached graph. Lazy target callbacks run during graph construction. Validate with vp check, vp test run, vp pack,
and an independent consumer declaration emit when public types change.
