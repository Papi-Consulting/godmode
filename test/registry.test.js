// Integration coverage for the IPC-facing registry path
// (`selectProject` -> `getRegistryState`, the function behind
// `godmode:registry:get`). Exercises real config loading from disk so the
// status/error contract the renderer relies on is automated, not just
// smoke-tested. Pure Node + a temp dir — no Electron. Run via `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getRegistryState } from '../dist/main/agents.js';
import { selectProject } from '../dist/main/project.js';

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-registry-'));
  for (const [rel, contents] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  selectProject(root);
  return root;
}

const VALID_CONFIG = `
roles:
  head: { pane: head, agent: hermes, display_name: Hermes }
  builder: { pane: builder, agent: claude-code, display_name: Claude Code }
  reviewers:
    - { id: reviewer-a, pane: reviewer_a, agent: codex, display_name: Codex A }
agents:
  hermes: { adapter: cli, command: hermes, mode: interactive }
  claude-code: { adapter: cli, command: claude, mode: interactive }
  codex: { adapter: cli, command: codex, mode: oneshot }
`;

test('missing config resolves to default registry with safe defaults', () => {
  makeProject();
  const state = getRegistryState();
  assert.equal(state.status, 'default');
  assert.equal(state.source, 'default');
  assert.equal(state.error, undefined);
  assert.deepEqual(
    state.roles.map((role) => role.role),
    ['head', 'builder', 'reviewer_a', 'reviewer_b'],
  );
  assert.equal(state.preview.length, 4);
});

test('valid config resolves to a ready registry from the file', () => {
  makeProject({ '.agentic/godmode.yaml': VALID_CONFIG });
  const state = getRegistryState();
  assert.equal(state.status, 'ready');
  assert.equal(state.source, 'config');
  // One reviewer configured -> builder start + 1 reviewer start + builder fix.
  assert.deepEqual(
    state.preview.map((command) => command.kind),
    ['builder_start', 'reviewer_start', 'builder_fix'],
  );
});

test('invalid config surfaces a visible error and falls back to defaults', () => {
  makeProject({ '.agentic/godmode.yaml': 'roles: { head: {} }\n' });
  const state = getRegistryState();
  assert.equal(state.status, 'invalid');
  assert.equal(state.source, 'default');
  assert.match(state.error, /Invalid \.agentic\/godmode\.yaml/);
  // Defaults keep the registry usable despite the bad file.
  assert.equal(state.roles.length, 4);
});

test('unknown agent reference is rejected as invalid with a named error', () => {
  const config = VALID_CONFIG.replace('agent: hermes', 'agent: ghost');
  makeProject({ '.agentic/godmode.yaml': config });
  const state = getRegistryState();
  assert.equal(state.status, 'invalid');
  assert.match(state.error, /Unknown agent "ghost"/);
});

test('context binds issue/PR variables into the IPC-facing preview', () => {
  makeProject({ '.agentic/godmode.yaml': VALID_CONFIG });
  const state = getRegistryState({ issueNumber: 42, issueTitle: 'Wire it up' });
  const builderStart = state.preview.find((command) => command.kind === 'builder_start');
  assert.match(builderStart.prompt, /issue #42 \(Wire it up\)/);
  assert.ok(!builderStart.missingVariables.includes('issueNumber'));
});
