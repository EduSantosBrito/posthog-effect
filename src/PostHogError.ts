import { Data } from "effect"

export class PostHogConfigError extends Data.TaggedError("PostHogConfigError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export class PostHogPersistenceError extends Data.TaggedError("PostHogPersistenceError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export class PostHogStateError extends Data.TaggedError("PostHogStateError")<{
  readonly message: string
}> {}

export class PostHogTransportError extends Data.TaggedError("PostHogTransportError")<{
  readonly message: string
  readonly cause: unknown
}> {}

export type PostHogError =
  | PostHogConfigError
  | PostHogPersistenceError
  | PostHogStateError
  | PostHogTransportError
