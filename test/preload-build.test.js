// Electron loads preload scripts as CommonJS in this app. The TypeScript main
// build emits ESM because the package is `type: module`, so build:preload bundles
// a CJS entrypoint that Electron can execute. This regression guard catches the
// manual-smoke failure where `window.godmode` was missing because the preload
// still contained top-level `import` syntax.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

test('built Electron preload is CommonJS-loadable, not raw ESM', () => {
  const preload = fs.readFileSync('dist/preload/index.cjs', 'utf8');
  assert.match(preload, /require\(['"]electron['"]\)/);
  assert.doesNotMatch(preload, /^import\s/m);
  assert.match(preload, /contextBridge\.exposeInMainWorld\(['"]godmode['"]/);
});
