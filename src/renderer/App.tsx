import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AppRepoState,
  AgentRole,
  BuilderHandoff,
  BuilderRecoveryState,
  CommitVerification,
  LoopMode,
  LoopState,
  ManagedWorktree,
  PrCandidate,
  PrDiscoveryResult,
  ProjectConfigState,
  ProjectState,
  RolePaneConfig,
  RunAction,
  RunResumeState,
  RunSnapshot,
  RunStatus,
  WorkspaceIsolation,
} from '../shared/types.js';
import { AgentPane } from './components/AgentPane.js';
import { CommandPreviewPane } from './components/CommandPreviewPane.js';
import { GithubPane } from './components/GithubPane.js';
import { HandoffPane } from './components/HandoffPane.js';
import { ProjectBar } from './components/ProjectBar.js';
import { ReviewLaunchPane } from './components/ReviewLaunchPane.js';
import { ReviewSynthesisPane } from './components/ReviewSynthesisPane.js';
import { RunControlPane, STATUS_LABEL, type RunDispatchOptions } from './components/RunControlPane.js';
import { VerificationPane } from './components/VerificationPane.js';

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
  const [project, setProject] = useState<ProjectState | null>(null);
  const [worktrees, setWorktrees] = useState<ManagedWorktree[]>([]);
  const [worktreeMessage, setWorktreeMessage] = useState<string | null>(null);
  const [run, setRun] = useState<RunSnapshot | null>(null);
  const [loop, setLoop] = useState<LoopState | null>(null);
  const [resumeState, setResumeState] = useState<RunResumeState | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // Stale builder-session detection + recovery (issue #55). Main is authoritative:
  // it derives staleness from the run + the live builder PTY and pushes changes.
  const [builderRecovery, setBuilderRecovery] = useState<BuilderRecoveryState | null>(null);
  const [relaunchingBuilder, setRelaunchingBuilder] = useState(false);
  const [verification, setVerification] = useState<CommitVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [discovery, setDiscovery] = useState<PrDiscoveryResult | null>(null);
  const [discoveryHint, setDiscoveryHint] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [startReviewersError, setStartReviewersError] = useState<string | null>(null);
  const [startingReviewers, setStartingReviewers] = useState(false);
  const [fixHandoff, setFixHandoff] = useState<BuilderHandoff | null>(null);
  const [synthesizing, setSynthesizing] = useState(false);
  const [sendingFix, setSendingFix] = useState(false);
  const [synthError, setSynthError] = useState<string | null>(null);
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

  // The loop controller's state is owned by main; fetch it and keep it fresh via
  // the onLoopChanged push (issue #39). Display-only — the run state machine
  // remains the single transition authority.
  const refreshLoop = useCallback(async () => {
    if (!window.godmode?.getLoop) return;
    const next = await window.godmode.getLoop();
    setLoop(next ?? null);
  }, []);

  // Fetch the persisted-run resume surface for the selected project (issue #40).
  // Main keeps the offer mutually exclusive with an active run, so this drives the
  // Resume/Discard prompt and the storage-degraded banner.
  const refreshResume = useCallback(async () => {
    if (!window.godmode?.getResumeState) return;
    const next = await window.godmode.getResumeState();
    setResumeState(next ?? null);
  }, []);

  // Resume the persisted unfinished run. Main restores it through the state machine
  // (dead sessions, recomputed actions) and revalidates the PR; we adopt whatever
  // snapshot it returns as authoritative.
  const resumeRun = useCallback(async () => {
    if (!window.godmode?.resumeRun) return;
    setResumeBusy(true);
    try {
      const result = await window.godmode.resumeRun();
      if (result.ok) {
        setRun(result.run);
        setRunError(result.routedToNeedsHuman && result.note ? `Resumed and flagged for human: ${result.note}` : null);
      } else {
        setRunError(result.error);
      }
    } finally {
      setResumeBusy(false);
      void refreshResume();
    }
  }, [refreshResume]);

  // Discard (archive) the persisted unfinished run and start clean (issue #40).
  const discardRun = useCallback(async () => {
    if (!window.godmode?.discardRun) return;
    setResumeBusy(true);
    try {
      const result = await window.godmode.discardRun();
      setRun(null);
      setRunError(result.ok ? null : (result.error ?? 'Could not discard the persisted run.'));
    } finally {
      setResumeBusy(false);
      void refreshResume();
    }
  }, [refreshResume]);

  // Toggle the run's loop mode (manual/auto). Main is authoritative: it returns
  // the new loop state (or a typed rejection when there is no run).
  const setLoopMode = useCallback(async (mode: LoopMode) => {
    if (!window.godmode?.setLoopMode) return;
    const result = await window.godmode.setLoopMode({ mode });
    if (result.ok) setLoop(result.loop);
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

  // Start a run from an operator-entered manual task. Vague tasks have no issue
  // number to bind, so the resulting handoff is not directly sendable — the
  // operator routes them to needs_spec instead of sending blindly.
  const createManualTask = useCallback(async (title: string, text: string) => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.selectManualTask({ title, text });
    if (seq !== runRequestSeq.current) return;
    setRun(result.run);
    setRunError(result.ok ? null : result.error);
    setSendError(null);
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

  // Approve and send the builder handoff. Main validates sendability, confirms a
  // live builder session, writes the prompt into it, logs the prompt-sent event,
  // and advances the run to builder_running — all atomically.
  const sendHandoff = useCallback(async () => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.sendHandoff();
    if (seq !== runRequestSeq.current) return;
    if (result.run) setRun(result.run);
    setSendError(result.ok ? null : result.error);
  }, []);

  const clearRun = useCallback(async () => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.clearRun();
    if (seq !== runRequestSeq.current) return;
    // Clear is a guarded terminal-only operation (issue #41): a refusal preserves
    // the run record and explains the lifecycle step to take first (cancel/close,
    // then clean up the worktree). Only a successful clear resets run-derived state.
    if (!result.ok) {
      setRun(result.run);
      setRunError(result.error);
      return;
    }
    setRun(null);
    setRunError(null);
    setSendError(null);
    setVerification(null);
    setFixHandoff(null);
    setSynthError(null);
    setDiscovery(null);
    setDiscoveryHint(null);
  }, []);

  // Fetch the builder-recovery state (issue #55): whether a builder_running run has
  // lost its live builder PTY. Main keeps it fresh via onBuilderRecoveryChanged.
  const refreshBuilderRecovery = useCallback(async () => {
    if (!window.godmode?.getBuilderRecovery) return;
    const next = await window.godmode.getBuilderRecovery();
    setBuilderRecovery(next ?? null);
  }, []);

  // Recover a stale builder: main relaunches the builder PTY in the run's worktree
  // (cwd-gated) and re-delivers the existing pointer-first handoff, recording the
  // re-send for audit. Explicit operator action — never auto-relaunched (issue #55).
  const relaunchBuilder = useCallback(async () => {
    if (!window.godmode?.relaunchBuilder) return;
    setRelaunchingBuilder(true);
    const seq = (runRequestSeq.current += 1);
    try {
      const result = await window.godmode.relaunchBuilder();
      if (seq !== runRequestSeq.current) return;
      if (result.run) setRun(result.run);
      setSendError(result.ok ? null : result.error);
    } finally {
      setRelaunchingBuilder(false);
      void refreshBuilderRecovery();
    }
  }, [refreshBuilderRecovery]);

  // Refresh the operated project's GodMode-managed worktrees (for orphan cleanup).
  const refreshWorktrees = useCallback(async () => {
    if (!window.godmode) return;
    const list = await window.godmode.listWorktrees();
    setWorktrees(list ?? []);
  }, []);

  // Flip the run's workspace isolation (the dogfooding nudge's one-click enable).
  const setIsolation = useCallback(async (isolation: WorkspaceIsolation) => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.setRunIsolation({ isolation });
    if (seq !== runRequestSeq.current) return;
    if (result.run) setRun(result.run);
    setWorktreeMessage(result.ok ? null : result.error);
  }, []);

  // Remove a managed worktree (current-run or orphaned). Main refuses dirty/unpushed
  // trees and the active run's worktree until the run is terminal, with a reason.
  const cleanupWorktree = useCallback(
    async (worktreePath: string) => {
      if (!window.godmode) return;
      const result = await window.godmode.cleanupWorktree({ path: worktreePath });
      setWorktreeMessage(result.ok ? `Removed worktree ${result.removedPath}.` : result.error);
      await refreshWorktrees();
      void refreshRun();
    },
    [refreshWorktrees, refreshRun],
  );

  // Run the branch/PR/commit verification evidence gate. Main reads live
  // `gh`/`git` state (never agent self-report), records the result on the current
  // run for audit, and returns the derived verification plus the updated run.
  const verifyCommit = useCallback(async () => {
    if (!window.godmode) return;
    setVerifying(true);
    const seq = (runRequestSeq.current += 1);
    try {
      const result = await window.godmode.verifyCommit();
      if (seq !== runRequestSeq.current) return;
      setVerification(result.verification);
      if (result.run) setRun(result.run);
    } finally {
      setVerifying(false);
    }
  }, []);

  // Run a read-only "Check for PR" discovery pass for a builder_running run
  // (issue #38). Main lists open PRs scoped to the operated project and classifies
  // candidates by issue link / recent-unlinked fallback; the result is non-fatal
  // (a gh error just shows a message and leaves the run in builder_running).
  const discoverPr = useCallback(async () => {
    if (!window.godmode?.discoverPr) return;
    setDiscovering(true);
    try {
      const result = await window.godmode.discoverPr();
      setDiscovery(result);
      setDiscoveryHint(null);
    } finally {
      setDiscovering(false);
    }
  }, []);

  // Confirm a discovered candidate: main binds its branch/number/head commit
  // through the open_pr guard and immediately runs the #9 verification, returning
  // both so the run advances to pr_opened and the verification pane updates at once.
  const confirmPrCandidate = useCallback(async (candidate: PrCandidate) => {
    if (!window.godmode?.confirmPrCandidate) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.confirmPrCandidate({
      prNumber: candidate.number,
      branch: candidate.headRefName,
      expectedCommit: candidate.headSha,
      matchReason: candidate.matchReason,
    });
    if (seq !== runRequestSeq.current) return;
    if (result.run) setRun(result.run);
    if (result.ok) {
      setVerification(result.verification);
      setDiscovery(null);
      setDiscoveryHint(null);
      setRunError(null);
    } else {
      setRunError(result.error);
    }
  }, []);

  // Launch Reviewer A/B from the verified PR. Main re-runs the #9 verification
  // gate and returns the updated snapshot (or a typed rejection, e.g. not_verified),
  // so a refused launch surfaces why and leaves run state unchanged.
  const startReviewers = useCallback(async () => {
    if (!window.godmode) return;
    setStartingReviewers(true);
    const seq = (runRequestSeq.current += 1);
    try {
      const result = await window.godmode.startReviewers();
      if (seq !== runRequestSeq.current) return;
      if (result.run) setRun(result.run);
      setStartReviewersError(result.ok ? null : result.error);
    } finally {
      setStartingReviewers(false);
    }
  }, []);

  // Operator override / re-post for one reviewer's marker comment.
  const postReviewerComment = useCallback(async (paneId: 'reviewer_a' | 'reviewer_b') => {
    if (!window.godmode) return;
    const seq = (runRequestSeq.current += 1);
    const result = await window.godmode.postReviewerComment({ paneId });
    if (seq !== runRequestSeq.current) return;
    if (result.run) setRun(result.run);
    setStartReviewersError(result.ok ? null : result.error);
  }, []);

  // Synthesize reviewer findings into the merge gate and drive the first fix
  // cycle. Main re-runs the #9 gate, parses each reviewer's captured output, and
  // routes the run (merge_ready / request_fix / needs_human / hold). A fix cycle
  // returns the rendered pointer-first fix handoff for operator review.
  const synthesizeReviews = useCallback(async () => {
    if (!window.godmode) return;
    setSynthesizing(true);
    const seq = (runRequestSeq.current += 1);
    try {
      const result = await window.godmode.synthesizeReviews();
      if (seq !== runRequestSeq.current) return;
      if (result.run) setRun(result.run);
      setFixHandoff(result.ok ? result.fixHandoff ?? null : null);
      setSynthError(result.ok ? null : result.error);
    } finally {
      setSynthesizing(false);
    }
  }, []);

  // Send the rendered fix handoff into the builder session. Main does no live gh
  // round trip — it gates on the recorded verified merge findings (prVerified +
  // bound PR URL), recomposes the fix prompt from the run's accepted blockers, and
  // writes it in.
  const sendFix = useCallback(async () => {
    if (!window.godmode) return;
    setSendingFix(true);
    const seq = (runRequestSeq.current += 1);
    try {
      const result = await window.godmode.sendFix();
      if (seq !== runRequestSeq.current) return;
      if (result.run) setRun(result.run);
      setSynthError(result.ok ? null : result.error);
    } finally {
      setSendingFix(false);
    }
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

  // Track the operated project (for the dogfooding `isAppRepo` nudge) and its
  // managed worktrees (orphan cleanup), refreshing both when the project changes.
  useEffect(() => {
    let active = true;
    const load = () => {
      void window.godmode?.getProject().then((state) => {
        if (active && state) setProject(state);
      });
      void refreshWorktrees();
    };
    load();
    const off = window.godmode?.onProjectChanged((state) => {
      if (active && state) setProject(state);
      setWorktreeMessage(null);
      load();
    });
    return () => {
      active = false;
      off?.();
    };
  }, [refreshWorktrees]);

  useEffect(() => {
    void refreshRun();
    void refreshLoop();
    void refreshResume();
    void refreshBuilderRecovery();
    // A run is scoped to its operated project; main discards it on project
    // change. Invalidate any in-flight fetch and clear the stale snapshot
    // immediately so the previous project's run never lingers, then re-fetch.
    const offProject = window.godmode?.onProjectChanged(() => {
      runRequestSeq.current += 1;
      setRun(null);
      setRunError(null);
      setSendError(null);
      // Verification is scoped to the operated project's branch/PR; drop the
      // stale result so the previous repo's evidence never lingers.
      setVerification(null);
      setStartReviewersError(null);
      setFixHandoff(null);
      setSynthError(null);
      // PR discovery is scoped to the operated project's builder_running run; drop
      // any stale candidate/hint so the previous repo's discovery never lingers.
      setDiscovery(null);
      setDiscoveryHint(null);
      // The resume offer is scoped to the operated project; clear and re-fetch so
      // the previous repo's persisted run never lingers (issue #40).
      setResumeState(null);
      // Builder-recovery is scoped to the project's active run; clear and refetch
      // so the previous repo's stale-session banner never lingers (issue #55).
      setBuilderRecovery(null);
      void refreshRun();
      void refreshLoop();
      void refreshResume();
      void refreshBuilderRecovery();
    });
    // Main pushes the run snapshot when async reviewer lifecycle changes (a
    // reviewer session exits, a marker comment posts/fails). Treat it as the
    // authoritative latest state and bump the seq so an older in-flight fetch
    // can't overwrite it.
    const offRun = window.godmode?.onRunChanged((next) => {
      runRequestSeq.current += 1;
      setRun(next ?? null);
      // Discovery only applies while builder_running; clear it once the run moves
      // on (e.g. a candidate was confirmed → pr_opened) so stale candidates don't
      // linger in the pane.
      if (!next || next.status !== 'builder_running') {
        setDiscovery(null);
        setDiscoveryHint(null);
      }
      // A run change may have created/cleared the run worktree — refresh the list.
      void refreshWorktrees();
      // A run starting/clearing flips whether a resume offer is shown (it is
      // mutually exclusive with an active run); re-fetch so it stays in sync (#40).
      void refreshResume();
      // The run's status drives builder-recovery staleness (e.g. leaving
      // builder_running clears it); re-fetch so the banner stays in sync (#55).
      void refreshBuilderRecovery();
    });
    // Main pushes the resume surface on project switch, save failure, and
    // resume/discard (issue #40). Treat it as authoritative.
    const offResume = window.godmode?.onResumeChanged((next) => {
      setResumeState(next ?? null);
    });
    // Main pushes a discovery pass it initiated itself (issue #38) — after the
    // builder PTY exits during builder_running — with a non-blocking hint. PTY exit
    // never transitions the run; this only surfaces candidates + the hint.
    const offPrDiscovered = window.godmode?.onPrDiscovered((payload) => {
      setDiscovery(payload.discovery);
      setDiscoveryHint(payload.hint ?? null);
    });
    // Main pushes the loop-controller state on every loop change (mode toggle,
    // waiting-on change, halt). Treat it as authoritative (issue #39).
    const offLoop = window.godmode?.onLoopChanged((next) => {
      setLoop(next ?? null);
    });
    // Main pushes builder-recovery state when the builder PTY starts/dies or a
    // builder_running run is resumed (issue #55). Treat it as authoritative.
    const offBuilderRecovery = window.godmode?.onBuilderRecoveryChanged((next) => {
      setBuilderRecovery(next ?? null);
    });
    return () => {
      offProject?.();
      offRun?.();
      offLoop?.();
      offPrDiscovered?.();
      offResume?.();
      offBuilderRecovery?.();
    };
  }, [refreshRun, refreshLoop, refreshWorktrees, refreshResume, refreshBuilderRecovery]);

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
    // The builder is the only isolated role: surface its run worktree in the header.
    worktreePath: pane.paneId === 'builder' ? run?.worktree?.path : undefined,
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
            {/* Harness team chat is not implemented (a persistent transcript/chat
                server is out of scope for #57). Keep the control visibly disabled
                rather than accepting text it cannot dispatch. To message a live
                agent today, use a role pane's "Message <role>" control. */}
            <div className="chat-input-row">
              <input
                aria-label="Chat message"
                placeholder="Team chat not yet wired — use a role pane's Message control"
                disabled
                title="Harness team chat is not implemented yet. Use a role pane's Message control to reach a live agent."
              />
              <button disabled>Send</button>
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
              <HandoffPane
                run={run}
                selectionLocked={run !== null && !TERMINAL_RUN_STATUSES.has(run.status)}
                onCreateManualTask={createManualTask}
                onSend={sendHandoff}
                sendError={sendError}
                builderRecovery={builderRecovery}
              />
              <RunControlPane
                run={run}
                error={runError}
                loop={loop}
                onSetLoopMode={setLoopMode}
                onDispatch={dispatchRun}
                onClear={clearRun}
                discovery={discovery}
                discoveryHint={discoveryHint}
                discovering={discovering}
                onDiscoverPr={discoverPr}
                onConfirmCandidate={confirmPrCandidate}
                isAppRepo={project?.isAppRepo ?? false}
                onSetIsolation={setIsolation}
                orphanWorktrees={worktrees}
                onCleanupWorktree={cleanupWorktree}
                worktreeMessage={worktreeMessage}
                resumeState={resumeState}
                onResume={resumeRun}
                onDiscard={discardRun}
                resumeBusy={resumeBusy}
                builderRecovery={builderRecovery}
                onRelaunchBuilder={relaunchBuilder}
                relaunchingBuilder={relaunchingBuilder}
              />
              <VerificationPane
                verification={verification}
                loading={verifying}
                hasRun={run !== null}
                onVerify={verifyCommit}
              />
              <ReviewLaunchPane
                run={run}
                startError={startReviewersError}
                starting={startingReviewers}
                onStart={startReviewers}
                onPostComment={postReviewerComment}
              />
              <ReviewSynthesisPane
                run={run}
                fixHandoff={fixHandoff}
                synthesizing={synthesizing}
                sendingFix={sendingFix}
                error={synthError}
                onSynthesize={synthesizeReviews}
                onSendFix={sendFix}
              />
            </section>
          </section>
        </section>

        {/* Global command routing (product spec 6.5) is not implemented: there is
            no designed rule mapping free text to a target role's live PTY. Rather
            than leave an enabled input that silently no-ops (issue #57), the bar is
            visibly disabled. Operators drive live agents through each role pane's
            "Message <role>" control, which delivers with a typed result today. */}
        <footer className="command-bar">
          <span>Global command</span>
          <input
            aria-label="Global command"
            placeholder="Global command routing not yet wired — use a role pane's Message control"
            disabled
            title="Global command routing is not implemented yet. Use a role pane's Message control to reach a live agent."
          />
          <span className="command-bar-note">not yet wired</span>
        </footer>
      </main>
    </div>
  );
}
