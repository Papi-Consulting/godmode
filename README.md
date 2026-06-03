# GodMode

GodMode is a local, tmux-style, bring-your-own-agent coding dashboard.

It opens on a project harness, lets a human operator command and chat with an agent team, runs an automatic build-review-fix PR loop, and keeps final merge authority with the human.

## Default Karan Stack

- Head/operator: Hermes
- Builder: Claude Code
- Reviewer A: Codex for correctness/security/tests
- Reviewer B: Codex for architecture/spec/harness compliance

GodMode is agent-agnostic by design. Roles can be mapped to Hermes, Claude, Codex, OpenClaw, OpenCode, Gemini, or custom CLI agents.

## V1 Tech Stack

- Electron macOS app
- TypeScript
- React + Vite renderer
- xterm.js terminal panes
- Node.js + node-pty process manager
- SQLite via better-sqlite3
- GitHub via git/gh CLI
- Project config via `.agentic/godmode.yaml`

## Getting Started

```bash
npm install
npm run build
npm run electron:dev
```

The first scaffold includes a static tmux-style dashboard and PTY-backed terminal panes. It is not yet the full PR automation loop.

## Docs

- Product spec: `docs/godmode-v1-product-spec.md`
- Living project spec: `docs/spec.md`
- Agent harness: `AGENTS.md`
- Project config: `.agentic/godmode.yaml`
