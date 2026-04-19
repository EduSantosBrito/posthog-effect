import { Clock, Effect, Layer, Option, Queue, Ref, Schedule } from "effect"
import * as Context from "effect/Context"

import { PostHogConfig, type PostHogConfigInput, type PostHogSettings } from "./PostHogConfig"
import { PostHogPersistenceError, PostHogStateError, PostHogTransportError } from "./PostHogError"
import {
  PersistedProperty,
  type BatchRequest,
  type CaptureOptions,
  type FeatureFlagValue,
  type FeatureFlagsRequest,
  type FeatureFlagsSnapshot,
  type JsonObject,
  type JsonValue,
  type PersonPropertiesSnapshot,
  type PostHogMessage
} from "./PostHogModel"
import { PostHogPersistence } from "./PostHogPersistence"
import { PostHogTransport } from "./PostHogTransport"

interface RuntimeState {
  readonly anonymousId: string
  readonly closed: boolean
  readonly distinctId: string
  readonly featureFlagPayloads: Readonly<Record<string, unknown>>
  readonly featureFlags: Readonly<Record<string, FeatureFlagValue>>
  readonly identified: boolean
  readonly optedOut: boolean
  readonly personProperties: Readonly<Record<string, JsonValue>>
  readonly personPropertiesOnce: Readonly<Record<string, JsonValue>>
}

type PostHogPersistenceStore = Context.Service.Shape<typeof PostHogPersistence>

type PostHogRuntimeError = PostHogPersistenceError | PostHogStateError | PostHogTransportError

export interface PostHogService {
  readonly capture: (
    event: string,
    properties?: JsonObject,
    options?: CaptureOptions
  ) => Effect.Effect<void, PostHogRuntimeError>
  readonly flush: () => Effect.Effect<void, PostHogRuntimeError>
  readonly getDistinctId: () => Effect.Effect<string>
  readonly getFeatureFlag: (key: string) => Effect.Effect<FeatureFlagValue | undefined>
  readonly getFeatureFlagPayload: (key: string) => Effect.Effect<unknown | undefined>
  readonly getFeatureFlagPayloads: () => Effect.Effect<Readonly<Record<string, unknown>>>
  readonly getFeatureFlags: () => Effect.Effect<Readonly<Record<string, FeatureFlagValue>>>
  readonly identify: (distinctId: string, properties?: JsonObject) => Effect.Effect<void, PostHogRuntimeError>
  readonly optIn: () => Effect.Effect<void, PostHogPersistenceError>
  readonly optOut: () => Effect.Effect<void, PostHogPersistenceError>
  readonly reloadFeatureFlags: () => Effect.Effect<FeatureFlagsSnapshot, PostHogRuntimeError>
  readonly reset: (preserve?: ReadonlyArray<PersistedProperty>) => Effect.Effect<void, PostHogRuntimeError>
  readonly shutdown: () => Effect.Effect<void, PostHogRuntimeError>
}

const emptyFeatureFlags = (): FeatureFlagsSnapshot => ({
  featureFlagPayloads: {},
  featureFlags: {}
})

const emptyPersonProperties = (): PersonPropertiesSnapshot => ({
  set: {},
  setOnce: {}
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true
  }

  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue)
  }

  if (isRecord(value)) {
    return Object.values(value).every(isJsonValue)
  }

  return false
}

const isJsonObject = (value: unknown): value is JsonObject => isRecord(value) && Object.values(value).every(isJsonValue)

const isJsonRecord = (value: unknown): value is Readonly<Record<string, JsonValue>> => isJsonObject(value)

const isFeatureFlagsSnapshot = (value: unknown): value is FeatureFlagsSnapshot => {
  if (!isRecord(value)) {
    return false
  }

  const featureFlags = value.featureFlags
  const featureFlagPayloads = value.featureFlagPayloads

  if (!isRecord(featureFlags) || !isRecord(featureFlagPayloads)) {
    return false
  }

  for (const flagValue of Object.values(featureFlags)) {
    if (typeof flagValue !== "boolean" && typeof flagValue !== "string") {
      return false
    }
  }

  return true
}

const jsonValuesEqual = (left: JsonValue | undefined, right: JsonValue): boolean => {
  if (left === right) {
    return true
  }

  if (left === null || right === null) {
    return left === right
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false
    }

    for (let index = 0; index < left.length; index += 1) {
      const leftValue = left[index]
      const rightValue = right[index]

      if (leftValue === undefined || rightValue === undefined || !jsonValuesEqual(leftValue, rightValue)) {
        return false
      }
    }

    return true
  }

  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)

    if (leftKeys.length !== rightKeys.length) {
      return false
    }

    for (const key of leftKeys) {
      const leftValue = left[key]
      const rightValue = right[key]

      if (leftValue === undefined || rightValue === undefined || !jsonValuesEqual(leftValue, rightValue)) {
        return false
      }
    }

    return true
  }

  return false
}

const createId = () => Effect.sync(() => globalThis.crypto.randomUUID())

const currentTimestamp = (provided?: Date) =>
  Effect.gen(function*() {
    if (provided !== undefined) {
      return provided.toISOString()
    }

    const millis = yield* Clock.currentTimeMillis
    return new Date(millis).toISOString()
  })

const currentUuid = (provided?: string) => Effect.sync(() => provided ?? globalThis.crypto.randomUUID())

const makeRetrySchedule = (config: PostHogSettings) =>
  Schedule.exponential(config.fetchRetryBaseDelayMs).pipe(Schedule.both(Schedule.recurs(config.fetchRetryCount)))

const hasProperties = (properties: Readonly<Record<string, unknown>>) => Object.keys(properties).length > 0

const makeBaseProperties = (config: PostHogSettings, state: RuntimeState): JsonObject => ({
  $is_identified: state.identified,
  $lib: config.library,
  $lib_version: config.libraryVersion,
  $process_person_profile: state.identified,
  $session_id: state.anonymousId
})

const splitIdentifyProperties = (properties: JsonObject) => {
  const setProperties: Record<string, JsonValue> = {}
  let setOnceProperties: Record<string, JsonValue> | undefined

  for (const [key, value] of Object.entries(properties)) {
    if (key === "$set" && isJsonObject(value)) {
      for (const [entryKey, entryValue] of Object.entries(value)) {
        setProperties[entryKey] = entryValue
      }
      continue
    }

    if (key === "$set_once" && isJsonObject(value)) {
      setOnceProperties = {}
      for (const [entryKey, entryValue] of Object.entries(value)) {
        setOnceProperties[entryKey] = entryValue
      }
      continue
    }

    setProperties[key] = value
  }

  return {
    setOnceProperties,
    setProperties
  }
}

const mergePersonProperties = (
  current: PersonPropertiesSnapshot,
  next: ReturnType<typeof splitIdentifyProperties>
): PersonPropertiesSnapshot => ({
  set: {
    ...current.set,
    ...next.setProperties
  },
  setOnce: {
    ...current.setOnce,
    ...(next.setOnceProperties ?? {})
  }
})

const diffSetProperties = (
  current: Readonly<Record<string, JsonValue>>,
  next: Readonly<Record<string, JsonValue>>
): Record<string, JsonValue> => {
  const diff: Record<string, JsonValue> = {}

  for (const [key, value] of Object.entries(next)) {
    if (!jsonValuesEqual(current[key], value)) {
      diff[key] = value
    }
  }

  return diff
}

const diffSetOnceProperties = (
  current: Readonly<Record<string, JsonValue>>,
  next: Readonly<Record<string, JsonValue>> | undefined
): Record<string, JsonValue> => {
  const diff: Record<string, JsonValue> = {}

  if (next === undefined) {
    return diff
  }

  for (const [key, value] of Object.entries(next)) {
    if (current[key] === undefined) {
      diff[key] = value
    }
  }

  return diff
}

const chunkMessages = (messages: ReadonlyArray<PostHogMessage>, size: number): Array<ReadonlyArray<PostHogMessage>> => {
  const chunks: Array<ReadonlyArray<PostHogMessage>> = []
  let index = 0

  while (index < messages.length) {
    chunks.push(messages.slice(index, index + size))
    index += size
  }

  return chunks
}

const drainQueue = (queue: Queue.Queue<PostHogMessage>) =>
  Effect.gen(function*() {
    const messages: Array<PostHogMessage> = []

    while (true) {
      const next = yield* Queue.poll(queue)

      if (Option.isNone(next)) {
        return messages
      }

      messages.push(next.value)
    }
  })

const enqueueAll = (queue: Queue.Queue<PostHogMessage>, messages: ReadonlyArray<PostHogMessage>) =>
  Effect.gen(function*() {
    for (const message of messages) {
      const offered = yield* Queue.offer(queue, message)

      if (!offered) {
        return yield* new PostHogStateError({
          message: "PostHog queue is closed"
        })
      }
    }
  })

const persistFeatureFlags = (persistence: PostHogPersistenceStore, snapshot: FeatureFlagsSnapshot) =>
  Effect.all([
    persistence.set(PersistedProperty.FeatureFlags, snapshot.featureFlags),
    persistence.set(PersistedProperty.FeatureFlagPayloads, snapshot.featureFlagPayloads)
  ]).pipe(Effect.asVoid)

const clearPersistedFeatureFlags = (persistence: PostHogPersistenceStore) =>
  Effect.all([
    persistence.remove(PersistedProperty.FeatureFlags),
    persistence.remove(PersistedProperty.FeatureFlagPayloads)
  ]).pipe(Effect.asVoid)

const persistPersonProperties = (persistence: PostHogPersistenceStore, snapshot: PersonPropertiesSnapshot) =>
  Effect.all([
    hasProperties(snapshot.set)
      ? persistence.set(PersistedProperty.PersonProperties, snapshot.set)
      : persistence.remove(PersistedProperty.PersonProperties),
    hasProperties(snapshot.setOnce)
      ? persistence.set(PersistedProperty.PersonPropertiesOnce, snapshot.setOnce)
      : persistence.remove(PersistedProperty.PersonPropertiesOnce)
  ]).pipe(Effect.asVoid)

const makeFeatureFlagProperties = (state: RuntimeState): JsonObject => {
  const properties: Record<string, JsonValue> = {}
  const activeFeatureFlags: Array<string> = []

  for (const [key, value] of Object.entries(state.featureFlags)) {
    if (value !== false) {
      activeFeatureFlags.push(key)
      properties[`$feature/${key}`] = value
    }
  }

  if (activeFeatureFlags.length > 0) {
    properties.$active_feature_flags = activeFeatureFlags
  }

  return properties
}

export class PostHog extends Context.Service<PostHog, PostHogService>()("PostHog") {
  static readonly Live = Layer.effect(PostHog)(
    Effect.gen(function*() {
      const config = yield* PostHogConfig
      const persistence = yield* PostHogPersistence
      const transport = yield* PostHogTransport
      const queue = yield* Queue.bounded<PostHogMessage>(config.queueCapacity)
      const flushRequests = yield* Queue.unbounded<void>()
      const retrySchedule = makeRetrySchedule(config)
      const persistedAnonymousId = yield* persistence.get(PersistedProperty.AnonymousId)
      const persistedDistinctId = yield* persistence.get(PersistedProperty.DistinctId)
      const persistedFeatureFlags = yield* persistence.get(PersistedProperty.FeatureFlags)
      const persistedFeatureFlagPayloads = yield* persistence.get(PersistedProperty.FeatureFlagPayloads)
      const persistedOptedOut = yield* persistence.get(PersistedProperty.OptedOut)
      const persistedPersonProperties = yield* persistence.get(PersistedProperty.PersonProperties)
      const persistedPersonPropertiesOnce = yield* persistence.get(PersistedProperty.PersonPropertiesOnce)
      const anonymousId = typeof persistedAnonymousId === "string" ? persistedAnonymousId : yield* createId()
      const distinctId = typeof persistedDistinctId === "string" ? persistedDistinctId : anonymousId
      const initialSnapshotCandidate: unknown = {
        featureFlagPayloads: persistedFeatureFlagPayloads,
        featureFlags: persistedFeatureFlags
      }
      const initialSnapshot = isFeatureFlagsSnapshot(initialSnapshotCandidate)
        ? initialSnapshotCandidate
        : emptyFeatureFlags()
      const initialPersonProperties: PersonPropertiesSnapshot = {
        set: isJsonRecord(persistedPersonProperties) ? persistedPersonProperties : emptyPersonProperties().set,
        setOnce: isJsonRecord(persistedPersonPropertiesOnce)
          ? persistedPersonPropertiesOnce
          : emptyPersonProperties().setOnce
      }

      yield* persistence.set(PersistedProperty.AnonymousId, anonymousId)
      yield* persistence.set(PersistedProperty.DistinctId, distinctId)

      const stateRef = yield* Ref.make<RuntimeState>({
        anonymousId,
        closed: false,
        distinctId,
        featureFlagPayloads: initialSnapshot.featureFlagPayloads,
        featureFlags: initialSnapshot.featureFlags,
        identified: anonymousId !== distinctId,
        optedOut: persistedOptedOut === true,
        personProperties: initialPersonProperties.set,
        personPropertiesOnce: initialPersonProperties.setOnce
      })

      const requestBackgroundFlush = Queue.offer(flushRequests, undefined).pipe(Effect.asVoid)

      const flushImpl: Effect.Effect<void, PostHogRuntimeError> = Effect.gen(function*() {
        const state = yield* Ref.get(stateRef)

        if (config.disabled || state.optedOut) {
          return
        }

        const drained = yield* drainQueue(queue)

        if (drained.length === 0) {
          return
        }

        let pending = drained

        for (const batch of chunkMessages(drained, config.maxBatchSize)) {
          const sentAt = yield* currentTimestamp()
          const request: BatchRequest = {
            apiHost: config.apiHost,
            apiKey: config.apiKey,
            batch,
            sentAt
          }

          yield* transport.sendBatch(request).pipe(
            Effect.retry(retrySchedule),
            Effect.catch((error: PostHogTransportError) => enqueueAll(queue, pending).pipe(Effect.andThen(Effect.fail(error))))
          )

          pending = pending.slice(batch.length)
        }
      })

      yield* Effect.forever(
        Queue.take(flushRequests).pipe(Effect.andThen(flushImpl), Effect.catch(() => Effect.void))
      ).pipe(Effect.forkScoped)

      const ensureOpen: Effect.Effect<RuntimeState, PostHogStateError> = Effect.gen(function*() {
        const state = yield* Ref.get(stateRef)

        if (state.closed) {
          return yield* new PostHogStateError({
            message: "PostHog client is shut down"
          })
        }

        return state
      })

      const captureImpl: PostHogService["capture"] = (
        event: string,
        properties: JsonObject = {},
        options: CaptureOptions = {}
      ) =>
        Effect.gen(function*() {
          const state = yield* ensureOpen

          if (config.disabled || state.optedOut) {
            return
          }

          const timestamp = yield* currentTimestamp(options.timestamp)
          const uuid = yield* currentUuid(options.uuid)
          const message: PostHogMessage = {
            distinct_id: state.distinctId,
            event,
            library: config.library,
            library_version: config.libraryVersion,
            properties: {
              ...makeBaseProperties(config, state),
              ...makeFeatureFlagProperties(state),
              ...properties
            },
            timestamp,
            type: event === "$identify" ? "identify" : "capture",
            uuid
          }

          const offered = yield* Queue.offer(queue, message)

          if (!offered) {
            return yield* new PostHogStateError({
              message: "PostHog queue is closed"
            })
          }

          const size = yield* Queue.size(queue)

          if (size >= config.flushAt) {
            yield* requestBackgroundFlush
          }
        })

      const reloadFeatureFlagsImpl: PostHogService["reloadFeatureFlags"] = () =>
        Effect.gen(function*() {
          const state = yield* ensureOpen

          if (config.disabled || state.optedOut) {
            return emptyFeatureFlags()
          }

          const request: FeatureFlagsRequest = {
            anonymousId: state.anonymousId,
            apiHost: config.apiHost,
            apiKey: config.apiKey,
            distinctId: state.distinctId
          }

          const snapshot = yield* transport.loadFeatureFlags(request).pipe(Effect.retry(retrySchedule))

          yield* Ref.update(stateRef, (current) => ({
            ...current,
            featureFlagPayloads: snapshot.featureFlagPayloads,
            featureFlags: snapshot.featureFlags
          }))
          yield* persistFeatureFlags(persistence, snapshot)

          return snapshot
        })

      const identifyImpl: PostHogService["identify"] = (nextDistinctId: string, properties: JsonObject = {}) =>
        Effect.gen(function*() {
          const state = yield* ensureOpen
          const split = splitIdentifyProperties(properties)
          const isNewIdentity = state.distinctId !== nextDistinctId || state.identified === false
          const nextPersonProperties = isNewIdentity
            ? {
                set: split.setProperties,
                setOnce: split.setOnceProperties ?? {}
              }
            : mergePersonProperties(
                {
                  set: state.personProperties,
                  setOnce: state.personPropertiesOnce
                },
                split
              )

          yield* Ref.update(stateRef, (current) => ({
            ...current,
            distinctId: nextDistinctId,
            identified: true,
            personProperties: nextPersonProperties.set,
            personPropertiesOnce: nextPersonProperties.setOnce
          }))

          if (isNewIdentity) {
            yield* persistence.set(PersistedProperty.DistinctId, nextDistinctId)
          }

          yield* persistPersonProperties(persistence, nextPersonProperties)

          if (config.disabled || state.optedOut) {
            return
          }

          if (isNewIdentity) {
            const timestamp = yield* currentTimestamp()
            const uuid = yield* currentUuid()
            const identifyProperties: Record<string, JsonValue> = {
              ...makeBaseProperties(config, { ...state, distinctId: nextDistinctId, identified: true }),
              $anon_distinct_id: state.anonymousId,
              $set: split.setProperties
            }

            if (split.setOnceProperties !== undefined) {
              identifyProperties.$set_once = split.setOnceProperties
            }

            yield* captureImpl("$identify", identifyProperties, { timestamp: new Date(timestamp), uuid })
            yield* reloadFeatureFlagsImpl()
            return
          }

          const changedSet = diffSetProperties(state.personProperties, split.setProperties)
          const changedSetOnce = diffSetOnceProperties(state.personPropertiesOnce, split.setOnceProperties)

          if (hasProperties(changedSet) || hasProperties(changedSetOnce)) {
            yield* captureImpl("$set", {
              $set: changedSet,
              $set_once: changedSetOnce
            })
          }

          yield* reloadFeatureFlagsImpl()
        })

      const resetImpl: PostHogService["reset"] = (preserve: ReadonlyArray<PersistedProperty> = []) =>
        Effect.gen(function*() {
          yield* ensureOpen

          const nextAnonymousId = yield* createId()
          const state = yield* Ref.get(stateRef)
          const keepFlags = preserve.includes(PersistedProperty.FeatureFlags)
          const keepFlagPayloads = preserve.includes(PersistedProperty.FeatureFlagPayloads)
          const nextState: RuntimeState = {
            anonymousId: nextAnonymousId,
            closed: false,
            distinctId: nextAnonymousId,
            featureFlagPayloads: keepFlagPayloads ? state.featureFlagPayloads : {},
            featureFlags: keepFlags ? state.featureFlags : {},
            identified: false,
            optedOut: state.optedOut,
            personProperties: {},
            personPropertiesOnce: {}
          }

          yield* Ref.set(stateRef, nextState)
          yield* persistence.set(PersistedProperty.AnonymousId, nextAnonymousId)
          yield* persistence.set(PersistedProperty.DistinctId, nextAnonymousId)

          if (keepFlags || keepFlagPayloads) {
            yield* persistFeatureFlags(persistence, {
              featureFlagPayloads: nextState.featureFlagPayloads,
              featureFlags: nextState.featureFlags
            })
          } else {
            yield* clearPersistedFeatureFlags(persistence)
          }

          yield* persistPersonProperties(persistence, emptyPersonProperties())
        })

      const shutdownImpl: PostHogService["shutdown"] = () =>
        Effect.gen(function*() {
          const state = yield* Ref.get(stateRef)

          if (state.closed) {
            return
          }

          yield* flushImpl
          yield* Ref.update(stateRef, (current) => ({
            ...current,
            closed: true
          }))
          yield* Queue.shutdown(flushRequests)
          yield* Queue.shutdown(queue)
        })

      const service: PostHogService = {
        capture: captureImpl,
        flush: () => flushImpl,
        getDistinctId: () => Ref.get(stateRef).pipe(Effect.map((state) => state.distinctId)),
        getFeatureFlag: (key: string) => Ref.get(stateRef).pipe(Effect.map((state) => state.featureFlags[key])),
        getFeatureFlagPayload: (key: string) => Ref.get(stateRef).pipe(Effect.map((state) => state.featureFlagPayloads[key])),
        getFeatureFlagPayloads: () => Ref.get(stateRef).pipe(Effect.map((state) => state.featureFlagPayloads)),
        getFeatureFlags: () => Ref.get(stateRef).pipe(Effect.map((state) => state.featureFlags)),
        identify: identifyImpl,
        optIn: () =>
          Ref.update(stateRef, (state) => ({
            ...state,
            optedOut: false
          })).pipe(Effect.andThen(persistence.set(PersistedProperty.OptedOut, false))),
        optOut: () =>
          Ref.update(stateRef, (state) => ({
            ...state,
            optedOut: true
          })).pipe(Effect.andThen(persistence.set(PersistedProperty.OptedOut, true)), Effect.andThen(drainQueue(queue)), Effect.asVoid),
        reloadFeatureFlags: reloadFeatureFlagsImpl,
        reset: resetImpl,
        shutdown: shutdownImpl
      }

      if (config.preloadFeatureFlags && !config.disabled) {
        yield* reloadFeatureFlagsImpl()
      }

      return yield* Effect.acquireRelease(Effect.succeed(service), () => shutdownImpl().pipe(Effect.catch(() => Effect.void)))
    })
  )

  static readonly layer = (input: PostHogConfigInput) =>
    PostHog.Live.pipe(
      Layer.provide(PostHogConfig.layer(input)),
      Layer.provide(PostHogPersistence.Memory),
      Layer.provide(PostHogTransport.Fetch)
    )

  static readonly browserLayer = (input: PostHogConfigInput) =>
    PostHog.Live.pipe(
      Layer.provide(PostHogConfig.layer(input)),
      Layer.provide(PostHogPersistence.Browser),
      Layer.provide(PostHogTransport.Fetch)
    )

  static readonly layerFromEnv = () =>
    PostHog.Live.pipe(
      Layer.provide(PostHogConfig.fromEnv),
      Layer.provide(PostHogPersistence.Memory),
      Layer.provide(PostHogTransport.Fetch)
    )

  static readonly capture = (event: string, properties: JsonObject = {}, options: CaptureOptions = {}) =>
    PostHog.use((service) => service.capture(event, properties, options))

  static readonly flush = () => PostHog.use((service) => service.flush())

  static readonly getDistinctId = () => PostHog.use((service) => service.getDistinctId())

  static readonly getFeatureFlag = (key: string) => PostHog.use((service) => service.getFeatureFlag(key))

  static readonly getFeatureFlagPayload = (key: string) => PostHog.use((service) => service.getFeatureFlagPayload(key))

  static readonly getFeatureFlagPayloads = () => PostHog.use((service) => service.getFeatureFlagPayloads())

  static readonly getFeatureFlags = () => PostHog.use((service) => service.getFeatureFlags())

  static readonly identify = (distinctId: string, properties: JsonObject = {}) =>
    PostHog.use((service) => service.identify(distinctId, properties))

  static readonly optIn = () => PostHog.use((service) => service.optIn())

  static readonly optOut = () => PostHog.use((service) => service.optOut())

  static readonly reloadFeatureFlags = () => PostHog.use((service) => service.reloadFeatureFlags())

  static readonly reset = (preserve: ReadonlyArray<PersistedProperty> = []) =>
    PostHog.use((service) => service.reset(preserve))

  static readonly shutdown = () => PostHog.use((service) => service.shutdown())
}
