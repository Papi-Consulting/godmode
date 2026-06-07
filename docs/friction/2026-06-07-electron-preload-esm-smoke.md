# Electron Preload ESM Smoke Failure

## What happened

A manual Electron smoke test launched the app successfully, but the renderer did
not have `window.godmode`. Electron logged:

```text
Unable to load preload script: .../dist/preload/index.js
SyntaxError: Cannot use import statement outside a module
```

The same failure reproduced through `npm run electron:dev`.

## Root cause

`tsconfig.main.json` emits `src/preload/index.ts` as ESM because the package uses
`"type": "module"` and `module: "NodeNext"`. Electron loads this app's preload as
a CommonJS script, so the top-level `import` in `dist/preload/index.js` fails
before `contextBridge.exposeInMainWorld('godmode', ...)` runs.

## Fix / workaround

Keep the main process ESM build intact, but bundle the preload separately as
CommonJS:

- `npm run build:preload` writes `dist/preload/index.cjs`.
- `build:main` runs the TypeScript main build and then the preload bundle.
- `BrowserWindow.webPreferences.preload` points at `index.cjs`.
- `test/preload-build.test.js` asserts the built preload is CommonJS-loadable.

## Should harness docs change?

No broad AGENTS.md rule change is needed. The reusable lesson is local to the app
build: Electron preload output format must be smoke-tested, not inferred from
TypeScript typecheck/build success.
