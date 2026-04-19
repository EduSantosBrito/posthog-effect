import * as Context from "effect/Context"
import { Effect, Layer, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

import { PostHogTransportError } from "./PostHogError"
import type { BatchRequest, FeatureFlagsRequest, FeatureFlagsSnapshot } from "./PostHogModel"

const FeatureFlagsResponseSchema = Schema.Struct({
  featureFlags: Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.String])),
  featureFlagPayloads: Schema.Record(Schema.String, Schema.Unknown)
})

const makeTransportError = (message: string, cause: unknown) =>
  new PostHogTransportError({
    message,
    cause
  })

const batchUrl = (apiHost: string) => new URL("/batch/", apiHost).toString()

const flagsUrl = (apiHost: string) => new URL("/flags/?v=2", apiHost).toString()

export interface PostHogTransportService {
  readonly loadFeatureFlags: (request: FeatureFlagsRequest) => Effect.Effect<FeatureFlagsSnapshot, PostHogTransportError>
  readonly sendBatch: (request: BatchRequest) => Effect.Effect<void, PostHogTransportError>
}

export class PostHogTransport extends Context.Service<PostHogTransport, PostHogTransportService>()("PostHogTransport") {
  static readonly Live = Layer.effect(PostHogTransport)(
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient

      return {
        loadFeatureFlags: (request: FeatureFlagsRequest) =>
          Effect.gen(function*() {
            const encodedRequest = yield* HttpClientRequest.post(flagsUrl(request.apiHost)).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bodyJson({
                anonymous_distinct_id: request.anonymousId,
                api_key: request.apiKey,
                distinct_id: request.distinctId
              }),
              Effect.mapError((cause) => makeTransportError("Failed to encode feature flags request", cause))
            )

            const response = yield* client.execute(encodedRequest).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.mapError((cause) => makeTransportError("Feature flags request failed", cause))
            )

            return yield* HttpClientResponse.schemaBodyJson(FeatureFlagsResponseSchema)(response).pipe(
              Effect.mapError((cause) => makeTransportError("Failed to decode feature flags response", cause))
            )
          }),
        sendBatch: (request: BatchRequest) =>
          Effect.gen(function*() {
            const encodedRequest = yield* HttpClientRequest.post(batchUrl(request.apiHost)).pipe(
              HttpClientRequest.acceptJson,
              HttpClientRequest.bodyJson({
                api_key: request.apiKey,
                batch: request.batch,
                sent_at: request.sentAt
              }),
              Effect.mapError((cause) => makeTransportError("Failed to encode batch request", cause))
            )

            yield* client.execute(encodedRequest).pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.asVoid,
              Effect.mapError((cause) => makeTransportError("Batch request failed", cause))
            )
          })
      }
    })
  )

  static readonly Fetch = Layer.provide(PostHogTransport.Live, FetchHttpClient.layer)
}
