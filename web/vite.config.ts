import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error plain ESM helper with no type declarations
import { articleMiddleware } from './server/article-proxy.mjs';

// Mounts the same article importer the production server uses, so "Save
// article" works under `npm run dev` too.
const articleApi = (): Plugin => ({
  name: 'read-article-api',
  configureServer(server) {
    server.middlewares.use(articleMiddleware);
  },
  configurePreviewServer(server) {
    server.middlewares.use(articleMiddleware);
  },
});

export default defineConfig({
  plugins: [articleApi()],
  build: {
    target: 'es2022',
  },
  worker: {
    format: 'es',
  },
});
