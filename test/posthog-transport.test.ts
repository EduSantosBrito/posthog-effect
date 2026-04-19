import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Ref } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { PostHogTransport, PostHogTransportError, type BatchRequest } from "../src"

const makeClientLayer = (
  urlRef: Ref.Ref<string | undefined>,
  bodyRef: Ref.Ref<string | undefined>,
  response: Response
) =>
  Layer.succeed(HttpClient.HttpClient)(
    HttpClient.make((request, url) =>
      Effect.gen(function*() {
        const webRequest = yield* HttpClientRequest.toWeb(request).pipe(Effect.orDie)
        yield* Ref.set(urlRef, url.toString())
        yield* Effect.tryPromise(() => webRequest.text()).pipe(Effect.orDie, Effect.flatMap((body) => Ref.set(bodyRef, body)))

        return HttpClientResponse.fromWeb(request, response)
      })
    )
  )

describe("PostHog Transport", () => {
  it.effect("should shape batch requests", () =>
    Effect.gen(function*() {
      const urlRef = yield* Ref.make<string | undefined>(undefined)
      const bodyRef = yield* Ref.make<string | undefined>(undefined)
      const layer = PostHogTransport.Live.pipe(
        Layer.provide(
          makeClientLayer(
            urlRef,
            bodyRef,
            new Response(JSON.stringify({ status: "ok" }), {
              headers: {
                "content-type": "application/json"
              },
              status: 200
            })
          )
        )
      )
      const request: BatchRequest = {
        apiHost: "https://us.i.posthog.com",
        apiKey: Redacted.make("test_api_key"),
        batch: [
          {
            distinct_id: "user-123",
            event: "test-event",
            library: "posthog-effect",
            library_version: "0.0.0",
            properties: { foo: "bar" },
            timestamp: "2022-01-01T00:00:00.000Z",
            type: "capture",
            uuid: "uuid-1"
          }
        ],
        sentAt: "2022-01-01T00:00:00.000Z"
      }

      yield* PostHogTransport.use((service) => service.sendBatch(request)).pipe(Effect.provide(layer))

      expect(yield* Ref.get(urlRef)).toBe("https://us.i.posthog.com/batch/")
      expect(JSON.parse((yield* Ref.get(bodyRef)) ?? "{}")).toMatchObject({
        api_key: "test_api_key",
        batch: [
          {
            distinct_id: "user-123",
            event: "test-event"
          }
        ],
        sent_at: "2022-01-01T00:00:00.000Z"
      })
    }))

  it.effect("should shape and decode feature flag requests", () =>
    Effect.gen(function*() {
      const urlRef = yield* Ref.make<string | undefined>(undefined)
      const bodyRef = yield* Ref.make<string | undefined>(undefined)
      const layer = PostHogTransport.Live.pipe(
        Layer.provide(
          makeClientLayer(
            urlRef,
            bodyRef,
            new Response(JSON.stringify({
              featureFlagPayloads: { beta: { color: "blue" } },
              featureFlags: { beta: "variant-a" }
            }), {
              headers: {
                "content-type": "application/json"
              },
              status: 200
            })
          )
        )
      )

      const snapshot = yield* PostHogTransport.use((service) =>
        service.loadFeatureFlags({
          anonymousId: "anon-123",
          apiHost: "https://us.i.posthog.com",
          apiKey: Redacted.make("test_api_key"),
          distinctId: "user-123"
        })
      ).pipe(Effect.provide(layer))

      expect(snapshot).toEqual({
        featureFlagPayloads: { beta: { color: "blue" } },
        featureFlags: { beta: "variant-a" }
      })
      expect(yield* Ref.get(urlRef)).toBe("https://us.i.posthog.com/flags/?v=2")
      expect(JSON.parse((yield* Ref.get(bodyRef)) ?? "{}")).toMatchObject({
        anonymous_distinct_id: "anon-123",
        api_key: "test_api_key",
        distinct_id: "user-123"
      })
    }))

  it.effect("should fail with a tagged transport error on non-200 responses", () =>
    Effect.gen(function*() {
      const urlRef = yield* Ref.make<string | undefined>(undefined)
      const bodyRef = yield* Ref.make<string | undefined>(undefined)
      const layer = PostHogTransport.Live.pipe(
        Layer.provide(
          makeClientLayer(
            urlRef,
            bodyRef,
            new Response(JSON.stringify({ error: "boom" }), {
              headers: {
                "content-type": "application/json"
              },
              status: 500
            })
          )
        )
      )

      const exit = yield* PostHogTransport.use((service) =>
        service.sendBatch({
          apiHost: "https://us.i.posthog.com",
          apiKey: Redacted.make("test_api_key"),
          batch: [],
          sentAt: "2022-01-01T00:00:00.000Z"
        })
      ).pipe(Effect.provide(layer), Effect.flip)

      expect(exit).toBeInstanceOf(PostHogTransportError)
      expect(exit.message).toBe("Batch request failed")
    }))
})
