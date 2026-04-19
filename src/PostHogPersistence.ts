import * as Context from "effect/Context"
import { Effect, Layer, Ref } from "effect"

import { PostHogPersistenceError } from "./PostHogError"

export interface BrowserStorageLike {
  getItem(key: string): string | null
  removeItem(key: string): void
  setItem(key: string, value: string): void
}

export interface BrowserDocumentLike {
  cookie: string
}

export interface PostHogCookieOptions {
  readonly domain?: string
  readonly maxAgeSeconds?: number
  readonly path?: string
  readonly sameSite?: "Lax" | "None" | "Strict"
  readonly secure?: boolean
}

export interface PostHogBrowserPersistenceOptions {
  readonly cookie?: BrowserDocumentLike
  readonly cookieOptions?: PostHogCookieOptions
  readonly localStorage?: BrowserStorageLike
}

export interface PostHogPersistenceService {
  readonly get: (key: string) => Effect.Effect<unknown | undefined, PostHogPersistenceError>
  readonly remove: (key: string) => Effect.Effect<void, PostHogPersistenceError>
  readonly set: (key: string, value: unknown) => Effect.Effect<void, PostHogPersistenceError>
}

const DEFAULT_COOKIE_OPTIONS: Required<Pick<PostHogCookieOptions, "path" | "sameSite">> = {
  path: "/",
  sameSite: "Lax"
}

const makePersistenceError = (message: string, cause: unknown) =>
  new PostHogPersistenceError({
    message,
    cause
  })

const serialize = (key: string, value: unknown) =>
  Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => makePersistenceError(`Failed to serialize persisted value for ${key}`, cause)
  })

const deserialize = (key: string, value: string) =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(value)
      return parsed
    },
    catch: (cause) => makePersistenceError(`Failed to deserialize persisted value for ${key}`, cause)
  })

const readStorageValue = (storage: BrowserStorageLike, key: string) =>
  Effect.try({
    try: () => storage.getItem(key),
    catch: (cause) => makePersistenceError(`Failed to read localStorage key ${key}`, cause)
  })

const writeStorageValue = (storage: BrowserStorageLike, key: string, value: string) =>
  Effect.try({
    try: () => storage.setItem(key, value),
    catch: (cause) => makePersistenceError(`Failed to write localStorage key ${key}`, cause)
  })

const removeStorageValue = (storage: BrowserStorageLike, key: string) =>
  Effect.try({
    try: () => storage.removeItem(key),
    catch: (cause) => makePersistenceError(`Failed to remove localStorage key ${key}`, cause)
  })

const parseCookieHeader = (cookieHeader: string): Map<string, string> => {
  const entries = cookieHeader
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  const cookies = new Map<string, string>()

  for (const entry of entries) {
    const separatorIndex = entry.indexOf("=")

    if (separatorIndex <= 0) {
      continue
    }

    const name = decodeURIComponent(entry.slice(0, separatorIndex))
    const value = entry.slice(separatorIndex + 1)
    cookies.set(name, value)
  }

  return cookies
}

const readCookieValue = (document: BrowserDocumentLike, key: string) =>
  Effect.try({
    try: () => {
      const cookies = parseCookieHeader(document.cookie)
      return cookies.get(key) ?? undefined
    },
    catch: (cause) => makePersistenceError(`Failed to read cookie ${key}`, cause)
  })

const makeCookieString = (key: string, value: string, options?: PostHogCookieOptions) => {
  const segments = [
    `${encodeURIComponent(key)}=${value}`,
    `Path=${options?.path ?? DEFAULT_COOKIE_OPTIONS.path}`,
    `SameSite=${options?.sameSite ?? DEFAULT_COOKIE_OPTIONS.sameSite}`
  ]

  if (options?.domain !== undefined) {
    segments.push(`Domain=${options.domain}`)
  }

  if (options?.maxAgeSeconds !== undefined) {
    segments.push(`Max-Age=${options.maxAgeSeconds}`)
  }

  if (options?.secure === true) {
    segments.push("Secure")
  }

  return segments.join("; ")
}

const writeCookieValue = (document: BrowserDocumentLike, key: string, value: string, options?: PostHogCookieOptions) =>
  Effect.try({
    try: () => {
      document.cookie = makeCookieString(key, value, options)
    },
    catch: (cause) => makePersistenceError(`Failed to write cookie ${key}`, cause)
  })

const removeCookieValue = (document: BrowserDocumentLike, key: string, options?: PostHogCookieOptions) =>
  Effect.try({
    try: () => {
      document.cookie = `${makeCookieString(key, "", options)}; Max-Age=0`
    },
    catch: (cause) => makePersistenceError(`Failed to remove cookie ${key}`, cause)
  })

const makeMemoryPersistence = (): Effect.Effect<PostHogPersistenceService> =>
  Effect.gen(function*() {
    const store = yield* Ref.make(new Map<string, unknown>())

    return {
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
  })

const makeLocalStoragePersistence = (storage: BrowserStorageLike): PostHogPersistenceService => ({
  get: (key: string) =>
    readStorageValue(storage, key).pipe(
      Effect.flatMap((value) => (value === null ? Effect.succeed(undefined) : deserialize(key, value)))
    ),
  remove: (key: string) => removeStorageValue(storage, key),
  set: (key: string, value: unknown) => serialize(key, value).pipe(Effect.flatMap((encoded) => writeStorageValue(storage, key, encoded)))
})

const makeCookiePersistence = (document: BrowserDocumentLike, options?: PostHogCookieOptions): PostHogPersistenceService => ({
  get: (key: string) =>
    readCookieValue(document, key).pipe(
      Effect.flatMap((value) => (value === undefined ? Effect.succeed(undefined) : deserialize(key, decodeURIComponent(value))))
    ),
  remove: (key: string) => removeCookieValue(document, key, options),
  set: (key: string, value: unknown) =>
    serialize(key, value).pipe(
      Effect.flatMap((encoded) => writeCookieValue(document, key, encodeURIComponent(encoded), options))
    )
})

const makeBrowserPersistence = (options: PostHogBrowserPersistenceOptions): PostHogPersistenceService => {
  const localStoragePersistence = options.localStorage !== undefined ? makeLocalStoragePersistence(options.localStorage) : undefined
  const cookiePersistence = options.cookie !== undefined ? makeCookiePersistence(options.cookie, options.cookieOptions) : undefined

  return {
    get: (key: string) =>
      Effect.gen(function*() {
        if (localStoragePersistence !== undefined) {
          const localValue = yield* localStoragePersistence.get(key)

          if (localValue !== undefined) {
            return localValue
          }
        }

        if (cookiePersistence === undefined) {
          return undefined
        }

        const cookieValue = yield* cookiePersistence.get(key)

        if (cookieValue !== undefined && localStoragePersistence !== undefined) {
          yield* localStoragePersistence.set(key, cookieValue)
        }

        return cookieValue
      }),
    remove: (key: string) =>
      Effect.all([
        localStoragePersistence?.remove(key) ?? Effect.void,
        cookiePersistence?.remove(key) ?? Effect.void
      ]).pipe(Effect.asVoid),
    set: (key: string, value: unknown) =>
      Effect.all([
        localStoragePersistence?.set(key, value) ?? Effect.void,
        cookiePersistence?.set(key, value) ?? Effect.void
      ]).pipe(Effect.asVoid)
  }
}

const requireLocalStorage = Effect.try({
  try: () => globalThis.localStorage,
  catch: (cause) => makePersistenceError("Browser localStorage is unavailable", cause)
}).pipe(
  Effect.flatMap((localStorage) =>
    localStorage === undefined
      ? Effect.fail(makePersistenceError("Browser localStorage is unavailable", undefined))
      : Effect.succeed(localStorage)
  )
)

const requireDocument = Effect.try({
  try: () => globalThis.document,
  catch: (cause) => makePersistenceError("Browser document is unavailable", cause)
}).pipe(
  Effect.flatMap((document) =>
    document === undefined
      ? Effect.fail(makePersistenceError("Browser document is unavailable", undefined))
      : Effect.succeed(document)
  )
)

export class PostHogPersistence extends Context.Service<PostHogPersistence, PostHogPersistenceService>()(
  "PostHogPersistence"
) {
  static readonly Memory = Layer.effect(PostHogPersistence)(makeMemoryPersistence())

  static readonly browser = (options: PostHogBrowserPersistenceOptions = {}) =>
    Layer.succeed(PostHogPersistence)(makeBrowserPersistence(options))

  static readonly Browser = Layer.effect(PostHogPersistence)(
    Effect.gen(function*() {
      const localStorage = yield* requireLocalStorage
      const document = yield* requireDocument

      return makeBrowserPersistence({
        cookie: document,
        localStorage
      })
    })
  )

  static readonly cookie = (document: BrowserDocumentLike, options?: PostHogCookieOptions) =>
    Layer.succeed(PostHogPersistence)(makeCookiePersistence(document, options))

  static readonly Cookie = (options?: PostHogCookieOptions) =>
    Layer.effect(PostHogPersistence)(requireDocument.pipe(Effect.map((document) => makeCookiePersistence(document, options))))

  static readonly localStorage = (storage: BrowserStorageLike) =>
    Layer.succeed(PostHogPersistence)(makeLocalStoragePersistence(storage))

  static readonly LocalStorage = Layer.effect(PostHogPersistence)(
    requireLocalStorage.pipe(Effect.map((storage) => makeLocalStoragePersistence(storage)))
  )
}
