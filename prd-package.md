## Problem Statement

The project needs an Effect-native PostHog SDK for Effect v4 beta that preserves the behavioral expectations of `posthog-js` without copying its promise-first, browser-global architecture.

The target package is `posthog-effect`. It must let developers use PostHog from inside Effect programs with typed failures, explicit dependency wiring, layer-based initialization, and behavior parity where it matters most. The package must work across modern runtimes, including browser, Node, and Effect Atom-style environments, while keeping runtime-specific concerns out of the core public API.

The main risk is drift in three directions at once: drift from upstream PostHog behavior, drift from idiomatic Effect v4 design, and drift across runtimes with different storage and transport constraints. The package needs a design that keeps those tensions explicit and testable.

## Solution

Build a single publishable package, `posthog-effect`, with root exports only and an Effect-first API centered on service functions such as `yield* PostHog.capture(...)` and `yield* PostHog.identify(...)`.

Initialization will be layer-based instead of global-singleton based. The package will expose thin convenience helpers for constructing the standard layer graph, but the public model stays env-first and Effect-native.

Version `0.x` will target the core analytics client plus feature flags. Browser-heavy features such as autocapture, replay, surveys, toolbar, and heatmaps will be designed as later opt-in capability modules instead of being forced into the first release.

Behavior parity will be driven by ports of `posthog-js` tests into an Effect + Vitest harness. Tests should stay close to upstream behavior names and assertions while using local Effect-native test utilities.

The implementation should rely on Effect v4 APIs that match this architecture:

- `Context.Service` for service boundaries and typed dependency access
- `Layer.effect` for layer-based construction and managed startup
- `Schema` and `Config` for config parsing and boundary validation
- `Data.TaggedError` for typed domain and transport failures
- `Ref` and `SynchronizedRef` for internal mutable runtime state
- `Queue.bounded` for buffered event delivery
- `Schedule.exponential` combined with `Schedule.recurs` for retry policy
- `HttpClient` and `FetchHttpClient.layer` for transport
- `Scope` and scoped fibers for worker lifecycle
- `@effect/vitest` for Effect-native tests

## User Stories

1. As an Effect application developer, I want to call PostHog through Effect service functions, so that analytics remains inside my typed runtime model.
2. As an application developer, I want layer-based initialization instead of a hidden singleton, so that startup is explicit and testable.
3. As a browser developer, I want PostHog persistence semantics to match upstream behavior, so that distinct IDs, opt-out state, and cached flags behave as expected.
4. As a Node developer, I want the SDK to run without browser globals, so that I can emit analytics in server processes and jobs.
5. As an Effect Atom developer, I want the SDK to work inside the runtime I already have, so that I do not need a separate promise wrapper.
6. As a user migrating from `posthog-js`, I want familiar event semantics such as `capture`, `identify`, and `reset`, so that behavior stays predictable.
7. As a developer, I want typed failures in the Effect error channel, so that transport and configuration problems can be handled intentionally.
8. As a developer, I want a queue-backed delivery model, so that event emission does not require immediate network success.
9. As a developer, I want explicit `flush` and `shutdown` operations, so that I can safely drain analytics on process exit or test teardown.
10. As a developer, I want retry behavior with bounded backoff, so that transient transport failures do not drop important events immediately.
11. As a developer, I want feature flags in the first release, so that the package is useful beyond basic event capture.
12. As a developer, I want root exports only, so that package usage stays simple and runtime wiring stays inside layers rather than platform entrypoints.
13. As a maintainer, I want one public npm package, so that release management and documentation stay coherent.
14. As a maintainer, I want runtime-specific features isolated behind capability modules, so that impossible dependencies do not leak into all runtimes.
15. As a maintainer, I want illegal states modeled explicitly, so that ambiguous runtime behavior is harder to encode.
16. As a maintainer, I want config and payload parsing at module boundaries, so that malformed data is rejected early and consistently.
17. As a maintainer, I want domain errors to be tagged and typed, so that callers can recover by error class rather than string matching.
18. As a maintainer, I want a deep core module for client state and delivery, so that most behavior can be tested without browser APIs.
19. As a maintainer, I want browser persistence implemented behind an abstraction, so that localStorage, cookie, in-memory, and future adapters can be tested independently.
20. As a maintainer, I want transport implemented behind a dedicated module, so that request shaping and retry policy can evolve without touching the service surface.
21. As a test author, I want parity tests ported from `posthog-js`, so that failures indicate semantic drift from upstream.
22. As a test author, I want Effect-native test utilities, so that stateful services, clocks, and dependencies can be controlled deterministically.
23. As a release engineer, I want Bun as the package manager and runtime tool, so that install and local workflow match project goals.
24. As a release engineer, I want `tsgo` for type-oriented build work and Vite for bundling/tooling, so that build responsibilities are clear.
25. As a contributor, I want reference repos pinned in `.reference`, so that architecture, behavior, and API assumptions remain reproducible.
26. As a contributor, I want modern-runtime-only support in the first release, so that the design is not distorted by legacy browser constraints.
27. As a contributor, I want event names and properties to stay parity-first and loosely typed at first, so that upstream behavior can be ported quickly.
28. As a contributor, I want typed wrappers to remain possible later, so that the package can gain stronger event contracts without blocking v0.
29. As a product engineer, I want `identify` merge behavior and `reset` semantics to match upstream, so that people and session behavior remain trustworthy.
30. As a product engineer, I want feature flag caching and persistence behavior covered by tests, so that local evaluation state behaves consistently across runs.
31. As a product engineer, I want opt-out behavior to be preserved, so that consent-sensitive applications can rely on the package.
32. As a future module author, I want replay, autocapture, surveys, and similar browser features to plug into the core cleanly, so that later additions do not require redesigning the package.

## Implementation Decisions

- The package will be a single publishable npm package named `posthog-effect`.
- Public exports will stay at the root package surface. Capability subpaths are allowed later for major optional modules, but runtime-branded entrypoints are out for now.
- The public API will be Effect service functions, not a promise client and not a global browser singleton.
- Initialization will be layer-based. Thin helpers may construct the default layer graph, but they must stay explicit and Effect-native.
- The core client should be implemented as a deep module that owns event capture semantics, identity semantics, queueing, retry scheduling, flush behavior, and lifecycle management behind a narrow public service interface.
- Service boundaries should use `Context.Service`, which is the recommended Effect v4 service mechanism for typed dependency lookup without globals.
- Layer construction should use `Layer.effect`, which is the v4 replacement for the older scoped layer constructor and fits managed startup and teardown.
- Runtime configuration should be modeled and validated at the boundary using `Schema` plus `Config` where environment-driven config is needed.
- Domain and transport errors should use `Data.TaggedError` so callers can recover through tag-based Effect error handling.
- The internal client state should prefer `Ref` for atomic pure state transitions and `SynchronizedRef` only where effectful state transitions are genuinely needed.
- Event delivery should use a bounded queue built on `Queue.bounded`, giving explicit backpressure instead of hidden mutable buffering.
- Retry behavior should use `Schedule.exponential` combined with `Schedule.recurs` to express bounded exponential backoff in the Effect model.
- Background workers should be scoped resources so they start and stop with the provided layer. Worker lifetime and cleanup should rely on scoped Effect lifecycle rather than ad hoc global timers.
- HTTP transport should be built on `effect/unstable/http`. The transport module should depend on `HttpClient` and default to `FetchHttpClient.layer` where fetch is available.
- Request shaping, compression, batching, headers, retry metadata, and response interpretation should live in a dedicated transport module rather than inside the public PostHog service surface.
- Persistence should be its own module and service boundary. The package should preserve browser `localStorage+cookie` semantics from `posthog-js`, but the implementation should still be abstract enough to support in-memory and future platform adapters.
- The persistence abstraction may borrow from the shape of `KeyValueStore`, but it should not force all browser persistence behavior into a lowest-common-denominator store if that would lose PostHog semantics such as hybrid storage, cookie options, or migration rules.
- Identity state, anonymous ID generation, distinct ID transitions, identify merge semantics, and reset rules should live in a dedicated identity/runtime-state module instead of being spread across transport or public methods.
- Feature flags are in scope for `0.x` and should be treated as part of the first-class core release bar, not a future add-on.
- Browser-heavy modules such as autocapture, replay, surveys, toolbar, heatmaps, and similar UI or DOM lifecycle features are explicitly out of v0 and should be designed as later opt-in capability modules.
- Event contracts should be parity-first and loosely typed for v0: event name as string and properties as structured JSON-like values. Stronger typed wrappers can come later.
- The package should target modern runtimes only in its first release: Bun, Node LTS, and evergreen browsers.
- The build split is fixed: Bun is the package manager, `tsgo` handles type-oriented build work, and Vite handles bundling and tooling setup.
- The project should keep a `.reference` directory with shallow, pinned clones of `effect-smol`, `distilled`, and `posthog-js`, excluded from package, test, and build inputs.
- Reference research should inform API choice and behavior parity, but implementation should not mirror upstream architecture where it conflicts with the Effect-first design.

## Testing Decisions

- Good tests must verify external behavior and semantic outcomes, not internal implementation details, private state layout, or incidental timing details.
- The primary source of truth for parity tests is `posthog-js`. Tests should be ported as behavior specs, keeping names and assertions as close as possible while rebuilding the harness around Effect and Vitest.
- The mandatory v0 parity focus is core client behavior, persistence behavior, queue/retry/flush behavior, identify/reset semantics, and feature flags.
- The core client module should have direct semantic tests for event ordering, flush behavior, shutdown behavior, and failure propagation.
- The identity module should have semantic tests for anonymous ID generation, identify merge rules, repeated identify behavior, and reset transitions.
- The persistence module should have adapter-focused tests that prove `localStorage+cookie`, local-only, cookie-only, and in-memory semantics where relevant.
- The transport module should have behavior tests for request shaping, retry metadata, backoff behavior, and success/failure transitions.
- Feature flag logic should have tests for evaluation fetches, caching, persistence, and local behavior after resets or identity changes.
- Effect-native unit and integration tests should use `@effect/vitest`, following the style used throughout `effect-smol`’s own test suite.
- The first release does not require browser-heavy parity coverage for autocapture, replay, surveys, toolbar, or heatmaps.
- Playwright-style browser coverage may be added later for browser-specific capability modules, but the core v0 test bar is behavior parity through Effect + Vitest.

## Out of Scope

The following are out of scope for the first publishable `0.x` release:

- Autocapture
- Session replay
- Surveys
- Toolbar integration
- Heatmaps
- Conversations and widget-style UI modules
- React-specific wrappers
- Legacy browser compatibility
- A promise-based API surface
- A hidden global singleton initialization model
- Multiple public npm packages or runtime-branded entrypoints
- Strongly typed event-contract generation from day one

## Further Notes

- The first publishable milestone is `0.x`, not `1.0`, and it is explicitly defined as core analytics plus feature flags with parity tests green for those areas.
- The project direction remains full parity ambition over time, but milestone planning must stay narrower than that ambition.
- `distilled` is useful prior art for `Context.Service` plus `Layer.effect` patterns and for the overall style of Effect-first SDK construction.
- `posthog-js` remains the behavior reference, especially for persistence, identify/reset semantics, and feature-flag expectations.
- `effect-smol` remains the API reference for Effect v4 beta. Stable APIs should be preferred where possible, with unstable HTTP and persistence APIs used deliberately where they materially reduce bespoke infrastructure.
