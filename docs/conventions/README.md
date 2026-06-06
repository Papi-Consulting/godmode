# Conventions Docs

Convention docs are the durable home for GodMode operating rules that should guide agents across issues and PRs.

Use this folder for:

- branch and PR policy,
- testing and verification expectations,
- code style and implementation guidelines,
- issue-to-PR workflow details,
- reviewer/blocker classification rules that apply across the repo.

Current conventions:

- `codegraph-ipc.md` — how to structure and review Electron IPC paths when
  CodeGraph cannot infer string-channel flow automatically.

Conventions:

- Keep `AGENTS.md` focused on the high-level contract and link deeper standing rules from here.
- Update this folder when a rule should guide future agents instead of living only in a prompt or PR comment.
- If a convention changes because of friction, also add a short note under `docs/friction/`.
