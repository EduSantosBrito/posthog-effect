import { Redacted, Schema } from "effect"

export type JsonPrimitive = boolean | null | number | string

export type JsonValue = JsonPrimitive | JsonObject | JsonArray

export interface JsonArray extends ReadonlyArray<JsonValue> {}

export interface JsonObject {
  readonly [key: string]: JsonValue
}

export const JsonValueSchema = Schema.Json

export const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json)

export interface CaptureOptions {
  readonly timestamp?: Date
  readonly uuid?: string
}

export interface PostHogMessage {
  readonly distinct_id: string
  readonly event: string
  readonly library: string
  readonly library_version: string
  readonly properties: JsonObject
  readonly timestamp: string
  readonly type: "capture" | "identify"
  readonly uuid: string
}

export type FeatureFlagValue = boolean | string

export const FeatureFlagValueSchema = Schema.Union([Schema.Boolean, Schema.String])

export interface FeatureFlagsSnapshot {
  readonly featureFlags: Readonly<Record<string, FeatureFlagValue>>
  readonly featureFlagPayloads: Readonly<Record<string, unknown>>
}

export const FeatureFlagsSnapshotSchema = Schema.Struct({
  featureFlags: Schema.Record(Schema.String, FeatureFlagValueSchema),
  featureFlagPayloads: Schema.Record(Schema.String, Schema.Unknown)
})

export interface PersonPropertiesSnapshot {
  readonly set: Readonly<Record<string, JsonValue>>
  readonly setOnce: Readonly<Record<string, JsonValue>>
}

export const PersonPropertiesSnapshotSchema = Schema.Struct({
  set: JsonObjectSchema,
  setOnce: JsonObjectSchema
})

export interface BatchRequest {
  readonly apiHost: string
  readonly apiKey: Redacted.Redacted<string>
  readonly batch: ReadonlyArray<PostHogMessage>
  readonly sentAt: string
}

export interface FeatureFlagsRequest {
  readonly anonymousId: string
  readonly apiHost: string
  readonly apiKey: Redacted.Redacted<string>
  readonly distinctId: string
}

export enum PersistedProperty {
  AnonymousId = "anonymous_id",
  DistinctId = "distinct_id",
  FeatureFlags = "feature_flags",
  FeatureFlagPayloads = "feature_flag_payloads",
  OptedOut = "opted_out",
  PersonProperties = "person_properties",
  PersonPropertiesOnce = "person_properties_once"
}
