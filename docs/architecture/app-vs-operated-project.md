# App Repo vs Operated Project

GodMode always works with **two distinct repository contexts**. Conflating them
is dangerous once GodMode opens a repo other than its own, so the boundary is
modeled explicitly in docs, types, and UI.

## The two contexts

| Context | What it is | Where it lives in code |
| --- | --- | --- |
| **GodMode app repo** | The repository that ships the GodMode Electron app — its source, docs, config defaults, and development tasks. | `src/main/appRepo.ts` (`getAppRepoRoot`, `getAppRepoState`); `AppRepoState` type; resolved by walking up to GodMode's own `package.json`. |
| **Operated project** | The external repo/project currently opened inside GodMode and worked on by configured agents. | `src/main/project.ts` (`selectedProjectRoot`, `getSelectedProjectRoot`); `ProjectState` type. |

The GodMode app repo is fixed for a given build — it is wherever the app runs
from. The operated project is whatever root the operator selected and can be
re-pointed at any time.

## Rules

- **Harness detection** (`detectHarness`) always runs against the **operated
  project root**, never implicitly against GodMode's own repo. The required and
  optional harness files are looked up relative to the selected root.
- **PTY launches** (`openPtySession`) use the **operated project root** as their
  working directory. The app repo root must never be used as a PTY `cwd`. When
  the operated project changes, live PTY sessions are torn down so a terminal
  never outlives the project it was spawned in.
- **GitHub lookups** (`getGithubState`) shell out to `gh`/`git` in the
  **operated project root**. Issues and PRs surfaced in the GitHub pane belong
  to the operated project, not automatically to the GodMode app repo.
- **The app repo root is for identity/display only** — showing the app
  name/version and detecting self-dogfooding. It is never a working directory
  for agent operations.

## Self-dogfooding is the special case

GodMode is built by running GodMode on the GodMode repo. In that situation the
operated project root resolves to the same directory as the app repo. The
contexts coincide **on disk**, but the conceptual boundary still holds: agents
act on that directory as the *operated project*, exactly as they would for any
external repo.

`ProjectState.isAppRepo` flags this case (canonicalized path comparison against
the app repo root). The UI surfaces it as a "dogfooding · same as app repo"
badge in the project bar. Nothing in the harness/PTY/GitHub paths branches on
`isAppRepo` — it is a visibility signal for the operator, not a behavior switch.
This keeps the two contexts from collapsing into one even when they point at the
same files.

## A run worktree is the operated project at a different path

When `workspace.isolation: worktree` is enabled (issue #41), a run's builder/fix
sessions work in a per-run `git worktree` of the operated project rather than the
primary checkout. That worktree **is** the operated project — same repo, same
conceptual context — just at a different filesystem path. It therefore extends,
not violates, the "agent commands run in the operated-project directory" rule: the
PTY cwd allowlist admits exactly the operated-project root or the active run's
worktree. Reviewer launches, GitHub state, harness detection, and `gh` calls still
scope to the operated-project root; only the builder/fix sessions move into the
worktree. The dogfooding case is exactly where this matters most — the operated
tree is also the live app/dev-server checkout — so the `isAppRepo` badge drives a
UI *nudge* to enable isolation, while the worktree behavior itself never branches
on `isAppRepo`. See `docs/architecture/run-worktree-isolation.md`.

## Why this matters

If "this repo" were silently treated as "the selected project," then once
GodMode opens another repo:

- agents could read or mutate the wrong harness,
- PR/issue state could be associated with the app repo instead of the operated
  repo,
- PTY sessions could run in the wrong working directory,
- dashboard labels would not tell the operator which context is shown.

Modeling the two contexts separately makes each of these a type/UI-level
distinction rather than an implicit assumption.
