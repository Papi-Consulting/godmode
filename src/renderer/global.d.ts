import type { GodModeApi } from '../preload/index.js';

declare global {
  interface Window {
    godmode?: GodModeApi;
  }
}

export {};
