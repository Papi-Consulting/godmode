# 2026-06-04 — Concurrent sessions sharing one working tree

## What happened

While implementing issue #3 on `feat/config-loader`, in-progress edits silently
vanished mid-task: an `Edit` failed with "File has been modified since read",
`git status` came back clean, and a newly created file was gone. `git reflog`
showed branch checkouts and a reset that the working session never ran.

## Root cause

A second agent session was operating in the **same working tree**
(`/Users/creator/projects/godmode`) at the same time. It ran
`git stash --include-untracked` (auto-named `wip-before-<branch>`) over the other
session's uncommitted work, then switched branches to start its own task. Because
both sessions shared one checkout, the stash + checkout swept the first session's
changes out of the working directory. GodMode dogfoods its own multi-agent
harness, so concurrent sessions in one repo are expected — but a single shared
working tree is not safe for them.

## Fix / workaround

The work was fully recoverable from `stash@{0}`. Recovery + isolation steps:

1. Check `git stash list` and `git reflog` first — disappeared work is usually
   stashed, not lost.
2. Create a dedicated worktree per task:
   `git worktree add ../godmode-<slug> <branch>` (symlink `node_modules` from the
   primary checkout to avoid a reinstall).
3. `git stash apply` the recovered WIP into the worktree and **commit early** so
   it can't be wiped again.
4. Leave the primary working tree untouched if another session is mid-task there.

## Harness update needed?

**Resolved by issue #41.** GodMode now gives each run's builder/fix sessions an
isolated `git worktree` of the operated project when `workspace.isolation: worktree`
is enabled (default `shared` for one release of soak time). The builder works on a
per-run branch in a sibling `.godmode-worktrees/<project>-<run-id>` directory, so it
can never stash/checkout over the primary checkout or another session's uncommitted
work. The PTY cwd allowlist admits only the operated-project root or the active
run's worktree, and dogfooding (`isAppRepo`) surfaces a UI nudge to turn isolation
on. Reviewer roles stay read-only in the operated-project root and need no
isolation. See `docs/architecture/run-worktree-isolation.md`.

The original closing question — "whether GodMode should give each agent session its
own git worktree by default" — is answered: yes for the builder role, opt-in via
config today, with a dogfooding nudge.
