// Builder handoff composition tests for issue #8. Pure function only — no
// filesystem or Electron — so they run under Node's built-in test runner against
// the compiled main output (`npm run build:main` first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { composeBuilderHandoff, promptDigest } from '../dist/main/handoff.js';
import { DEFAULT_CONFIG } from '../dist/main/config.js';
import { createRun } from '../dist/main/run.js';

const NOW = '2026-06-06T12:00:00.000Z';

function githubRun(overrides = {}) {
  return {
    ...createRun({
      sourceType: 'github_issue',
      sourceId: '8',
      issueNumber: 8,
      issueTitle: 'Bind selected issue to builder handoff',
      now: NOW,
      id: 'run-8',
    }),
    status: 'issue_selected',
    ...overrides,
  };
}

test('a bound GitHub issue produces a sendable, pointer-first handoff scoped to the operated project', () => {
  const run = githubRun({
    sourceDetail: {
      url: 'https://github.com/x/y/issues/8',
      body: 'Implement the handoff binding.',
      labels: ['enhancement'],
      comments: [{ author: 'karan', body: 'Keep the gate manual.' }],
    },
  });
  const handoff = composeBuilderHandoff(DEFAULT_CONFIG, run, {
    projectName: 'godmode',
    docPointers: {
      architecture: ['docs/architecture/run-state-machine.md'],
      conventions: ['docs/conventions/codegraph-ipc.md'],
    },
  });

  assert.equal(handoff.isMock, false);
  assert.equal(handoff.canSend, true);
  assert.deepEqual(handoff.missingVariables, []);
  // Acceptance: no unresolved issue tokens remain.
  assert.ok(!handoff.prompt.includes('{{issueNumber}}'));
  assert.ok(!handoff.prompt.includes('{{issueTitle}}'));
  assert.match(handoff.prompt, /Issue #8/);
  // Pointer-first: direct the builder to read the operated project's sources itself.
  assert.match(handoff.prompt, /AGENTS\.md/);
  assert.match(handoff.prompt, /docs\/spec\.md/);
  assert.match(handoff.prompt, /FRESH builder session/);
  assert.match(handoff.prompt, /gh issue view 8 --comments/);
  assert.match(handoff.prompt, /docs\/architecture\/run-state-machine\.md/);
  assert.match(handoff.prompt, /docs\/conventions\/codegraph-ipc\.md/);
  // Scoped clearly to the operated project (the repo opened in GodMode, not the app repo).
  assert.match(handoff.prompt, /operated project/i);
  assert.match(handoff.prompt, /godmode/);
  assert.match(handoff.prompt, /NOT the GodMode app repo/);
  // But the sent prompt must NOT paste the full issue body/comments — that stays
  // in the operator preview/audit (run.sourceDetail), reducing tokens and stale
  // context. The builder reads the issue itself via gh.
  assert.ok(!handoff.prompt.includes('Implement the handoff binding.'), 'sent prompt must not paste issue body');
  assert.ok(!handoff.prompt.includes('Keep the gate manual.'), 'sent prompt must not paste issue comments');
  assert.equal(handoff.sourceLabel, 'issue #8 — Bind selected issue to builder handoff');
});

test('a manual task is blocked from direct send (no issue number to bind)', () => {
  const run = {
    ...createRun({
      sourceType: 'manual_task',
      sourceId: 'task-x',
      issueTitle: 'Tidy the cockpit',
      sourceDetail: { body: 'Make the panes more compact.' },
      now: NOW,
      id: 'run-task',
    }),
    status: 'issue_selected',
  };
  const handoff = composeBuilderHandoff(DEFAULT_CONFIG, run, { projectName: 'godmode' });

  assert.equal(handoff.isMock, false);
  assert.equal(handoff.canSend, false);
  assert.ok(handoff.missingVariables.includes('issueNumber'));
  assert.match(handoff.blockedReason, /needs_spec/);
  // A manual task has no GitHub issue to point at, so its text is the only source
  // of truth and stays in the (preview-only) prompt; it is scoped to the operated project.
  assert.match(handoff.prompt, /Manual task task-x/);
  assert.match(handoff.prompt, /Make the panes more compact\./);
  assert.match(handoff.prompt, /operated project/i);
});

test('a manual task stays unsendable even when builder_start omits issue tokens', () => {
  // Regression: canSend must be gated on source type, not just the absence of
  // unbound template tokens. A custom builder_start with no {{issueNumber}}
  // leaves missingVariables empty, but a manual task must never be directly
  // sendable — it routes through needs_spec or gets attached to a GitHub issue.
  const custom = { ...DEFAULT_CONFIG, commands: { builder_start: 'Build {{projectName}} now' } };
  const manualRun = {
    ...createRun({
      sourceType: 'manual_task',
      sourceId: 'task-y',
      issueTitle: 'No-token template',
      sourceDetail: { body: 'do the thing' },
      now: NOW,
      id: 'run-task-y',
    }),
    status: 'issue_selected',
  };
  const manual = composeBuilderHandoff(custom, manualRun, { projectName: 'godmode' });
  assert.deepEqual(manual.missingVariables, [], 'the override leaves no unbound tokens');
  assert.equal(manual.canSend, false, 'manual task must not be sendable despite empty missingVariables');
  assert.match(manual.blockedReason, /needs_spec/);

  // The same override on a real GitHub issue stays sendable.
  const issue = composeBuilderHandoff(custom, githubRun(), { projectName: 'godmode' });
  assert.equal(issue.canSend, true);
});

test('no bound run yields a clearly-labeled mock handoff that cannot be sent', () => {
  const handoff = composeBuilderHandoff(DEFAULT_CONFIG, null, { projectName: 'godmode' });
  assert.equal(handoff.isMock, true);
  assert.equal(handoff.canSend, false);
  assert.match(handoff.prompt, /mock\/demo preview/);
  assert.match(handoff.prompt, /\{\{issueNumber\}\}/);
  assert.equal(handoff.sourceLabel, undefined);
});

test('config command overrides flow into the handoff template', () => {
  const custom = { ...DEFAULT_CONFIG, commands: { builder_start: 'BUILD #{{issueNumber}}: {{issueTitle}}' } };
  const handoff = composeBuilderHandoff(custom, githubRun(), { projectName: 'godmode' });
  assert.match(handoff.prompt, /BUILD #8: Bind selected issue to builder handoff/);
  assert.equal(handoff.canSend, true);
});

test('promptDigest collapses whitespace and bounds length', () => {
  assert.equal(promptDigest('a\n  b   c'), 'a b c');
  const long = 'x'.repeat(200);
  const digest = promptDigest(long, 50);
  assert.equal(digest.length, 51); // 50 chars + ellipsis
  assert.ok(digest.endsWith('…'));
});
