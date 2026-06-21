// Coverage for role-session launch wiring (issue #6): mapping a pane/role to its
// configured command (`resolveRoleLaunch`) and resolving that command's
// executable before spawning (`resolveExecutable`). Pure functions over a temp
// dir and PATH — no Electron, no actual PTY spawn. Run via `npm test` (builds
// the main process first).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveRoleLaunch } from '../dist/main/agents.js';
import {
  detectPromptAttention,
  getPaneSessionState,
  getPaneSessionStates,
  openPtySession,
  resolveExecutable,
  setPaneSessionListener,
  stopPtySession,
  writeToPtySessionResult,
} from '../dist/main/pty.js';
import { selectProject } from '../dist/main/project.js';

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-pty-'));
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  selectProject(root);
  return root;
}

const CLI_CONFIG = `
roles:
  head: { pane: head, agent: hermes, display_name: Hermes }
  builder: { pane: builder, agent: builder-cli, display_name: Builder }
  reviewers:
    - { id: reviewer-a, pane: reviewer_a, agent: codex, display_name: Codex A }
agents:
  hermes: { adapter: cli, command: hermes, mode: interactive }
  builder-cli: { adapter: cli, command: "node --version", mode: interactive }
  codex: { adapter: cli, command: codex, mode: oneshot }
`;

const MCP_BUILDER_CONFIG = `
roles:
  head: { pane: head, agent: hermes, display_name: Hermes }
  builder: { pane: builder, agent: mcp-builder, display_name: MCP }
  reviewers:
    - { id: reviewer-a, pane: reviewer_a, agent: codex, display_name: Codex A }
agents:
  hermes: { adapter: cli, command: hermes, mode: interactive }
  mcp-builder: { adapter: mcp, command: mcp-server, mode: oneshot }
  codex: { adapter: cli, command: codex, mode: oneshot }
`;

test('resolveRoleLaunch maps the builder pane to its configured command', () => {
  makeProject({ '.agentic/godmode.yaml': CLI_CONFIG });
  const launch = resolveRoleLaunch('builder');
  assert.equal(launch.ok, true);
  assert.equal(launch.spec.agentId, 'builder-cli');
  assert.equal(launch.spec.command, 'node --version');
  assert.equal(launch.spec.adapter, 'cli');
});

test('resolveRoleLaunch falls back to safe defaults with no config file', () => {
  makeProject();
  const launch = resolveRoleLaunch('builder');
  assert.equal(launch.ok, true);
  // DEFAULT_CONFIG binds builder -> claude-code (command "claude").
  assert.equal(launch.spec.command, 'claude');
});

test('resolveRoleLaunch rejects a non-cli adapter with a visible reason', () => {
  makeProject({ '.agentic/godmode.yaml': MCP_BUILDER_CONFIG });
  const launch = resolveRoleLaunch('builder');
  assert.equal(launch.ok, false);
  assert.match(launch.error, /mcp adapter, which is not launchable/);
});

test('resolveRoleLaunch reports an unconfigured reviewer pane', () => {
  // CLI_CONFIG configures only reviewer_a, so reviewer_b has no bound agent.
  makeProject({ '.agentic/godmode.yaml': CLI_CONFIG });
  const launch = resolveRoleLaunch('reviewer_b');
  assert.equal(launch.ok, false);
  assert.match(launch.error, /No agent is configured for the reviewer_b role/);
});

test('resolveExecutable finds a bare command on PATH', () => {
  const resolved = resolveExecutable('node', os.tmpdir(), { PATH: process.env.PATH ?? '' });
  assert.ok(resolved);
  assert.ok(path.isAbsolute(resolved));
  assert.equal(path.basename(resolved).startsWith('node'), true);
});

test('resolveExecutable returns null for a missing command', () => {
  const resolved = resolveExecutable('definitely-not-a-real-binary-xyz', os.tmpdir(), {
    PATH: process.env.PATH ?? '',
  });
  assert.equal(resolved, null);
});

// --- Typed PTY delivery result (issue #57) -------------------------------------
// Role message / global command controls must deliver to a live PTY with visible
// evidence, or report why nothing was written — never a silent no-op.

test('writeToPtySessionResult reports no_live_session when the pane has no PTY', () => {
  // Regression guard: before the fix, writing to a dead pane silently returned.
  const result = writeToPtySessionResult('reviewer_a', 'review the latest commit\r');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no_live_session');
  assert.equal(result.paneId, 'reviewer_a');
  assert.match(result.error, /No live reviewer_a session/);
});

test('writeToPtySessionResult reports unknown_pane for an unrecognized pane id', () => {
  const result = writeToPtySessionResult('not_a_pane', 'hello\r');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unknown_pane');
});

test('writeToPtySessionResult confirms a write to a live session', () => {
  // `cat` reads stdin and stays alive, so the pane has a live PTY to deliver to.
  const root = makeProject();
  const started = openPtySession({
    paneId: 'builder',
    projectRoot: root,
    command: 'cat',
    onData: () => {},
    onExit: () => {},
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error);
  try {
    const data = 'run the tests\r';
    const result = writeToPtySessionResult('builder', data);
    assert.equal(result.ok, true);
    assert.equal(result.paneId, 'builder');
    assert.equal(result.bytes, Buffer.byteLength(data));
  } finally {
    stopPtySession('builder');
  }
});

// --- Pane session-state lifecycle truth (issue #63) ----------------------------
// The renderer must reflect real PTY process state (running / exited / stopped /
// failed) instead of inferring from local button clicks, so main tracks it as the
// single source of truth and pushes snapshots.

/** Resolve once a pane reaches `exited`/`stopped`/`failed`, or reject on timeout. */
function waitForPaneSettled(paneId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const state = getPaneSessionState(paneId);
      if (state && (state.lifecycle === 'exited' || state.lifecycle === 'stopped' || state.lifecycle === 'failed')) {
        resolve(state);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`pane ${paneId} did not settle in ${timeoutMs}ms (was ${state?.lifecycle})`));
        return;
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

test('getPaneSessionStates tracks all four role panes', () => {
  const states = getPaneSessionStates();
  assert.deepEqual(
    states.map((s) => s.paneId),
    ['head', 'builder', 'reviewer_a', 'reviewer_b'],
  );
});

test('a live PTY reports running, then stopped reads as operator-ended (not exited)', () => {
  const root = makeProject();
  // `cat` reads stdin and stays alive, so the pane is genuinely running.
  const started = openPtySession({ paneId: 'head', projectRoot: root, command: 'cat', onData: () => {}, onExit: () => {} });
  assert.equal(started.ok, true, started.ok ? '' : started.error);
  const running = getPaneSessionState('head');
  assert.equal(running.lifecycle, 'running');
  assert.equal(running.live, true);
  assert.equal(typeof running.pid, 'number');
  assert.equal(running.cwd, root);

  stopPtySession('head');
  const stopped = getPaneSessionState('head');
  assert.equal(stopped.lifecycle, 'stopped');
  assert.equal(stopped.live, false);
  assert.equal(stopped.pid, null);
});

test('a one-shot process that exits reports exited with its code (not running/idle)', async () => {
  // Regression guard: a fake one-shot reviewer that exits must show `exited` with a
  // code, never linger as a live `watching`/`running` watcher.
  const root = makeProject();
  const started = openPtySession({
    paneId: 'reviewer_a',
    projectRoot: root,
    command: 'node -e process.exit(7)',
    onData: () => {},
    onExit: () => {},
  });
  assert.equal(started.ok, true, started.ok ? '' : started.error);
  const settled = await waitForPaneSettled('reviewer_a');
  assert.equal(settled.lifecycle, 'exited');
  assert.equal(settled.exitCode, 7);
  assert.equal(settled.live, false);
});

test('a failed launch reports failed with a visible reason and no live session', () => {
  const root = makeProject();
  const result = openPtySession({
    paneId: 'reviewer_b',
    projectRoot: root,
    command: 'definitely-not-a-real-binary-xyz',
    onData: () => {},
    onExit: () => {},
  });
  assert.equal(result.ok, false);
  const state = getPaneSessionState('reviewer_b');
  assert.equal(state.lifecycle, 'failed');
  assert.equal(state.live, false);
  assert.match(state.error, /Command not found/);
});

test('setPaneSessionListener receives a snapshot on every lifecycle change', () => {
  const root = makeProject();
  const snapshots = [];
  setPaneSessionListener((states) => snapshots.push(states));
  try {
    const started = openPtySession({ paneId: 'builder', projectRoot: root, command: 'cat', onData: () => {}, onExit: () => {} });
    assert.equal(started.ok, true, started.ok ? '' : started.error);
    stopPtySession('builder');
    assert.ok(snapshots.length >= 2, 'listener should fire on running and on stop');
    const last = snapshots[snapshots.length - 1].find((s) => s.paneId === 'builder');
    assert.equal(last.lifecycle, 'stopped');
  } finally {
    setPaneSessionListener(null);
  }
});

test('detectPromptAttention fires only on generic confirmation prompts', () => {
  assert.equal(detectPromptAttention('Do you want to proceed? [y/N] '), true);
  assert.equal(detectPromptAttention('Allow this edit? (yes/no)'), true);
  assert.equal(detectPromptAttention('Press Enter to continue'), true);
  assert.equal(detectPromptAttention('Waiting for your approval'), true);
  // Negatives: ordinary output must not be misread as a blocking prompt.
  assert.equal(detectPromptAttention('Running tests...'), false);
  assert.equal(detectPromptAttention('Compiled 12 files in 1.2s'), false);
  assert.equal(detectPromptAttention(''), false);
});

test('resolveExecutable resolves a project-relative executable path', () => {
  const root = makeProject();
  const scriptRel = 'bin/run.sh';
  const scriptAbs = path.join(root, scriptRel);
  fs.mkdirSync(path.dirname(scriptAbs), { recursive: true });
  fs.writeFileSync(scriptAbs, '#!/bin/sh\necho hi\n');
  fs.chmodSync(scriptAbs, 0o755);

  const resolved = resolveExecutable(`./${scriptRel}`, root, { PATH: '' });
  assert.equal(resolved, scriptAbs);

  // A non-executable file is not a launch candidate.
  const plainRel = 'notes.txt';
  fs.writeFileSync(path.join(root, plainRel), 'hi');
  assert.equal(resolveExecutable(`./${plainRel}`, root, { PATH: '' }), null);
});
