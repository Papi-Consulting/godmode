import fs from 'node:fs';
import path from 'node:path';
import type { BuilderHandoff, RunSnapshot } from '../shared/types.js';
import { DEFAULT_TEMPLATES, buildRoleResolutions, renderTemplate } from './agents.js';
import { DEFAULT_CONFIG, loadConfig, type GodmodeConfig } from './config.js';
import { getSelectedProjectRoot } from './project.js';

/**
 * Builder handoff composition (issue #8). This binds a selected GitHub issue or
 * manual task into the exact prompt GodMode would write into the configured
 * builder session, grounded in the harness reading rules. Producing a handoff
 * never sends anything — it is the auditable artifact the operator reviews
 * before the explicit approve-send gate (wired in `src/main/index.ts`).
 *
 * The sent prompt is deliberately **pointer-first**: GodMode is an agent
 * harness, not a prompt-injection layer, so the builder is directed to read the
 * operated project's canonical sources itself (AGENTS.md, docs/spec.md,
 * architecture/convention docs, and `gh issue view <N> --comments`) plus a
 * compact task capsule — rather than pasting the full issue body/comments into
 * the PTY. The full fetched detail stays on `run.sourceDetail` for the operator
 * preview/audit only (see `docs/architecture/builder-handoff.md`). Every source
 * is scoped to the **operated project** — the repo opened in GodMode and worked
 * on by agents, never the GodMode app repo (see app-vs-operated-project.md).
 *
 * The core ({@link composeBuilderHandoff}) is pure and Electron/PTY-free so it
 * can be unit-tested directly. {@link getCurrentHandoff} is the thin wrapper that
 * reads the loaded config, the current run, and the project's doc pointers.
 */

/** Manual task text is the only source for a manual task, so bound it for the PTY. */
const MAX_BODY_CHARS = 6000;

/** Top-level pointer dirs the builder should consult when relevant to the task. */
const POINTER_DIRS = ['docs/architecture', 'docs/conventions'] as const;

/** Concrete doc pointers per pointer dir, used to name relevant docs in the prompt. */
export type DocPointers = { architecture: string[]; conventions: string[] };

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}\n…[truncated ${trimmed.length - max} chars]`;
}

function deliveryFor(mode: string): BuilderHandoff['delivery'] {
  return mode === 'oneshot' ? 'oneshot' : 'interactive';
}

/** Single-line preview of a prompt, for the audit log. */
export function promptDigest(prompt: string, max = 140): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** A read-list bullet pointing at a project dir, naming concrete docs when known. */
function pointerLine(dir: string, docs: string[]): string {
  const examples = docs.length > 0 ? ` (e.g. ${docs.join(', ')})` : '';
  return `- relevant docs under ${dir}/${examples}`;
}

/**
 * The pointer-first required-reading + task-capsule block appended to every
 * handoff. It directs a FRESH builder to read the **operated project's** own
 * repo-local sources before implementing (AGENTS.md, docs/spec.md, the
 * architecture/convention docs, and `gh issue view <N> --comments`), then gives a
 * compact capsule of the bound issue/task — never the full issue body/comments.
 * The operated project is the repo opened in GodMode, not the GodMode app repo.
 */
function groundingBlock(run: RunSnapshot | null, projectName: string | undefined, pointers: DocPointers): string {
  const project = projectName ? `"${projectName}"` : '(unnamed)';
  const issueNumber = run?.sourceType === 'github_issue' ? run.issueNumber : undefined;

  const lines: string[] = [];
  lines.push('== Builder handoff (GodMode) ==');
  lines.push(
    `Start a FRESH builder session for the OPERATED PROJECT ${project} — the repo opened in ` +
      'GodMode and worked on by agents, NOT the GodMode app repo. Your working directory is ' +
      "that project's root. Read its repo-local sources yourself before implementing:",
  );
  lines.push('- AGENTS.md — process, authority, and safety rules');
  lines.push('- docs/spec.md — current product/technical spec');
  lines.push(pointerLine('docs/architecture', pointers.architecture));
  lines.push(pointerLine('docs/conventions', pointers.conventions));
  if (issueNumber !== undefined) {
    lines.push(`- gh issue view ${issueNumber} --comments — the issue body and discussion (in this repo)`);
  }
  lines.push('');

  // Compact task capsule: pointers to the source, not its full content. The
  // operator preview/audit keeps the full fetched body/comments separately.
  lines.push('Task capsule:');
  lines.push(`- Project: ${projectName ?? '(unnamed)'} (operated project)`);

  if (!run) {
    lines.push('- Source: none — mock/demo preview (select an issue or create a manual task)');
    lines.push('');
    lines.push('Implement only the selected issue in the operated project. Verify, commit, push, and open a PR linked to it.');
    return lines.join('\n');
  }

  const detail = run.sourceDetail ?? {};
  if (run.sourceType === 'github_issue') {
    lines.push(`- Issue #${run.issueNumber}: ${run.issueTitle ?? '(untitled)'}`);
    if (detail.url) lines.push(`- URL: ${detail.url}`);
    if (detail.labels && detail.labels.length > 0) lines.push(`- Labels: ${detail.labels.join(', ')}`);
    lines.push('');
    lines.push(
      `Implement only issue #${run.issueNumber} in the operated project. Verify, commit, push, and open a PR linked to issue #${run.issueNumber}.`,
    );
  } else {
    // A manual task has no GitHub issue to point at, so its text is the only
    // source of truth and is included (bounded). Manual tasks stay blocked from
    // direct send anyway, so this only grounds the operator preview/needs_spec.
    lines.push(`- Manual task ${run.sourceId}${run.issueTitle ? `: ${run.issueTitle}` : ''}`);
    lines.push('');
    lines.push('Task detail:');
    lines.push(detail.body ? truncate(detail.body, MAX_BODY_CHARS) : '(no task text provided)');
    lines.push('');
    lines.push('Implement only this task in the operated project. Verify, commit, push, and open a PR linked to it.');
  }

  return lines.join('\n');
}

/**
 * Compose the builder handoff for a run (or a mock when none is bound). Pure:
 * given a config, the run snapshot, and optional project metadata, it renders the
 * configured `builder_start` template bound to the run, appends the grounded
 * required-reading/task block, and reports whether the result is safe to send.
 *
 * A handoff is sendable only when a real source is bound (`!isMock`) and the
 * template left no unresolved variables. A `manual_task` run has no issue number,
 * so `{{issueNumber}}` stays unresolved and send is blocked — the operator routes
 * a vague task to `needs_spec` rather than sending it blindly.
 */
export function composeBuilderHandoff(
  config: GodmodeConfig,
  run: RunSnapshot | null,
  options: { projectName?: string; docPointers?: Partial<DocPointers> } = {},
): BuilderHandoff {
  const projectName = options.projectName;
  const docPointers: DocPointers = {
    architecture: options.docPointers?.architecture ?? [],
    conventions: options.docPointers?.conventions ?? [],
  };

  const builder = buildRoleResolutions(config).find((role) => role.role === 'builder');
  const agentId = builder?.agentId ?? config.roles.builder.agent;
  const agent = config.agents[agentId];
  const displayName = builder?.displayName ?? agentId;
  const adapter = builder?.adapter ?? agent.adapter;
  const mode = builder?.mode ?? agent.mode;
  const project = projectName ?? '<selected-project>';
  const commandLine = `${agent.command} --project ${project}`;

  const templates = { ...DEFAULT_TEMPLATES, ...config.commands };
  const vars: Record<string, string> = {};
  if (projectName) vars.projectName = projectName;
  if (run?.issueNumber !== undefined) vars.issueNumber = String(run.issueNumber);
  if (run?.issueTitle) vars.issueTitle = run.issueTitle;
  const { prompt: templatePrompt, missingVariables } = renderTemplate(templates.builder_start, vars);

  const prompt = `${templatePrompt}\n\n${groundingBlock(run, projectName, docPointers)}`;

  const isMock = run === null;
  // The source-type gate is authoritative, NOT just the absence of unbound
  // template tokens: a project can override `commands.builder_start` with a
  // template that omits `{{issueNumber}}` (e.g. "Build {{projectName}} now"),
  // which would otherwise leave `missingVariables` empty and let a manual task
  // become sendable. Only a bound GitHub issue is directly sendable; manual tasks
  // must route through `needs_spec` or be attached to a GitHub issue first.
  const isGithubIssue = run?.sourceType === 'github_issue';
  const canSend = isGithubIssue && missingVariables.length === 0;

  let blockedReason: string | undefined;
  if (isMock) {
    blockedReason = 'No issue or task is bound. Select a GitHub issue or create a manual task to build a real handoff.';
  } else if (!isGithubIssue) {
    blockedReason =
      'Manual tasks have no GitHub issue to bind. Route to needs_spec or attach a GitHub issue before sending.';
  } else if (missingVariables.length > 0) {
    blockedReason = `Unresolved template variables: ${missingVariables.join(', ')}.`;
  }

  const sourceLabel = !run
    ? undefined
    : run.sourceType === 'github_issue'
      ? `issue #${run.issueNumber} — ${run.issueTitle ?? '(untitled)'}`
      : `manual task ${run.sourceId}${run.issueTitle ? ` — ${run.issueTitle}` : ''}`;

  return {
    isMock,
    sourceType: run?.sourceType,
    sourceId: run?.sourceId,
    sourceLabel,
    issueUrl: run?.sourceDetail?.url,
    displayName,
    agentId,
    adapter,
    delivery: deliveryFor(mode),
    commandLine,
    prompt,
    missingVariables,
    canSend,
    blockedReason,
  };
}

/** Coordinates of the verified PR a fix cycle targets. */
export type FixPrTarget = { number: number; url: string; branch?: string };

/** Options for {@link composeFixHandoff}: the verified PR and normalized blockers. */
export type ComposeFixOptions = {
  projectName?: string;
  pr?: FixPrTarget;
  /** Normalized accepted-blocker text (from `renderBlockersText`), bound to `{{blockers}}`. */
  blockersText: string;
  /** Number of accepted blockers; a fix with zero blockers is not sendable. */
  blockerCount: number;
};

/**
 * The pointer-first grounding block for a fix handoff. Like the builder handoff,
 * it directs the builder to read the operated project's canonical sources and the
 * **live** PR/review artifacts itself — never a pasted reviewer transcript. The
 * accepted blockers travel as a compact normalized capsule (in the template body),
 * but the builder is pointed back to the live PR threads for the full reviewer
 * context (issue #11). Every source is scoped to the operated project.
 */
function fixGroundingBlock(
  run: RunSnapshot | null,
  projectName: string | undefined,
  pr: FixPrTarget | undefined,
): string {
  const project = projectName ? `"${projectName}"` : '(unnamed)';
  const issueNumber = run?.sourceType === 'github_issue' ? run.issueNumber : undefined;
  const lines: string[] = [];
  lines.push('== Builder fix handoff (GodMode) ==');
  lines.push(
    `Continue work on the OPERATED PROJECT ${project} — the repo opened in GodMode, NOT the GodMode ` +
      "app repo. Your working directory is that project's root. Read its canonical sources and the live " +
      'PR/review artifacts yourself before changing code:',
  );
  lines.push('- AGENTS.md — process, authority, and safety rules');
  lines.push('- docs/spec.md — current product/technical spec');
  if (pr) {
    lines.push(
      `- gh pr view ${pr.number} --json title,body,comments,reviews,statusCheckRollup — the live PR threads/checks`,
    );
    lines.push(`- gh pr diff ${pr.number} — the current code under review`);
  }
  if (issueNumber !== undefined) {
    lines.push(`- gh issue view ${issueNumber} --comments — the linked issue and its acceptance criteria`);
  }
  lines.push('');
  lines.push('Fix target:');
  if (pr) {
    lines.push(`- PR #${pr.number}: ${pr.url}`);
    if (pr.branch) lines.push(`- Branch: ${pr.branch}`);
  } else {
    lines.push('- No verified PR bound — open/link a PR before fixing.');
  }
  lines.push('');
  lines.push(
    'Address every accepted blocker listed above by reading the reviewer’s own PR comment for each, then ' +
      'commit and push to the PR branch. Do not resolve a blocker on assertion alone; verify the change.',
  );
  return lines.join('\n');
}

/**
 * Compose the builder **fix** handoff for a run (issue #11): render the
 * `builder_fix` template with the verified PR coordinates and the normalized
 * accepted-blocker text (so `{{blockers}}` is never left unresolved), then append
 * the pointer-first grounding block. Pure, mirroring {@link composeBuilderHandoff}.
 *
 * Sendable only when a real run + verified PR are bound, the template left no
 * unresolved variables, and at least one accepted blocker exists — there is
 * nothing to fix otherwise.
 */
export function composeFixHandoff(
  config: GodmodeConfig,
  run: RunSnapshot | null,
  options: ComposeFixOptions,
): BuilderHandoff {
  const { projectName, pr, blockersText, blockerCount } = options;

  const builder = buildRoleResolutions(config).find((role) => role.role === 'builder');
  const agentId = builder?.agentId ?? config.roles.builder.agent;
  const agent = config.agents[agentId];
  const displayName = builder?.displayName ?? agentId;
  const adapter = builder?.adapter ?? agent.adapter;
  const mode = builder?.mode ?? agent.mode;
  const project = projectName ?? '<selected-project>';
  const commandLine = `${agent.command} --project ${project}`;

  const templates = { ...DEFAULT_TEMPLATES, ...config.commands };
  const vars: Record<string, string> = { blockers: blockersText };
  if (projectName) vars.projectName = projectName;
  if (pr) {
    vars.prNumber = String(pr.number);
    vars.prUrl = pr.url;
    if (pr.branch) vars.branch = pr.branch;
  }
  if (run?.issueNumber !== undefined) vars.issueNumber = String(run.issueNumber);
  if (run?.issueTitle) vars.issueTitle = run.issueTitle;
  const { prompt: templatePrompt, missingVariables } = renderTemplate(templates.builder_fix, vars);

  const prompt = `${templatePrompt}\n\n${fixGroundingBlock(run, projectName, pr)}`;

  const isMock = run === null || pr === undefined;
  const hasBlockers = blockerCount > 0;
  const canSend = !isMock && missingVariables.length === 0 && hasBlockers;

  let blockedReason: string | undefined;
  if (isMock) {
    blockedReason = 'No verified PR is bound. Verify the PR (#9) before launching a fix cycle.';
  } else if (!hasBlockers) {
    blockedReason = 'No accepted blockers to fix.';
  } else if (missingVariables.length > 0) {
    blockedReason = `Unresolved template variables: ${missingVariables.join(', ')}.`;
  }

  const sourceLabel = !run
    ? undefined
    : run.sourceType === 'github_issue'
      ? `issue #${run.issueNumber} — ${run.issueTitle ?? '(untitled)'}`
      : `manual task ${run.sourceId}${run.issueTitle ? ` — ${run.issueTitle}` : ''}`;

  return {
    isMock,
    sourceType: run?.sourceType,
    sourceId: run?.sourceId,
    sourceLabel,
    issueUrl: run?.sourceDetail?.url,
    displayName,
    agentId,
    adapter,
    delivery: deliveryFor(mode),
    commandLine,
    prompt,
    missingVariables,
    canSend,
    blockedReason,
  };
}

/** List the `.md` doc filenames under one project-relative dir (bounded, best-effort). */
function listDocs(projectRoot: string, dir: string): string[] {
  const docs: string[] = [];
  try {
    const entries = fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md') {
        docs.push(`${dir}/${entry.name}`);
      }
    }
  } catch {
    // Dir absent/unreadable — pointers stay best-effort.
  }
  return docs.sort().slice(0, 6);
}

/**
 * Read the operated project's top-level architecture/convention doc filenames,
 * grouped per dir, so the handoff can name concrete pointers the builder should
 * read. Best-effort and bounded; returns empty groups when the dirs are
 * absent/unreadable.
 */
export function collectDocPointers(projectRoot: string): DocPointers {
  return {
    architecture: listDocs(projectRoot, POINTER_DIRS[0]),
    conventions: listDocs(projectRoot, POINTER_DIRS[1]),
  };
}

/**
 * Build the handoff for the current run, reading the loaded config and operated
 * project doc pointers. Never throws: a missing/invalid config falls back to safe
 * defaults, exactly like the registry.
 */
export function getCurrentHandoff(run: RunSnapshot | null): BuilderHandoff {
  const loaded = loadConfig();
  const config = loaded.status === 'loaded' ? loaded.config : DEFAULT_CONFIG;
  const docPointers = collectDocPointers(getSelectedProjectRoot());
  return composeBuilderHandoff(config, run, { projectName: loaded.projectName, docPointers });
}
