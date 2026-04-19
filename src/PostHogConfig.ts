import * as Context from "effect/Context"
import { Config, ConfigProvider, Effect, Layer, Schema } from "effect"

import { PostHogConfigError } from "./PostHogError"

export interface PostHogConfigInput {
  readonly apiKey: string
  readonly apiHost?: string
  readonly disabled?: boolean
  readonly fetchRetryBaseDelayMs?: number
  readonly fetchRetryCount?: number
  readonly flushAt?: number
  readonly library?: string
  readonly libraryVersion?: string
  readonly maxBatchSize?: number
  readonly preloadFeatureFlags?: boolean
  readonly queueCapacity?: number
}

export interface PostHogSettings {
  readonly apiHost: string
  readonly apiKey: string
  readonly disabled: boolean
  readonly fetchRetryBaseDelayMs: number
  readonly fetchRetryCount: number
  readonly flushAt: number
  readonly library: string
  readonly libraryVersion: string
  readonly maxBatchSize: number
  readonly preloadFeatureFlags: boolean
  readonly queueCapacity: number
}

const DEFAULT_SETTINGS = {
  apiHost: "https://us.i.posthog.com",
  disabled: false,
  fetchRetryBaseDelayMs: 100,
  fetchRetryCount: 3,
  flushAt: 20,
  library: "posthog-effect",
  libraryVersion: "0.0.0",
  maxBatchSize: 20,
  preloadFeatureFlags: false,
  queueCapacity: 100
}

const PostHogSettingsSchema = Schema.Struct({
  apiHost: Schema.String,
  apiKey: Schema.String,
  disabled: Schema.Boolean,
  fetchRetryBaseDelayMs: Schema.Int,
  fetchRetryCount: Schema.Int,
  flushAt: Schema.Int,
  library: Schema.String,
  libraryVersion: Schema.String,
  maxBatchSize: Schema.Int,
  preloadFeatureFlags: Schema.Boolean,
  queueCapacity: Schema.Int
})

const PostHogEnvConfig = Config.all({
  apiHost: Config.string("apiHost").pipe(Config.withDefault(DEFAULT_SETTINGS.apiHost)),
  apiKey: Config.string("apiKey"),
  disabled: Config.boolean("disabled").pipe(Config.withDefault(DEFAULT_SETTINGS.disabled)),
  fetchRetryBaseDelayMs: Config.int("fetchRetryBaseDelayMs").pipe(
    Config.withDefault(DEFAULT_SETTINGS.fetchRetryBaseDelayMs)
  ),
  fetchRetryCount: Config.int("fetchRetryCount").pipe(Config.withDefault(DEFAULT_SETTINGS.fetchRetryCount)),
  flushAt: Config.int("flushAt").pipe(Config.withDefault(DEFAULT_SETTINGS.flushAt)),
  library: Config.string("library").pipe(Config.withDefault(DEFAULT_SETTINGS.library)),
  libraryVersion: Config.string("libraryVersion").pipe(Config.withDefault(DEFAULT_SETTINGS.libraryVersion)),
  maxBatchSize: Config.int("maxBatchSize").pipe(Config.withDefault(DEFAULT_SETTINGS.maxBatchSize)),
  preloadFeatureFlags: Config.boolean("preloadFeatureFlags").pipe(
    Config.withDefault(DEFAULT_SETTINGS.preloadFeatureFlags)
  ),
  queueCapacity: Config.int("queueCapacity").pipe(Config.withDefault(DEFAULT_SETTINGS.queueCapacity))
}).pipe(Config.nested("posthog"))

const PostHogEnvProvider = ConfigProvider.fromEnv().pipe(ConfigProvider.constantCase)

const validateSettings = (settings: PostHogSettings) =>
  Effect.gen(function*() {
    if (settings.apiKey.trim().length === 0) {
      return yield* new PostHogConfigError({
        message: "PostHog apiKey must be non-empty",
        cause: settings.apiKey
      })
    }

    if (settings.flushAt < 1) {
      return yield* new PostHogConfigError({
        message: "PostHog flushAt must be >= 1",
        cause: settings.flushAt
      })
    }

    if (settings.maxBatchSize < 1) {
      return yield* new PostHogConfigError({
        message: "PostHog maxBatchSize must be >= 1",
        cause: settings.maxBatchSize
      })
    }

    if (settings.queueCapacity < 1) {
      return yield* new PostHogConfigError({
        message: "PostHog queueCapacity must be >= 1",
        cause: settings.queueCapacity
      })
    }

    if (settings.fetchRetryCount < 0) {
      return yield* new PostHogConfigError({
        message: "PostHog fetchRetryCount must be >= 0",
        cause: settings.fetchRetryCount
      })
    }

    if (settings.fetchRetryBaseDelayMs < 1) {
      return yield* new PostHogConfigError({
        message: "PostHog fetchRetryBaseDelayMs must be >= 1",
        cause: settings.fetchRetryBaseDelayMs
      })
    }

    return settings
  })

const decodeInput = (input: PostHogConfigInput) =>
  Schema.decodeUnknownEffect(PostHogSettingsSchema)({
    apiHost: input.apiHost ?? DEFAULT_SETTINGS.apiHost,
    apiKey: input.apiKey,
    disabled: input.disabled ?? DEFAULT_SETTINGS.disabled,
    fetchRetryBaseDelayMs: input.fetchRetryBaseDelayMs ?? DEFAULT_SETTINGS.fetchRetryBaseDelayMs,
    fetchRetryCount: input.fetchRetryCount ?? DEFAULT_SETTINGS.fetchRetryCount,
    flushAt: input.flushAt ?? DEFAULT_SETTINGS.flushAt,
    library: input.library ?? DEFAULT_SETTINGS.library,
    libraryVersion: input.libraryVersion ?? DEFAULT_SETTINGS.libraryVersion,
    maxBatchSize: input.maxBatchSize ?? DEFAULT_SETTINGS.maxBatchSize,
    preloadFeatureFlags: input.preloadFeatureFlags ?? DEFAULT_SETTINGS.preloadFeatureFlags,
    queueCapacity: input.queueCapacity ?? DEFAULT_SETTINGS.queueCapacity
  }).pipe(
    Effect.mapError((cause) =>
      new PostHogConfigError({
        message: "Invalid PostHog config",
        cause
      })
    ),
    Effect.flatMap(validateSettings)
  )

export class PostHogConfig extends Context.Service<PostHogConfig, PostHogSettings>()("PostHogConfig") {
  static readonly layer = (input: PostHogConfigInput) => Layer.effect(PostHogConfig)(decodeInput(input))

  static readonly fromEnv = Layer.effect(PostHogConfig)(
    Effect.gen(function*() {
      const settings = yield* PostHogEnvConfig.parse(PostHogEnvProvider).pipe(
        Effect.mapError((cause) =>
          new PostHogConfigError({
            message: "Invalid PostHog env config",
            cause
          })
        )
      )

      return yield* validateSettings(settings)
    })
  )
}
