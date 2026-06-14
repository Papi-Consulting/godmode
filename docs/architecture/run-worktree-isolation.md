# Run worktree isolation (issue #41)

GodMode can give each run's **builder/fix** sessions an isolated `git worktree` of
the operated project so an agent switching branches, stashing, or rewriting files
can never collide with the running app's checkout or sweep away another session's
uncommitted work. This is the dogfood-safety answer to the 2026-06-04 friction
collision (`docs/friction/2026-06-04-shared-working-tree-collision.md`): when
GodMode operates on its own repo, the operated tree is also the live Electron app
and Vite dev-server checkout.

A run worktree **is** the operated project at a different path — same repo, same
conceptual context — so it extends rather than violates the AGENTS.md rule that
agent commands run inside the operated-project directory.

## Enablement

- Config: `workspace.isolation: worktree | shared` in `.agentic/godmode.yaml`.
  Default `shared` (today's behavior) for one release of soak time.
- The effective mode is bound onto the run snapshot at selection time
  (`RunSnapshot.isolation`), resolved from config by the main process (the run
  state module stays config/Electron-free).
- Dogfooding nudge: when the operated project is the app repo
  (`ProjectState.isAppRepo`), the Run Control pane shows a one-line recommendation
  with a one-click "Enable worktree for this run" that flips `RunSnapshot.isolation`
  to `worktree` (allowed only before the builder starts:
  `issue_selected`/`needs_spec`/`ready_to_build`). This is a UI nudge keyed off the
  existing flag — the core worktree behavior never branches on `isAppRepo`.

## Layout

For project root `/…/parent/<project>` and run id `<run-id>`:

- Worktree dir: `/…/parent/.godmode-worktrees/<project>-<run-id>` — a **sibling**
  of the primary checkout, deliberately outside it so Vite/electron watchers and
  harness detection never see it.
- Branch: `godmode/<run-id>`, created off the project's current `HEAD`.

`node_modules` is **not** copied or symlinked: the handoff already tells the
builder to run the project's verification commands, and `npm install` in the
worktree is the boring default. (Optional symlinking is a future refinement.)

Path/branch derivation (`deriveWorktreePlan`) and the managed-path guard
(`isManagedWorktreePath`) are pure and unit-tested without a repo. The git-backed
lifecycle shells out with the same discipline as `github.ts` (`execFile`, no
shell, bounded timeout/buffer) and never throws — every failure folds into a typed
`{ ok: false, error }`.

## Lifecycle

1. **Create / reuse.** `ensureRunWorktree` (in `src/main/index.ts`) runs when the
   builder pane starts and again when the handoff is sent. It is idempotent:
   first use creates the worktree on its branch (`git worktree add -b`), records it
   on the run (`RunSnapshot.worktree` + the working `branch`), and emits the
   change; later calls (fix cycles, a re-prepare after a pane restart) reuse the
   same dir/branch. Failure (not a git repo, branch checked out elsewhere) is a
   **visible error** and the run does not advance as if the handoff were ready.
2. **Launch.** The builder PTY launches with the worktree as cwd; every other pane
   (head, reviewers) stays in the operated-project root. `openPtySession` enforces
   the cwd allowlist below and records the launch cwd per pane.
3. **Send.** Before delivering the prompt, the send path confirms the live builder
   PTY is actually running in the worktree (`getPtySessionCwd`); if the pane was
   started before the worktree existed, the operator is asked to restart it. The
   prompt names the worktree path as the working root and still names the operated
   project.
4. **Fix cycles** reuse the same run worktree/branch.
5. **Cleanup** (below).

## PTY cwd allowlist

`isAllowedPtyCwd(projectRoot, worktreePath, candidate)` admits a launch cwd only
when it resolves to exactly the operated-project root or the active run's
registered worktree. Anything else is rejected with a visible error rather than
spawned. This is the enforcement point for the AGENTS.md operated-project rule
under isolation.

## Verification scope

An isolated run's working branch lives in the worktree, so the primary checkout
stays on its own branch. The commit-verification gate (#9) therefore accepts an
explicit `branch` (the run's recorded branch) when the run is isolated, instead of
reading the current branch of the project root. `gh`/`git` still run in the
operated-project root — only the branch being queried changes. Reviewer launches,
GitHub state, and harness detection are unchanged.

## Cleanup policy

Cleanup is exposed via `godmode:worktree:list` (managed worktrees + cleanliness)
and `godmode:worktree:cleanup` (remove by path). Rules:

- **Never auto-delete a dirty worktree.** A worktree is *clean* only when it has no
  uncommitted/untracked changes **and** no commits on `HEAD` absent from every
  remote-tracking branch (unpushed work). The check is conservative — a failed git
  query counts as dirty.
- The **current run's** worktree can only be cleaned once the run reaches a
  terminal status (`closed`/`cancelled`/`karan_merged`).
- Cleanup refuses a path outside the managed parent dir, a dirty/unpushed tree
  (with the reason), and `git worktree remove` runs without `--force` as a backstop.
- **Orphans:** on app start / project select the dashboard lists managed worktrees
  for the project and offers cleanup under the same dirty-check rules.

## Key code

- `src/main/worktree.ts` — pure derivation + git lifecycle (create/inspect/remove/list).
- `src/main/pty.ts` — `isAllowedPtyCwd`, cwd-tracked sessions, `getPtySessionCwd`.
- `src/main/index.ts` — `ensureRunWorktree`, PTY/handoff/fix wiring, cleanup handlers.
- `src/main/run.ts` — `RunSnapshot.isolation`/`worktree` setters, `isTerminalStatus`.
- `src/main/config.ts` — `workspace.isolation` schema + `resolveWorkspaceIsolation`.
- `src/main/handoff.ts` — worktree-aware working-root line in both compose functions.
- Tests: `test/worktree.test.js` (scratch `git init` repo, collision regression).
