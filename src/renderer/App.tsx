import { useEffect, useState } from 'react';
import type { AppRepoState, AgentRole, ProjectConfigState, RolePaneConfig } from '../shared/types.js';
import { AgentPane } from './components/AgentPane.js';
import { CommandPreviewPane } from './components/CommandPreviewPane.js';
import { GithubPane } from './components/GithubPane.js';
import { ProjectBar } from './components/ProjectBar.js';

// UI-only presentation hints keyed by generic pane id. Kept in the renderer so
// config stays focused on roles/agents, not styling.
const ACCENT_BY_PANE: Record<AgentRole, string> = {
  head: 'blue',
  builder: 'cyan',
  reviewer_a: 'violet',
  reviewer_b: 'amber',
};

const PHASE_BY_PANE: Record<AgentRole, string> = {
  head: 'orchestrating',
  builder: 'ready',
  reviewer_a: 'watching',
  reviewer_b: 'watching',
};

const chatEvents = [
  {
    time: '19:42',
    from: 'karan',
    to: '@head',
    body: 'Draft a UI issue after we see the Hermes cockpit direction for GodMode.',
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

export function App() {
  const [config, setConfig] = useState<ProjectConfigState | null>(null);
  const [appRepo, setAppRepo] = useState<AppRepoState | null>(null);

  useEffect(() => {
    let active = true;
    void window.godmode?.getApp().then((state) => {
      if (active && state) setAppRepo(state);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const load = () =>
      void window.godmode?.getConfig().then((next) => {
        if (active && next) setConfig(next);
      });
    load();
    const off = window.godmode?.onProjectChanged(() => load());
    return () => {
      active = false;
      off?.();
    };
  }, []);

  const rolePanes: RolePaneConfig[] = config?.panes ?? [];
  const panes = rolePanes.map((pane) => ({
    id: pane.paneId,
    role: pane.roleLabel,
    agent: pane.displayName,
    commandHint: pane.commandHint,
    roleDoc: pane.roleDoc,
    phase: PHASE_BY_PANE[pane.paneId] ?? 'idle',
    accent: ACCENT_BY_PANE[pane.paneId] ?? 'blue',
  }));
  const bindingSummary = rolePanes.map((pane) => `${pane.paneId}: ${pane.agentId}`).join(' · ');

  return (
    <div className="app-frame">
      <aside className="rail" aria-label="Project switcher">
        <div className="rail-mark">GM</div>
        <button className="rail-button" aria-label="Dashboard">
          D
        </button>
        <button className="rail-button active" aria-label="Agent workspace">
          A
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
          <div className="brand-lockup" title={appRepo ? `GodMode app repo · ${appRepo.root}` : undefined}>
            <strong>GodMode{appRepo ? ` v${appRepo.version}` : ''}</strong>
            <span>{appRepo ? 'app repo · operates an external project' : 'Hermes command cockpit'}</span>
          </div>
          <div className="top-metrics" aria-label="Run telemetry">
            <span>Today <strong>0.8h</strong></span>
            <span>Cycle <strong>1/3</strong></span>
            <span>Gate <strong>manual</strong></span>
          </div>
        </header>

        <ProjectBar />

        <section className="dashboard-grid" aria-label="GodMode agent workspace">
          <section className="panel chat-panel">
            <header className="panel-header">
              <div>
                <span className="section-kicker">Harness Chat</span>
                <strong>Team Control</strong>
              </div>
              <span className="header-chip">operator draft</span>
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
              {config ? (
                <span className={`header-chip ${config.status === 'loaded' ? 'success' : ''}`}>
                  {config.source === 'config' ? 'config loaded' : `${config.status} · defaults`}
                </span>
              ) : null}
            </header>
            {config?.error ? (
              <p className="config-error" role="alert">
                {config.error}
              </p>
            ) : null}
            <div className="terminal-grid">
              {panes.map((pane) => (
                <AgentPane key={pane.id} {...pane} />
              ))}
            </div>
          </section>

          <GithubPane />

          <section className="operator-grid" aria-label="Operator features">
            <CommandPreviewPane />

            <section className="panel side-stack">
              <div className="stack-section">
                <header>
                  <span className="section-kicker">Agent Models</span>
                  <button>Configure</button>
                </header>
                <p>{bindingSummary ? `bindings · ${bindingSummary}` : 'no role bindings loaded'}</p>
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
