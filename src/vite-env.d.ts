/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Injected at build time (see vite.config.ts `define`). Lets us show which build is
// actually live on a device — invaluable for confirming a deploy reached your phone.
declare const __BUILD_ID__: string;
