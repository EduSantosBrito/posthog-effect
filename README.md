# posthog-effect

Effect-native PostHog SDK for `effect@4.0.0-beta.51`.

Built for Effect programs first: typed failures, explicit layer wiring, root exports only, and parity-focused semantics for core analytics plus feature flags.

## Installation

```bash
bun add posthog-effect effect
```

## Quick Start

```typescript
import { Effect } from "effect"
import { PostHog } from "posthog-effect"

const program = Effect.gen(function*() {
  yield* PostHog.capture("signup_started", { plan: "pro" })
  yield* PostHog.identify("user-123", { email: "user@example.com" })
  yield* PostHog.reloadFeatureFlags()
  yield* PostHog.flush()
})

const runnable = program.pipe(
  Effect.provide(
    PostHog.layer({
      apiKey: "phc_xxx"
    })
  )
)
```

Browser runtimes can use the built-in browser persistence layer:

```typescript
import { Effect } from "effect"
import { PostHog } from "posthog-effect"

const runnable = Effect.gen(function*() {
  yield* PostHog.capture("pageview")
}).pipe(
  Effect.provide(
    PostHog.browserLayer({
      apiKey: "phc_xxx"
    })
  )
)
```

## Configuration

`PostHog.layer(...)` accepts:

- `apiKey`
- `apiHost`
- `disabled`
- `flushAt`
- `maxBatchSize`
- `queueCapacity`
- `fetchRetryCount`
- `fetchRetryBaseDelayMs`
- `preloadFeatureFlags`
- `library`
- `libraryVersion`

Environment-based config is also supported:

```typescript
import { Effect } from "effect"
import { PostHog } from "posthog-effect"

const runnable = PostHog.capture("job_started").pipe(
  Effect.provide(PostHog.layerFromEnv())
)
```

Environment variables use the `POSTHOG_` prefix:

```bash
POSTHOG_API_KEY=phc_xxx
POSTHOG_API_HOST=https://us.i.posthog.com
POSTHOG_FLUSH_AT=20
POSTHOG_PRELOAD_FEATURE_FLAGS=true
```

## API Surface

Primary service functions:

- `PostHog.capture(...)`
- `PostHog.identify(...)`
- `PostHog.flush()`
- `PostHog.shutdown()`
- `PostHog.reset()`
- `PostHog.optIn()`
- `PostHog.optOut()`
- `PostHog.reloadFeatureFlags()`
- `PostHog.getFeatureFlag(...)`
- `PostHog.getFeatureFlags()`
- `PostHog.getFeatureFlagPayload(...)`
- `PostHog.getFeatureFlagPayloads()`
- `PostHog.getDistinctId()`

## Persistence

Persistence is a service boundary. Built-in adapters:

- `PostHogPersistence.Memory`
- `PostHogPersistence.Browser`
- `PostHogPersistence.LocalStorage`
- `PostHogPersistence.Cookie`
- `PostHogPersistence.browser(...)`
- `PostHogPersistence.localStorage(...)`
- `PostHogPersistence.cookie(...)`

The browser adapter writes to `localStorage` and cookies, and falls back from cookies back into `localStorage` when needed.

## Error Handling

Failures stay in the Effect error channel via tagged errors:

- `PostHogConfigError`
- `PostHogPersistenceError`
- `PostHogStateError`
- `PostHogTransportError`

```typescript
import { Effect } from "effect"
import { PostHog, PostHogTransportError } from "posthog-effect"

const program = PostHog.capture("checkout_failed").pipe(
  Effect.catch((error) => {
    if (error instanceof PostHogTransportError) {
      return Effect.void
    }

    return Effect.fail(error)
  })
)
```

## Scope

Current `0.x` scope:

- core analytics: capture, identify, reset, flush, shutdown
- feature flags: reload, cached values, cached payloads, persistence
- queue-backed delivery with bounded retry
- memory and browser-oriented persistence adapters

Out of scope for `0.x`:

- autocapture
- session replay
- surveys
- toolbar integration
- heatmaps
- React-specific wrappers
- promise-first singleton API

## Development

```bash
bun install
bun run typecheck
bun run test
bun run build
```

## References

Reference repos live in `.reference/` and stay out of package inputs:

- `effect-smol`
- `distilled`
- `posthog-js`
