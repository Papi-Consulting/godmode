import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Emit relative asset URLs (./assets/…) so the production renderer loads under
  // Electron's file:// (BrowserWindow.loadFile). With Vite's default base of '/',
  // assets resolve against the filesystem root under file:// and the renderer
  // comes up blank — the live-Electron smoke test (#35) catches exactly this.
  base: './',
  root: '.',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: false,
  },
});
