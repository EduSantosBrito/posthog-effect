import { describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Ref } from "effect"
import { TestClock } from "effect/testing"

import {
  PersistedProperty,
  PostHog,
  PostHogConfig,
  PostHogPersistence,
  PostHogTransport,
  PostHogTransportError,
  type BatchRequest,
  type FeatureFlagsSnapshot,
  type JsonObject,
  type PostHogPersistenceService
} from "../src"

const emptySnapshot = (): FeatureFlagsSnapshot => ({
  featureFlagPayloads: {},
  featureFlags: {}
})

const makeSharedMemoryPersistence = () =>
  Effect.gen(function*() {
    const store = yield* Ref.make(new Map<string, unknown>())

    const service: PostHogPersistenceService = {
      get: (key: string) => Ref.get(store).pipe(Effect.map((state) => state.get(key))),
      remove: (key: string) =>
        Ref.update(store, (state) => {
          const next = new Map(state)
          next.delete(key)
          return next
        }),
      set: (key: string, value: unknown) =>
        Ref.update(store, (state) => {
          const next = new Map(state)
          next.set(key, value)
          return next
        })
    }

    return Layer.succeed(PostHogPersistence)(service)
  })

const makeTestLayer = (
  batches: Ref.Ref<ReadonlyArray<BatchRequest>>,
  flagsRequests: Ref.Ref<number>,
  attempts: Ref.Ref<number>,
  snapshot: FeatureFlagsSnapshot,
  options: {
    readonly failUntilAttempt?: number
    readonly flushAt?: number
    readonly persistenceLayer?: Layer.Layer<PostHogPersistence>
  } = {}
) =>
  PostHog.Live.pipe(
    Layer.provide(PostHogConfig.layer({
      apiKey: "test_api_key",
      fetchRetryBaseDelayMs: 100,
      fetchRetryCount: 2,
      flushAt: options.flushAt ?? 1,
      maxBatchSize: 20,
      queueCapacity: 100
    })),
    Layer.provide(options.persistenceLayer ?? PostHogPersistence.Memory),
    Layer.provide(
      Layer.succeed(PostHogTransport)({
        loadFeatureFlags: () =>
          Ref.update(flagsRequests, (count) => count + 1).pipe(Effect.andThen(Effect.succeed(snapshot))),
        sendBatch: (request) =>
          Ref.updateAndGet(attempts, (count) => count + 1).pipe(
            Effect.flatMap((attempt) => {
              if (attempt <= (options.failUntilAttempt ?? 0)) {
                return Effect.fail(
                  new PostHogTransportError({
                    message: "transient failure",
                    cause: attempt
                  })
                )
              }

              return Ref.update(batches, (current) => [...current, request])
            })
          )
      })
    )
  )

const withPostHog = <A, E, LE>(layer: Layer.Layer<PostHog, LE>, effect: Effect.Effect<A, E, PostHog>) =>
  Effect.scoped(effect.pipe(Effect.provide(layer)))

const firstMessage = (batches: ReadonlyArray<BatchRequest>) => {
  const message = batches[0]?.batch[0]

  return message === undefined ? Effect.die("expected first message") : Effect.succeed(message)
}

const resetBatches = (batches: Ref.Ref<ReadonlyArray<BatchRequest>>) => Ref.set(batches, [])

describe("PostHog Core", () => {
  describe("capture", () => {
    it.effect("should capture an event", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), { flushAt: 10 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.capture("custom-event", { foo: "bar" })
            yield* PostHog.flush()
          })
        )

        const sentBatches = yield* Ref.get(batches)
        const message = yield* firstMessage(sentBatches)

        expect(sentBatches).toHaveLength(1)
        expect(message).toMatchObject({
          distinct_id: expect.any(String),
          event: "custom-event",
          library: "posthog-effect",
          properties: {
            $is_identified: false,
            $lib: "posthog-effect",
            $lib_version: "0.0.0",
            $process_person_profile: false,
            foo: "bar"
          },
          timestamp: "1970-01-01T00:00:00.000Z",
          type: "capture"
        })
      }))

    it.effect("should include feature flags in subsequent captures", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, {
          featureFlagPayloads: { beta: { color: "blue" } },
          featureFlags: { beta: "variant-a", enabled: true }
        }, { flushAt: 10 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.reloadFeatureFlags()
            yield* PostHog.capture("test-event", { foo: "bar" })
            yield* PostHog.flush()
          })
        )

        const message = yield* firstMessage(yield* Ref.get(batches))

        expect(message).toMatchObject({
          event: "test-event",
          properties: {
            $active_feature_flags: ["beta", "enabled"],
            "$feature/beta": "variant-a",
            "$feature/enabled": true,
            foo: "bar"
          }
        })
      }))
  })

  describe("identify", () => {
    it.effect("should send an $identify event and reload feature flags", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, {
          featureFlagPayloads: { beta: { color: "blue" } },
          featureFlags: { beta: "variant-a" }
        }, { flushAt: 10 })

        const result = yield* withPostHog(
          layer,
          Effect.gen(function*() {
            const beforeIdentify = yield* PostHog.getDistinctId()
            yield* PostHog.identify("user-123", { foo: "bar" })
            yield* PostHog.flush()

            return {
              beforeIdentify,
              betaFlag: yield* PostHog.getFeatureFlag("beta"),
              distinctId: yield* PostHog.getDistinctId()
            }
          })
        )

        const sentBatches = yield* Ref.get(batches)
        const message = yield* firstMessage(sentBatches)

        expect(yield* Ref.get(flagsRequests)).toBe(1)
        expect(result.distinctId).toBe("user-123")
        expect(result.betaFlag).toBe("variant-a")
        expect(sentBatches).toHaveLength(1)
        expect(message).toMatchObject({
          distinct_id: "user-123",
          event: "$identify",
          properties: {
            $anon_distinct_id: result.beforeIdentify,
            $set: {
              foo: "bar"
            }
          },
          type: "identify"
        })
      }))

    it.effect("should send an $identify with $set and $set_once event", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), { flushAt: 10 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.identify("id-1", {
              $set: {
                foo: "bar"
              },
              $set_once: {
                vip: true
              }
            })
            yield* PostHog.flush()
          })
        )

        const message = yield* firstMessage(yield* Ref.get(batches))
        expect(message).toMatchObject({
          event: "$identify",
          properties: {
            $set: {
              foo: "bar"
            },
            $set_once: {
              vip: true
            }
          }
        })
      }))

    it.effect("should send $set event when distinct_id is the same but properties are different", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), { flushAt: 10 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.identify("id-1", { foo: "bar" })
            yield* PostHog.flush()
            yield* resetBatches(batches)
            yield* PostHog.identify("id-1", { foo: "baz" })
            yield* PostHog.flush()
          })
        )

        const message = yield* firstMessage(yield* Ref.get(batches))
        expect(message).toMatchObject({
          event: "$set",
          properties: {
            $set: {
              foo: "baz"
            },
            $set_once: {}
          },
          type: "capture"
        })
      }))

    it.effect("should not send event when distinct_id and properties are the same", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), { flushAt: 10 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.identify("id-1", { foo: "bar" })
            yield* PostHog.flush()
            yield* resetBatches(batches)
            yield* PostHog.identify("id-1", { foo: "bar" })
            yield* PostHog.flush()
          })
        )

        expect(yield* Ref.get(batches)).toHaveLength(0)
        expect(yield* Ref.get(flagsRequests)).toBe(2)
      }))
  })

  describe("flush", () => {
    it.effect("flush messages once called", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), { flushAt: 5 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.capture("test-event-1")
            yield* PostHog.capture("test-event-2")
            yield* PostHog.capture("test-event-3")
            expect(yield* Ref.get(batches)).toHaveLength(0)

            yield* PostHog.flush()
          })
        )

        const sentBatches = yield* Ref.get(batches)
        expect(sentBatches).toHaveLength(1)
        expect(sentBatches[0]?.batch.map((message) => message.event)).toEqual([
          "test-event-1",
          "test-event-2",
          "test-event-3"
        ])
      }))

    it.effect("retries transient transport failures", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), {
          failUntilAttempt: 2,
          flushAt: 1
        })
        const fiber = yield* withPostHog(layer, PostHog.capture("retry-event")).pipe(Effect.forkChild)

        yield* TestClock.adjust("5 seconds")
        yield* Fiber.join(fiber)

        expect(yield* Ref.get(attempts)).toBe(3)
        expect(yield* Ref.get(batches)).toHaveLength(1)
      }))
  })

  describe("shutdown", () => {
    it.effect("flush messages once called", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), { flushAt: 10 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            for (let index = 0; index < 5; index += 1) {
              yield* PostHog.capture("test-event")
            }

            yield* PostHog.shutdown()
          })
        )

        expect(yield* Ref.get(batches)).toHaveLength(1)
      }))
  })

  describe("reset", () => {
    it.effect("should keep the queued events when reset is called", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), { flushAt: 10 })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            const originalDistinctId = yield* PostHog.getDistinctId()
            yield* PostHog.capture("queued-before-reset")
            yield* PostHog.reset()

            const nextDistinctId = yield* PostHog.getDistinctId()
            expect(nextDistinctId).not.toBe(originalDistinctId)

            yield* PostHog.flush()
          })
        )

        const message = yield* firstMessage(yield* Ref.get(batches))
        expect(message).toMatchObject({
          distinct_id: expect.any(String),
          event: "queued-before-reset"
        })
      }))
  })

  describe("optOut", () => {
    it.effect("should persist enabled state when called", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const persistenceLayer = yield* makeSharedMemoryPersistence()
        const layer = makeTestLayer(batches, flagsRequests, attempts, emptySnapshot(), {
          flushAt: 10,
          persistenceLayer
        })

        yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.capture("queued-before-opt-out")
            yield* PostHog.optOut()
            yield* PostHog.flush()
            yield* PostHog.optIn()
            yield* PostHog.capture("after-opt-in")
            yield* PostHog.flush()
          })
        )

        const persistedOptIn = yield* PostHogPersistence.use((service) => service.get(PersistedProperty.OptedOut)).pipe(
          Effect.provide(persistenceLayer)
        )

        expect(persistedOptIn).toBe(false)
        const message = yield* firstMessage(yield* Ref.get(batches))
        expect(message.event).toBe("after-opt-in")
      }))
  })

  describe("feature flags", () => {
    it.effect("should cache feature flags and clear them on reset", () =>
      Effect.gen(function*() {
        const batches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const flagsRequests = yield* Ref.make(0)
        const attempts = yield* Ref.make(0)
        const layer = makeTestLayer(batches, flagsRequests, attempts, {
          featureFlagPayloads: { beta: { color: "blue" } },
          featureFlags: { beta: "variant-a", enabled: true }
        }, { flushAt: 10 })

        const result = yield* withPostHog(
          layer,
          Effect.gen(function*() {
            yield* PostHog.reloadFeatureFlags()

            const betaFlag = yield* PostHog.getFeatureFlag("beta")
            const betaPayload = yield* PostHog.getFeatureFlagPayload("beta")
            const enabledFlag = yield* PostHog.getFeatureFlag("enabled")

            yield* PostHog.reset()

            return {
              betaAfterReset: yield* PostHog.getFeatureFlag("beta"),
              betaFlag,
              betaPayload,
              enabledFlag
            }
          })
        )

        expect(result.betaFlag).toBe("variant-a")
        expect(result.betaPayload).toEqual({ color: "blue" })
        expect(result.enabledFlag).toBe(true)
        expect(result.betaAfterReset).toBeUndefined()
      }))

    it.effect("should persist feature flags across service instances", () =>
      Effect.gen(function*() {
        const persistenceLayer = yield* makeSharedMemoryPersistence()
        const firstBatches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const firstFlagsRequests = yield* Ref.make(0)
        const firstAttempts = yield* Ref.make(0)
        const firstLayer = makeTestLayer(firstBatches, firstFlagsRequests, firstAttempts, {
          featureFlagPayloads: { beta: { color: "blue" } },
          featureFlags: { beta: "variant-a" }
        }, {
          flushAt: 10,
          persistenceLayer
        })

        yield* withPostHog(firstLayer, PostHog.reloadFeatureFlags())

        const secondBatches = yield* Ref.make<ReadonlyArray<BatchRequest>>([])
        const secondFlagsRequests = yield* Ref.make(0)
        const secondAttempts = yield* Ref.make(0)
        const secondLayer = makeTestLayer(secondBatches, secondFlagsRequests, secondAttempts, emptySnapshot(), {
          flushAt: 10,
          persistenceLayer
        })

        const restored = yield* withPostHog(
          secondLayer,
          Effect.gen(function*() {
            return {
              flag: yield* PostHog.getFeatureFlag("beta"),
              payload: yield* PostHog.getFeatureFlagPayload("beta")
            }
          })
        )

        expect(restored.flag).toBe("variant-a")
        expect(restored.payload).toEqual({ color: "blue" })
        expect(yield* Ref.get(secondFlagsRequests)).toBe(0)
      }))
  })
})
