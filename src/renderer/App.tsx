import { AgentPane } from './components/AgentPane.js';
import { GithubPane } from './components/GithubPane.js';

const panes = [
  {
    id: 'head',
    role: 'HEAD',
    agent: 'Hermes',
    commandHint: 'hermes',
    phase: 'orchestrating',
    accent: 'green',
  },
  {
    id: 'builder',
    role: 'BUILDER',
    agent: 'Claude Code',
    commandHint: 'claude',
    phase: 'ready',
    accent: 'cyan',
  },
  {
    id: 'reviewer_a',
    role: 'REV A',
    agent: 'Codex',
    commandHint: 'codex',
    phase: 'watching',
    accent: 'violet',
  },
  {
    id: 'reviewer_b',
    role: 'REV B',
    agent: 'Codex',
    commandHint: 'codex',
    phase: 'watching',
    accent: 'amber',
  },
];

const chatEvents = [
  {
    time: '19:42',
    from: 'karan',
    to: '@head',
    body: 'Draft a UI issue after we see a QuadWork-inspired GodMode surface.',
  },
  {
    time: '19:44',
    from: 'head',
    to: '@builder',
    body: 'Keep the dashboard tmux-like, local-first, and role/adapter agnostic.',
  },
  {
    time: '19:47',
    from: 'rev-a',
    to: '@head',
    body: 'Manual merge remains the final gate. Verification is separate from agent self-report.',
  },
  {
    time: '19:49',
    from: 'rev-b',
    to: '@builder',
    body: 'Display names can mention Hermes/Claude/Codex; core roles stay generic.',
  },
];

const schedulerLines = [
  '@head inspect issue #12',
  '@builder verify branch + PR state',
  '@reviewer_a review correctness blockers',
  '@reviewer_b review harness drift',
];

export function App() {
  return (
    <div className="app-frame">
      <aside className="rail" aria-label="Project switcher">
        <div className="rail-mark">GM</div>
        <button className="rail-button" aria-label="Dashboard">
          D
        </button>
        <button className="rail-button active" aria-label="Quad pane">
          Q
        </button>
        <button className="rail-button" aria-label="Pull requests">
          PR
        </button>
        <button className="rail-button" aria-label="Settings">
          S
        </button>
      </aside>

      <main className="app-shell">
        <header className="top-bar">
          <div className="brand-lockup">
            <strong>GodMode</strong>
            <span>local multi-agent harness</span>
          </div>
          <div className="top-metrics" aria-label="Run telemetry">
            <span>Today <strong>0.8h</strong></span>
            <span>Cycle <strong>1/3</strong></span>
            <span>Gate <strong>manual</strong></span>
          </div>
        </header>

        <section className="dashboard-grid" aria-label="GodMode agent workspace">
          <section className="panel chat-panel">
            <header className="panel-header">
              <div>
                <span className="section-kicker">Harness Chat</span>
                <strong>Team Control</strong>
              </div>
              <span className="header-chip">live draft</span>
            </header>
            <div className="chat-log" aria-label="Team chat transcript">
              {chatEvents.map((event) => (
                <article className="chat-line" key={`${event.time}-${event.from}`}>
                  <time>{event.time}</time>
                  <span className={`mention mention-${event.from}`}>{event.from}</span>
                  <span className="chat-target">{event.to}</span>
                  <p>{event.body}</p>
                </article>
              ))}
            </div>
            <div className="chat-input-row">
              <input aria-label="Chat message" placeholder="Message #godmode..." />
              <button>Send</button>
            </div>
            <div className="chat-controls" aria-label="Local run controls">
              <div>
                <span className="section-kicker">Server</span>
                <div className="button-row">
                  <button>Stop</button>
                  <button>Restart</button>
                  <button>Reset agents</button>
                </div>
              </div>
              <div>
                <span className="section-kicker">Keep Mac Awake</span>
                <p>Active for 2h 2m</p>
                <button className="primary-action">Awake 2h</button>
              </div>
              <div>
                <span className="section-kicker">Notifications</span>
                <div className="inline-controls">
                  <button className="primary-action">Sound</button>
                  <select aria-label="Notification sound" defaultValue="warm-bell">
                    <option value="warm-bell">Warm bell</option>
                    <option value="soft-ping">Soft ping</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          <section className="panel terminals-panel">
            <header className="panel-header">
              <div>
                <span className="section-kicker">Agent Terminals</span>
                <strong>Role-bound CLIs</strong>
              </div>
              <span className="header-chip success">PTY ready</span>
            </header>
            <div className="terminal-grid">
              {panes.map((pane) => (
                <AgentPane key={pane.id} {...pane} />
              ))}
            </div>
          </section>

          <GithubPane />

          <section className="operator-grid" aria-label="Operator features">
            <section className="panel scheduler-panel">
              <header className="panel-header">
                <div>
                  <span className="section-kicker">Operator Features</span>
                  <strong>Review / Fix Trigger</strong>
                </div>
                <span className="header-chip success">Review auto-start</span>
              </header>
              <div className="script-box">
                {schedulerLines.map((line) => (
                  <code key={line}>{line}</code>
                ))}
              </div>
              <div className="run-status">
                <span className="status-dot" />
                <strong>Running</strong>
                <span>Next: 2m 10s</span>
                <span>Stops in: 2h 2m</span>
              </div>
              <button>Stop trigger</button>
            </section>

            <section className="panel side-stack">
              <div className="stack-section">
                <header>
                  <span className="section-kicker">Agent Models</span>
                  <button>Configure</button>
                </header>
                <p>head: hermes · builder: claude-code · reviewer_a: codex · reviewer_b: codex</p>
              </div>
              <div className="stack-section">
                <header>
                  <span className="section-kicker">Run Signals</span>
                  <span className="running-label">Running</span>
                </header>
                <p>Local notifications · harness chat mirror · run summaries</p>
                <div className="button-row">
                  <button>Stop</button>
                  <button>Set up</button>
                </div>
              </div>
              <div className="stack-section">
                <header>
                  <span className="section-kicker">Loop Guard</span>
                  <button>Apply</button>
                </header>
                <label className="guard-row">
                  Pause after
                  <input defaultValue="30" aria-label="Loop guard hops" />
                  hops
                </label>
                <label className="checkbox-row">
                  <input type="checkbox" />
                  Auto-continue after pause
                </label>
              </div>
            </section>
          </section>
        </section>

        <footer className="command-bar">
          <span>Global command</span>
          <input placeholder="Hermes: spec issue #12, Claude: explain current plan, Codex A: review latest commit..." />
        </footer>
      </main>
    </div>
  );
}
