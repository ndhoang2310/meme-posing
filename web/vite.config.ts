import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  worker: {
    // MUST stay classic ("iife"): MediaPipe's UMD WASM loader registers itself
    // via importScripts/global scope. Module workers ("es") leave
    // self.ModuleFactory unset -> "ModuleFactory not set." at boot.
    format: "iife",
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
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
