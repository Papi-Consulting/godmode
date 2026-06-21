import type {
  BuilderHandoff,
  MergeRecommendation,
  ReviewerFinding,
  ReviewerGateState,
  ReviewerHeadEvidence,
  ReviewerResultStatus,
  RunSnapshot,
} from '../../shared/types.js';

/** Run statuses from which a review synthesis can be triggered. */
const SYNTHESIZE_RUN_STATUSES = ['reviewers_running', 'reviewers_rerunning'];

/** Human labels for the merge recommendation. */
const RECOMMENDATION_LABEL: Record<MergeRecommendation, string> = {
  merge_ready: 'Merge ready',
  request_fix: 'Fix required',
  needs_human: 'Needs human',
  hold: 'On hold',
};

// Green is reserved for the verified merge-ready gate only (AGENTS.md / PR #12);
// blocking/needs-human read amber, never green.
function recommendationTone(recommendation: MergeRecommendation): string {
  if (recommendation === 'merge_ready') return 'success';
  if (recommendation === 'request_fix' || recommendation === 'needs_human') return 'warn';
  return '';
}

const REVIEWER_STATUS_LABEL: Record<ReviewerResultStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  ambiguous: 'Ambiguous',
};

function reviewerTone(status: ReviewerResultStatus): string {
  if (status === 'fail' || status === 'ambiguous') return 'warn';
  return '';
}

/**
 * One reviewer's merge-gate row. With issue #59 the row also surfaces the attempt
 * head the reviewer evaluated and labels it **stale** when that attempt did not
 * target the current PR head — so an old attempt is never read as current.
 */
function gateRow(label: string, gate: ReviewerGateState | null, head: ReviewerHeadEvidence | undefined) {
  const stale = head !== undefined && !(head.current && head.completed);
  const attemptMeta =
    head?.attemptHeadShaShort !== undefined ? (
      <span className="reviewer-attempt-meta run-hint">
        attempt head {head.attemptHeadShaShort}
        {head.cycle !== undefined ? ` · cycle ${head.cycle}` : ''}
      </span>
    ) : null;
  if (!gate) {
    return (
      <div>
        <dt>{label}</dt>
        <dd>
          {stale ? <span className="header-chip warn">stale</span> : <span className="empty-line">no result</span>}
          {attemptMeta}
        </dd>
      </div>
    );
  }
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={`header-chip ${reviewerTone(gate.status)}`}>{REVIEWER_STATUS_LABEL[gate.status]}</span>
        {gate.acceptedBlockers > 0 ? <span className="run-action-name"> · {gate.acceptedBlockers} blocking</span> : null}
        {stale ? <span className="header-chip warn"> stale</span> : null}
        {attemptMeta}
      </dd>
    </div>
  );
}

function BlockerItem({ blocker }: { blocker: ReviewerFinding }) {
  const where = blocker.file ? `${blocker.file}${blocker.line !== undefined ? `:${blocker.line}` : ''}` : null;
  return (
    <li className="reviewer-row warn">
      <div className="reviewer-row-head">
        {blocker.marker ? <span className="command-tag">{blocker.marker}</span> : null}
        <span className="command-agent">{blocker.title}</span>
        <span className="command-tag">{blocker.reviewerId}</span>
      </div>
      {where ? (
        <code className="reviewer-artifact" title={where}>
          {where}
        </code>
      ) : null}
      {blocker.details ? <p className="run-hint">{blocker.details}</p> : null}
      {blocker.suggestedFix ? (
        <p className="run-hint">
          <span className="section-kicker">Suggested fix</span> {blocker.suggestedFix}
        </p>
      ) : null}
    </li>
  );
}

type ReviewSynthesisPaneProps = {
  run: RunSnapshot | null;
  /** Rendered fix handoff from the most recent synthesis, when a fix cycle opened. */
  fixHandoff: BuilderHandoff | null;
  synthesizing: boolean;
  sendingFix: boolean;
  /** Most recent synthesis/fix rejection, surfaced inline. */
  error: string | null;
  onSynthesize: () => void;
  onSendFix: () => void;
};

/**
 * Review synthesis + merge gate + fix cockpit (issue #11). Surfaces the parsed
 * reviewer pass/fail/ambiguous status, the normalized blockers, and the computed
 * merge gate — green only for the verified merge-ready state, amber for blocking /
 * needs-human. When a fix cycle opens, the pointer-first fix handoff (with
 * normalized blocker text) is previewed and can be sent into the builder session.
 */
export function ReviewSynthesisPane({
  run,
  fixHandoff,
  synthesizing,
  sendingFix,
  error,
  onSynthesize,
  onSendFix,
}: ReviewSynthesisPaneProps) {
  const findings = run?.findings ?? null;
  const merge = findings?.merge ?? null;
  // Per-reviewer current-head evidence (issue #59), keyed by pane so each gate row
  // can show its attempt head and a stale label.
  const headByPane = new Map<string, ReviewerHeadEvidence>(
    (findings?.reviewerHeads ?? merge?.reviewerHeads ?? []).map((head) => [head.paneId, head]),
  );
  const canSynthesize = run !== null && SYNTHESIZE_RUN_STATUSES.includes(run.status);
  const inFixCycle = run?.status === 'builder_fixing';
  const blockers = findings?.acceptedBlockers ?? [];
  // The send is driven by the run's persisted blockers + PR, not the transient
  // fixHandoff preview — so it survives a reload that dropped the preview state.
  const canSendFix = inFixCycle && blockers.length > 0 && run?.prNumber !== undefined;

  const headerChip = !run
    ? { text: 'no run', tone: '' }
    : merge
      ? { text: RECOMMENDATION_LABEL[merge.recommendation], tone: recommendationTone(merge.recommendation) }
      : { text: 'not synthesized', tone: '' };

  return (
    <section className="stack-section review-synthesis-pane" aria-label="Review synthesis">
      <header>
        <span className="section-kicker">Review Synthesis</span>
        <span className={`header-chip ${headerChip.tone}`}>{headerChip.text}</span>
      </header>

      {!findings ? (
        <p className="run-hint">
          {run
            ? 'Parse the reviewer sessions into normalized findings and compute the merge gate. GodMode re-runs the #9 verification — a reviewer self-report alone is never enough to mark merge-ready.'
            : 'No active run. Launch reviewers on a verified PR, then synthesize their findings here.'}
        </p>
      ) : (
        <>
          <dl className="run-state-grid" aria-label="Merge gate">
            {gateRow('Reviewer A', merge?.reviewerA ?? null, headByPane.get('reviewer_a'))}
            {gateRow('Reviewer B', merge?.reviewerB ?? null, headByPane.get('reviewer_b'))}
            <div>
              <dt>PR verified</dt>
              <dd>
                <span className={`header-chip ${merge?.prVerified ? 'success' : 'warn'}`}>
                  {merge?.prVerified ? 'verified' : 'not verified'}
                </span>
              </dd>
            </div>
            {/* The PR head this synthesis was computed against (issue #59): the
                gate consumed only reviewer attempts targeting this head. */}
            <div>
              <dt>PR head</dt>
              <dd>{findings.prHeadShaShort ?? merge?.prHeadShaShort ?? '—'}</dd>
            </div>
            <div>
              <dt>Cycle</dt>
              <dd>
                {findings.cycle}/{run?.maxCycles ?? '—'}
              </dd>
            </div>
          </dl>

          {merge && merge.reasons.length > 0 ? (
            <ul className="merge-reasons" aria-label="Merge gate reasons">
              {merge.reasons.map((reason, index) => (
                <li key={index} className="run-hint">
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}

          {blockers.length > 0 ? (
            <ul className="reviewer-list" aria-label="Accepted blockers">
              {blockers.map((blocker, index) => (
                <BlockerItem key={`${blocker.reviewerId}-${blocker.marker ?? index}`} blocker={blocker} />
              ))}
            </ul>
          ) : null}
        </>
      )}

      {inFixCycle && fixHandoff ? (
        <div className="fix-handoff" aria-label="Fix handoff">
          <span className="section-kicker">Builder fix handoff</span>
          <p className="run-hint">{fixHandoff.canSend ? 'Ready to send to the builder.' : fixHandoff.blockedReason}</p>
        </div>
      ) : null}

      {error ? (
        <p className="run-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="verify-footer">
        <span className="verify-meta">
          {findings ? 'self-reports are advisory · merge requires verified evidence' : ''}
        </span>
        {inFixCycle ? (
          <button
            className="primary-action"
            onClick={onSendFix}
            disabled={sendingFix || !canSendFix}
            title="Send the fix handoff into the builder session"
          >
            {sendingFix ? 'Sending…' : 'Send fix to builder'}
          </button>
        ) : (
          <button
            className="primary-action"
            onClick={onSynthesize}
            disabled={!canSynthesize || synthesizing}
            title={
              canSynthesize
                ? 'Verify the PR (#9) and synthesize the reviewer findings'
                : 'Synthesis runs from a reviewers-running run.'
            }
          >
            {synthesizing ? 'Synthesizing…' : 'Synthesize reviews'}
          </button>
        )}
      </div>
    </section>
  );
}
