import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  worker: {
    format: "es",
  },
  build: {
    outDir: "dist",
    assetsInlineLimit: 0,
  },
  server: {
    headers: {
      // Required for MediaPipe WASM + SharedArrayBuffer-free worker usage.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
