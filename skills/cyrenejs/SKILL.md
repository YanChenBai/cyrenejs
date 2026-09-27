---
name: cyrenejs
description: Build TypeScript service graphs with singleton and transient lifetimes, explicit registration, pre-resolution overrides, lazy resolution, and Symbol resource disposal.
---

# Cyrene

Use ripple(factory, options?) or ripple(deps, factory, options?). Ripple declarations have no IDs.
Dependencies reference Ripple objects; ordinary inputs retain their values and types.

Create new Cyrene() with no options. There is no start/init or startupFailure.
Register every dependency with app.add({ key: Declaration }) or app.add('key', Declaration).
Each add validates the whole graph before publishing; register prerequisites first or use one batch.
Duplicate keys, duplicate declarations under different keys, and missing dependencies are rejected.

add mutates and returns the same container. Chain calls or capture the returned container to accumulate
key types and app.ripples.key completion. Standalone add calls cannot change the original variable's generic type; uncaptured keys
have no ripples property completion; resolve(key) returns unknown. Compose registration entries with ordinary objects and object spreads.
resolve(Ripple) infers the result directly from the declaration, even after standalone add calls.
Original declarations and current replacements locate the same registration and use its current lifetime.

override(key, replacement) is synchronous and only allowed before the first ripples.key access or resolve.
The original declaration still locates the registration after replacement. New dependencies must be
registered and replacement results must match the original type and sync/async contract when key types are known.
Configuration locks immediately on activation, even if initialization fails.
Ripple types retain dependency inputs. add/override reject statically identifiable strong cycles;
lazy edges remain allowed. Capture or chain override results to preserve the updated graph type.
Structurally identical declarations, dynamic keys, erased input types, and uncaptured mutations
may evade static checks; runtime validation remains authoritative.

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

Use inspect and formatGraph for diagnostics; nodes contain only key and state.
State is the latest initialization state transition for that key, not an aggregate of concurrent transient instances.
Graph validation runs automatically on add and override. Validate with vp check, vp test run, vp pack,
and an independent consumer declaration emit when public types change.
