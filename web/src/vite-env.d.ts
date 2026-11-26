/// <reference types="vite/client" />

declare module '*?url' {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly VITE_SYNC_URL?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
}
