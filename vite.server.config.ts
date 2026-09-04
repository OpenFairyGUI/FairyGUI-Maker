import { defineConfig } from "vite"

export default defineConfig({
  build: {
    ssr: "src/server/index.ts",
    target: "node22",
    outDir: "dist/server",
    emptyOutDir: false,
  },
})
