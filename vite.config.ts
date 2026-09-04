import path from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/web"),
    },
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
    rollupOptions: {
      input: {
        workbench: path.resolve(import.meta.dirname, "index.html"),
        viewerRuntime: path.resolve(import.meta.dirname, "viewer-runtime.html"),
        playerRuntime: path.resolve(import.meta.dirname, "player-runtime.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3847",
    },
  },
})
