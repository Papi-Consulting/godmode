# CodeGraph and Electron IPC

CodeGraph is useful for symbol discovery and local blast-radius checks, but it
does not fully infer Electron IPC flows. Treat every IPC change as a mixed graph
and manual string-channel review.

## Code Shape

- Define channel names once in `src/shared/ipcChannels.ts`.
- Use those constants from both `src/main/` and `src/preload/`; do not duplicate
  raw `godmode:*` channel strings in handler or facade code.
- Put non-trivial main-process IPC behavior in named handler functions such as
  `handleStartPty`, then register them in one place. Named functions give
  CodeGraph a stable symbol to search, even when it cannot connect the
  `ipcMain.handle(...)` callback to renderer calls.

## Review Workflow

For IPC-touching PRs, reviewers should use CodeGraph to search the handler,
facade method, and channel constant, then manually pair the full flow:

```text
renderer component -> window.godmode facade -> ipcRenderer.invoke/send
  -> GODMODE_IPC.* channel -> ipcMain.handle/on -> named handler
```

Reviewer summaries should still call out CodeGraph's IPC limitation explicitly
when IPC behavior changes.
