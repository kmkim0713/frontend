/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_SERVER: string;
  readonly VITE_STUN_SERVER: string;
  readonly VITE_TURN_SERVER: string;
  readonly VITE_TURN_USERNAME: string;
  readonly VITE_TURN_CREDENTIAL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
