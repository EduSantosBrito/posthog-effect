import { defineConfig } from "vitest/config"

export default defineConfig({
  build: {
    lib: {
      entry: "./src/index.ts",
      fileName: "index",
      formats: ["es"]
    },
    sourcemap: true,
    target: "esnext",
    minify: false,
    rollupOptions: {
      external: [
        /^effect(\/.*)?$/
      ]
    }
  },
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"]
  }
})
