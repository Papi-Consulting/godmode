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
  openPtySession,
  resolveExecutable,
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
