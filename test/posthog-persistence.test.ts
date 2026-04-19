import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  PostHogPersistence,
  type BrowserDocumentLike,
  type BrowserStorageLike
} from "../src"

const makeStorage = (): BrowserStorageLike => {
  const state = new Map<string, string>()

  return {
    getItem: (key: string) => state.get(key) ?? null,
    removeItem: (key: string) => {
      state.delete(key)
    },
    setItem: (key: string, value: string) => {
      state.set(key, value)
    }
  }
}

const makeCookieDocument = (): BrowserDocumentLike => {
  const state = new Map<string, string>()

  return {
    get cookie() {
      return Array.from(state.entries())
        .map(([key, value]) => `${key}=${value}`)
        .join("; ")
    },
    set cookie(value: string) {
      const [nameValue, ...attributes] = value.split(";").map((segment) => segment.trim())

      if (nameValue === undefined) {
        return
      }

      const separatorIndex = nameValue.indexOf("=")

      if (separatorIndex <= 0) {
        return
      }

      const key = decodeURIComponent(nameValue.slice(0, separatorIndex))
      const encodedValue = nameValue.slice(separatorIndex + 1)
      const remove = attributes.some((attribute) => attribute === "Max-Age=0")

      if (remove) {
        state.delete(key)
        return
      }

      state.set(key, encodedValue)
    }
  }
}

describe("PostHog Persistence", () => {
  it.effect("memory persists values in-process", () =>
    Effect.gen(function*() {
      const result = yield* PostHogPersistence.use((service) =>
        Effect.gen(function*() {
          yield* service.set("feature_flags", { beta: true })

          return {
            stored: yield* service.get("feature_flags"),
            missing: yield* service.get("missing")
          }
        })
      ).pipe(Effect.provide(PostHogPersistence.Memory))

      expect(result.stored).toEqual({ beta: true })
      expect(result.missing).toBeUndefined()
    }))

  it.effect("browser persistence writes to localStorage and cookies", () =>
    Effect.gen(function*() {
      const storage = makeStorage()
      const document = makeCookieDocument()
      const result = yield* PostHogPersistence.use((service) =>
        Effect.gen(function*() {
          yield* service.set("distinct_id", "user-123")

          return yield* service.get("distinct_id")
        })
      ).pipe(
        Effect.provide(PostHogPersistence.browser({
          cookie: document,
          localStorage: storage
        }))
      )

      expect(result).toBe("user-123")
      expect(storage.getItem("distinct_id")).toBe(JSON.stringify("user-123"))
      expect(document.cookie).toContain("distinct_id=")
    }))

  it.effect("browser persistence falls back to cookies and hydrates localStorage", () =>
    Effect.gen(function*() {
      const storage = makeStorage()
      const document = makeCookieDocument()

      yield* PostHogPersistence.use((service) => service.set("anonymous_id", "anon-123")).pipe(
        Effect.provide(PostHogPersistence.cookie(document))
      )

      const restored = yield* PostHogPersistence.use((service) => service.get("anonymous_id")).pipe(
        Effect.provide(PostHogPersistence.browser({
          cookie: document,
          localStorage: storage
        }))
      )

      expect(restored).toBe("anon-123")
      expect(storage.getItem("anonymous_id")).toBe(JSON.stringify("anon-123"))
    }))

  it.effect("browser persistence removes values from localStorage and cookies", () =>
    Effect.gen(function*() {
      const storage = makeStorage()
      const document = makeCookieDocument()

      yield* PostHogPersistence.use((service) =>
        Effect.gen(function*() {
          yield* service.set("opted_out", true)
          yield* service.remove("opted_out")
        })
      ).pipe(
        Effect.provide(PostHogPersistence.browser({
          cookie: document,
          localStorage: storage
        }))
      )

      expect(storage.getItem("opted_out")).toBeNull()
      expect(document.cookie).not.toContain("opted_out=")
    }))
})
