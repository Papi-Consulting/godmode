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

Maybe. Worth considering whether GodMode should give each agent session its own
git worktree (or clone) by default rather than sharing one checkout, so the
PR-loop roles cannot stash/checkout over each other. Filed as friction for now;
no code change in this PR.
