import { AgentPane } from './components/AgentPane.js';
import { GithubPane } from './components/GithubPane.js';

const panes = [
  {
    id: 'head',
    role: 'Head / Operator',
    agent: 'Hermes',
    commandHint: 'hermes',
    description: 'Orchestration, specing, synthesis, and safety gates.',
  },
  {
    id: 'builder',
    role: 'Builder',
    agent: 'Claude Code',
    commandHint: 'claude',
    description: 'Implementation, verification, branch/PR creation, blocker fixes.',
  },
  {
    id: 'reviewer_a',
    role: 'Reviewer A',
    agent: 'Codex',
    commandHint: 'codex',
    description: 'Correctness, tests, security, and regressions.',
  },
  {
    id: 'reviewer_b',
    role: 'Reviewer B',
    agent: 'Codex',
    commandHint: 'codex',
    description: 'Architecture, maintainability, spec drift, and harness compliance.',
  },
];

export function App() {
  return (
    <main className="app-shell">
      <header className="top-bar">
        <div>
          <p className="eyebrow">GodMode v0 scaffold</p>
          <h1>Bring-your-agent coding cockpit</h1>
        </div>
        <div className="status-pill">macOS · Electron · xterm · node-pty</div>
      </header>

      <section className="workspace-grid" aria-label="GodMode agent workspace">
        <div className="head-pane">
          <AgentPane {...panes[0]} />
        </div>
        <AgentPane {...panes[1]} />
        <AgentPane {...panes[2]} />
        <AgentPane {...panes[3]} />
        <GithubPane />
      </section>

      <footer className="command-bar">
        <span>Global command</span>
        <input placeholder="Hermes: pick up issue #12, Claude: explain your plan, Codex A: re-review latest commit..." />
      </footer>
    </main>
  );
}
