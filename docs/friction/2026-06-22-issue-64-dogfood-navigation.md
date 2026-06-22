# 2026-06-22 — Issue #64 dogfood navigation

## What happened

While working issue #64 from the GodMode UI, several controls looked clickable
but did not change the visible app surface. The left rail's Settings, Pull
requests, and Dashboard buttons only received focus, and the Agent Models
Configure button did not open any configuration surface. The active run stayed
bound to issue #64, but the operator could not trust those controls to navigate.

The same dogfood run also surfaced follow-up friction outside the issue #64 fix:

- A stale Electron window from an old managed worktree was still running and
  showed Electron's default landing page, making it easy to target the wrong app
  window.
- Enabling worktree isolation in the run control changed the UI to
  `worktree / pending`, but no new issue #64 worktree appeared in
  `git worktree list --porcelain`, and the UI did not explain whether creation
  was still running or failed.
- After switching code while the dev Electron app was already open, the renderer
  blanked on a missing preload bridge method:
  `window.godmode?.onVerificationChanged is not a function`.
- CodeGraph returned symbols from old nested worktrees during orientation, which
  made the read-first pass noisy and easy to mis-scope.

## Root cause

For issue #64, the rail buttons and Configure button were static controls: they
had labels and focus behavior, but no shared app-view state or click handlers.
Adding view state exposed one secondary risk: unmounting the workspace on
navigation would tear down role panes and stop live PTYs. The workspace therefore
needs to stay mounted and be hidden when another top-level view is active.

The follow-up friction has separate likely causes:

- The stale Electron window was a leftover process from an old worktree run.
- Worktree isolation was able to record an intent/pending state without
  completing or surfacing actionable failure evidence.
- The missing bridge method was dev-session API skew between the live main/preload
  process and the hot-reloaded renderer.
- The CodeGraph index included generated/local worktree directories that should
  not participate in source orientation.

## Fix / workaround

Issue #64 now has explicit top-level views for Dashboard, Agent workspace, Pull
requests, and Settings. The rail sets `aria-current="page"` for the active view,
Configure opens Settings, and the Agent workspace remains mounted behind
`hidden` so live panes are preserved across navigation. A smoke assertion now
clicks through Settings, Dashboard, Agent workspace, and Configure in the real
Electron app.

Workarounds for the follow-ups until separate issues exist:

- Use Computer Use's app list and the window path/title before interacting with a
  GodMode window.
- Check `git worktree list --porcelain` when a run shows worktree pending.
- Restart the Electron dev app after preload/main API changes.
- Scope CodeGraph queries carefully when local `worktrees/` directories exist.

## Harness update needed?

No AGENTS.md or spec change is needed for issue #64 itself. Draft follow-up GitHub
issues for stale Electron process cleanup, worktree pending/error visibility,
preload API skew handling, and excluding managed/nested worktrees from CodeGraph
orientation.
