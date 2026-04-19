import { Effect, Layer, Schedule } from "effect"
import * as Context from "effect/Context"

import { PostHogConfig, type PostHogSettings } from "./PostHogConfig"
import { PostHogTransportError } from "./PostHogError"

export interface PostHogRetryPolicy {
  readonly schedule: Schedule.Schedule<unknown, PostHogTransportError, never, never>
  readonly while: (error: PostHogTransportError) => boolean
}

const makeRetryPolicy = (config: PostHogSettings): PostHogRetryPolicy =>
  ({
    schedule: Schedule.exponential(config.fetchRetryBaseDelayMs).pipe(Schedule.both(Schedule.recurs(config.fetchRetryCount))),
    while: () => true
  })

export class PostHogRetry extends Context.Service<PostHogRetry, PostHogRetryPolicy>()("PostHogRetry") {
  static readonly layer = Layer.effect(PostHogRetry)(
    Effect.gen(function*() {
      const config = yield* PostHogConfig
      return makeRetryPolicy(config)
    })
  )

  static readonly none = Layer.succeed(PostHogRetry, {
    schedule: Schedule.recurs(0),
    while: () => false
  })
}
