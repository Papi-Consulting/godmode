import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppRepoState,
  AgentRole,
  ProjectConfigState,
  RolePaneConfig,
  RunAction,
  RunSnapshot,
  RunStatus,
} from '../shared/types.js';
import { AgentPane } from './components/AgentPane.js';
import { CommandPreviewPane } from './components/CommandPreviewPane.js';
import { GithubPane } from './components/GithubPane.js';
import { ProjectBar } from './components/ProjectBar.js';
import { RunControlPane, STATUS_LABEL, type RunDispatchOptions } from './components/RunControlPane.js';

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

// A run in one of these is finished and may be replaced by selecting a new
// issue; any other (live) run locks issue selection until it is cleared/closed.
// Mirrors TERMINAL_STATUSES in src/main/run.ts, which is the authoritative guard.
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>(['closed', 'cancelled', 'karan_merged']);

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
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  // Monotonic id for the latest run request. Like the GitHub pane, a run fetch
  // snapshots state in main at invocation time, so a late `getRun()` for the
  // previous operated project must never repopulate stale run state. Mutations
  // bump it too, so the most recently initiated run operation always wins.
  const runRequestSeq = useRef(0);

  const refreshRun = useCallback(async () => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const next = await window.godmode.getRun();
    if (seq !== runRequestSeq.current) return;
    setRun(next ?? null);
  }, []);

  // Start a run for an issue selected from the GitHub pane. The main process is
  // authoritative: it returns the resulting snapshot (or a typed rejection, e.g.
  // when a still-live run would be replaced).
  const selectIssue = useCallback(async (issueNumber: number, issueTitle?: string) => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.selectIssueRun({ issueNumber, issueTitle });
    if (seq !== runRequestSeq.current) return;
    setRun(result.run);
    setRunError(result.ok ? null : result.error);
  }, []);

  // Drive a transition. The guard lives in main, so a rejected action leaves
  // state unchanged and we surface why instead of inventing a transition here.
  const dispatchRun = useCallback(async (action: RunAction, options?: RunDispatchOptions) => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.dispatchRun({ action, ...options });
    if (seq !== runRequestSeq.current) return;
    setRun(result.run);
    setRunError(result.ok ? null : result.error);
  }, []);

  const clearRun = useCallback(async () => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const next = await window.godmode.clearRun();
    if (seq !== runRequestSeq.current) return;
    setRun(next ?? null);
    setRunError(null);
  }, []);

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
    void refreshRun();
    // A run is scoped to its operated project; main discards it on project
    // change. Invalidate any in-flight fetch and clear the stale snapshot
    // immediately so the previous project's run never lingers, then re-fetch.
    const off = window.godmode?.onProjectChanged(() => {
      runRequestSeq.current += 1;
      setRun(null);
      setRunError(null);
      void refreshRun();
    });
    return () => {
      off?.();
    };
  }, [refreshRun]);

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
            <span>
              Phase <strong>{run ? STATUS_LABEL[run.status] : 'no run'}</strong>
            </span>
            <span>
              Cycle <strong>{run ? `${run.cycle}/${run.maxCycles}` : '—'}</strong>
            </span>
            <span>
              Gate <strong>{run?.prNumber !== undefined ? `PR #${run.prNumber}` : 'manual'}</strong>
            </span>
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

          <GithubPane
            activeIssueNumber={run?.issueNumber ?? null}
            selectionLocked={run !== null && !TERMINAL_RUN_STATUSES.has(run.status)}
            onSelectIssue={selectIssue}
          />

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
              <RunControlPane run={run} error={runError} onDispatch={dispatchRun} onClear={clearRun} />
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
