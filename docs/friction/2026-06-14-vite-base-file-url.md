# Production renderer blank under Electron file:// (Vite base)

## What happened

The very first run of the new live-Electron smoke test (`npm run smoke`, issue
#35) failed at "waiting for the ProjectBar to render": the production renderer
came up blank. `npm run typecheck`, `npm test`, and `npm run build` were all
green — exactly the same blind spot as the #34 preload failure.

## Root cause

`vite build` emitted the built `dist/renderer/index.html` with **absolute** asset
URLs:

```html
<script type="module" src="/assets/index-….js"></script>
<link rel="stylesheet" href="/assets/index-….css">
```

In production the main process loads the renderer with
`BrowserWindow.loadFile(dist/renderer/index.html)`, i.e. over `file://`. Under
`file://`, a leading-slash URL resolves against the **filesystem root** (`file:///assets/…`),
not the app directory, so the script/styles 404 and React never mounts. Dev mode
hid this because the Vite dev server serves from `/`.

## Fix / workaround

Set `base: './'` in `vite.config.ts` so assets are emitted as relative URLs
(`./assets/…`), which resolve correctly under `file://`. The smoke now passes and
guards against regressions.

## Should harness docs change?

No broad rule change. The reusable lesson matches the #34 one: Electron
production-load behavior (preload format, renderer asset base) must be smoke-tested
against the real built app, not inferred from typecheck/build success. The
`npm run smoke` guard now covers both.
