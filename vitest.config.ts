import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "~prisma": path.resolve(import.meta.dirname, "prisma/generated") } },
  test: { include: ["test/**/*.test.ts"], fileParallelism: false },
})
