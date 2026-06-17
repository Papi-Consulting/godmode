import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuilderHandoff, BuilderRecoveryState, RunSnapshot } from '../../shared/types.js';

type HandoffPaneProps = {
  run: RunSnapshot | null;
  /** True when a live run holds the slot, so a new manual task cannot be started. */
  selectionLocked: boolean;
  /** Start a manual_task run from operator-entered text. */
  onCreateManualTask: (title: string, text: string) => void;
  /** Approve and send the handoff into the configured builder session. */
  onSend: () => void;
  /** Most recent send rejection, surfaced inline. */
  sendError: string | null;
  /**
   * Stale builder-session state for a builder_running run (issue #55), or null. A
   * sent-but-stale handoff is labeled distinctly (and points at Run Control for
   * recovery) instead of the old generic `blocked`.
   */
  builderRecovery: BuilderRecoveryState | null;
};

/**
 * Operator review + approve-send gate for the builder handoff (issue #8). Shows
 * the exact prompt GodMode would write into the configured builder session,
 * bound to the selected issue or manual task and grounded in the harness reading
 * rules. Nothing is sent by viewing it — the explicit "Approve & send" button is
 * the manual gate, and it stays disabled while the handoff is mock or has
 * unresolved variables. When no source is bound the preview is clearly labeled
 * mock/demo and a manual task can be entered instead.
 */
export function HandoffPane({
  run,
  selectionLocked,
  onCreateManualTask,
  onSend,
  sendError,
  builderRecovery,
}: HandoffPaneProps) {
  const [handoff, setHandoff] = useState<BuilderHandoff | null>(null);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!window.godmode) return;
    const seq = (requestSeq.current += 1);
    const next = await window.godmode.getHandoff();
    if (seq !== requestSeq.current) return;
    if (next) setHandoff(next);
  }, []);

  // The handoff is derived from the current run + config in the main process, so
  // refetch whenever the run identity/status/prompt-log changes or the operated
  // project changes (config/pointers are project-local).
  useEffect(() => {
    void refresh();
    const off = window.godmode?.onProjectChanged(() => {
      requestSeq.current += 1;
      void refresh();
    });
    return () => {
      off?.();
    };
  }, [refresh, run?.id, run?.status, run?.prompts.length, run?.sourceDetail]);

  const submitManualTask = () => {
    const trimmedTitle = title.trim();
    const trimmedText = text.trim();
    if (!trimmedTitle || !trimmedText) return;
    onCreateManualTask(trimmedTitle, trimmedText);
    setTitle('');
    setText('');
  };

  // Mirror HANDOFF_START_STATUSES in src/main/index.ts: the statuses from which an
  // approved handoff can advance the run to builder_running. The main process is
  // authoritative and re-validates, but gating the button here avoids a confusing
  // re-send once the builder is already running.
  const inSendableState = run !== null && ['issue_selected', 'needs_spec', 'ready_to_build'].includes(run.status);
  const canSend = Boolean(handoff?.canSend) && inSendableState;
  const lastPrompt = run && run.prompts.length > 0 ? run.prompts[run.prompts.length - 1] : null;
  // The handoff was already sent once the run is builder_running. Rather than the
  // old generic `blocked`, say so — and when the live builder PTY is gone (issue
  // #55), point the operator at Run Control's recovery actions.
  const builderRunning = run !== null && run.status === 'builder_running';
  const builderStale = builderRunning && (builderRecovery?.stale ?? false);
  // Chip label/tone: a stale builder is a warning to act on; an active builder is
  // neutral-informational; otherwise fall back to the bound/blocked send gate.
  const chipTone = !handoff
    ? ''
    : handoff.isMock || builderStale
      ? 'warn'
      : builderRunning
        ? ''
        : canSend
          ? 'success'
          : 'warn';
  const chipLabel = !handoff
    ? 'loading…'
    : handoff.isMock
      ? 'mock · no source bound'
      : builderStale
        ? 'builder session lost · recover in Run Control'
        : builderRunning
          ? 'builder running'
          : canSend
            ? 'bound · review & send'
            : 'blocked';

  return (
    <section className="stack-section handoff-pane" aria-label="Builder handoff">
      <header>
        <span className="section-kicker">Builder Handoff</span>
        <span className={`header-chip ${chipTone}`}>{chipLabel}</span>
      </header>

      {handoff ? (
        <div className="handoff-body">
          <div className="handoff-meta">
            <span className="handoff-source" title={handoff.sourceLabel ?? undefined}>
              {handoff.sourceLabel ?? 'no issue or task bound (preview)'}
            </span>
            <span className="command-agent">{handoff.displayName}</span>
            <span className="command-tag">{handoff.adapter}</span>
            <span className="command-tag">{handoff.delivery}</span>
          </div>
          <code className="command-line">$ {handoff.commandLine}</code>
          <p className="handoff-sent-note">Pointer-first prompt sent to the builder (it reads the operated project's sources itself):</p>
          <pre className="command-prompt handoff-prompt">{handoff.prompt}</pre>

          {run?.sourceType === 'github_issue' && (run.sourceDetail?.body || (run.sourceDetail?.comments?.length ?? 0) > 0) ? (
            <details className="handoff-audit">
              <summary>Full issue context · fetched for audit, not sent</summary>
              {run.sourceDetail?.body ? <pre className="command-prompt handoff-prompt">{run.sourceDetail.body}</pre> : null}
              {run.sourceDetail?.comments && run.sourceDetail.comments.length > 0 ? (
                <ul className="handoff-audit-comments">
                  {run.sourceDetail.comments.map((comment, index) => (
                    <li key={`${comment.author}-${index}`}>
                      <span className="review-author">@{comment.author}</span>
                      <span className="review-body">{comment.body}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </details>
          ) : null}

          {handoff.missingVariables.length > 0 ? (
            <div className="command-missing" aria-label="Unbound template variables">
              <span>unbound</span>
              {handoff.missingVariables.map((name) => (
                <span className="missing-var" key={name}>
                  {name}
                </span>
              ))}
            </div>
          ) : null}

          {builderStale ? (
            <p className="handoff-blocked warn" role="status">
              {builderRecovery?.message ?? 'Builder session is no longer live.'} Use Run Control to relaunch the
              builder and re-deliver this handoff, or mark the agent failed.
            </p>
          ) : !canSend && !builderRunning && handoff.blockedReason ? (
            <p className="handoff-blocked" role="status">
              {handoff.blockedReason}
            </p>
          ) : null}

          {sendError ? (
            <p className="run-error" role="alert">
              {sendError}
            </p>
          ) : null}

          <div className="handoff-actions">
            <button
              className="primary-action"
              disabled={!canSend}
              title={
                canSend
                  ? 'Write the approved prompt into the live builder session'
                  : handoff.canSend && !inSendableState
                    ? 'The handoff has already been sent for this run.'
                    : (handoff.blockedReason ?? 'Handoff is not ready to send')
              }
              onClick={onSend}
            >
              Approve &amp; send to builder
            </button>
          </div>

          {lastPrompt ? (
            <p className="handoff-sent" role="status">
              <span className="section-kicker">Last prompt sent</span>
              {new Date(lastPrompt.at).toLocaleTimeString()} · {lastPrompt.role} · {lastPrompt.promptChars} chars
              <span className="handoff-digest">{lastPrompt.digest}</span>
            </p>
          ) : null}

          {!selectionLocked ? (
            <form
              className="manual-task-form"
              aria-label="Manual task"
              onSubmit={(event) => {
                event.preventDefault();
                submitManualTask();
              }}
            >
              <span className="section-kicker">Manual task</span>
              <input
                aria-label="Manual task title"
                placeholder="Task title"
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.target.value)}
              />
              <textarea
                aria-label="Manual task description"
                placeholder="Describe the task. Vague tasks should be routed to needs_spec, not sent blindly."
                value={text}
                maxLength={20_000}
                rows={3}
                onChange={(event) => setText(event.target.value)}
              />
              <button type="submit" disabled={!title.trim() || !text.trim()}>
                Create manual task
              </button>
            </form>
          ) : (
            <p className="run-hint">Finish, cancel, or clear the active run to enter a manual task.</p>
          )}
        </div>
      ) : (
        <p className="empty-line">Loading builder handoff…</p>
      )}
    </section>
  );
}
