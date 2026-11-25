import { defineConfig } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
// The Tiny Voca assets are local files (about 55 MB). Let the webview keep them
// (and the compiled WebAssembly) between launches instead of re-checking each one.
const cacheVocaAssets = {
  name: "cache-voca-assets",
  configureServer(server: any) {
    server.middlewares.use("/voca", (_req: any, res: any, next: () => void) => {
      res.setHeader("Cache-Control", "public, max-age=86400");
      next();
    });
  },
};

export default defineConfig(async () => ({
  plugins: [cacheVocaAssets],

  // Module workers (voca, piper-wasm). piper-tts-web code-splits, which the
  // default "iife" worker format can't do.
  worker: {
    format: "es" as const,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1520,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1521,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
