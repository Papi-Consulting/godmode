// Template/registry rendering tests for issue #5. Pure functions only — no
// filesystem or Electron — so they run under Node's built-in test runner against
// the compiled main output (`npm run build:main` first). Run via `npm test`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_TEMPLATES,
  buildPreview,
  buildRoleResolutions,
  renderTemplate,
  resolveCapabilities,
} from '../dist/main/agents.js';
import { DEFAULT_CONFIG } from '../dist/main/config.js';

test('renderTemplate substitutes bound variables', () => {
  const { prompt, missingVariables } = renderTemplate('issue #{{issueNumber}}: {{issueTitle}}', {
    issueNumber: '5',
    issueTitle: 'Adapter registry',
  });
  assert.equal(prompt, 'issue #5: Adapter registry');
  assert.deepEqual(missingVariables, []);
});

test('renderTemplate leaves unbound tokens intact and reports them once', () => {
  const { prompt, missingVariables } = renderTemplate('#{{prNumber}} / {{prNumber}} on {{branch}}', {});
  assert.equal(prompt, '#{{prNumber}} / {{prNumber}} on {{branch}}');
  assert.deepEqual(missingVariables, ['prNumber', 'branch']);
});

test('resolveCapabilities applies adapter defaults then per-agent overrides', () => {
  const cli = resolveCapabilities('cli');
  assert.equal(cli.canEditFiles, true);
  assert.equal(cli.supportsPty, true);

  const reviewer = resolveCapabilities('cli', { canEditFiles: false, canOpenPr: false });
  assert.equal(reviewer.canEditFiles, false);
  assert.equal(reviewer.canOpenPr, false);
  // Untouched keys keep the adapter default.
  assert.equal(reviewer.canCommentOnPr, true);
});

test('buildPreview renders builder start, each reviewer start, and builder fix', () => {
  const preview = buildPreview(DEFAULT_CONFIG, {
    projectName: 'demo',
    issueNumber: 5,
    issueTitle: 'Adapter registry',
    prNumber: 21,
    prUrl: 'https://example/pr/21',
    branch: 'feat/x',
    blockers: 'Fix the off-by-one.',
  });

  assert.deepEqual(
    preview.map((command) => command.kind),
    ['builder_start', 'reviewer_start', 'reviewer_start', 'builder_fix'],
  );

  const builderStart = preview[0];
  assert.equal(builderStart.role, 'builder');
  assert.match(builderStart.prompt, /issue #5 \(Adapter registry\)/);
  assert.match(builderStart.commandLine, /--project demo$/);
  assert.deepEqual(builderStart.missingVariables, []);

  const reviewerA = preview[1];
  assert.equal(reviewerA.role, 'reviewer_a');
  assert.match(reviewerA.prompt, /as reviewer-a/);
  assert.match(reviewerA.prompt, /docs\/review\/reviewer-a-correctness\.md/);
  assert.equal(reviewerA.delivery, 'oneshot');

  const builderFix = preview[3];
  assert.equal(builderFix.kind, 'builder_fix');
  assert.match(builderFix.prompt, /Fix the off-by-one\./);
});

test('buildPreview marks unbound issue/PR variables as missing', () => {
  const [builderStart] = buildPreview(DEFAULT_CONFIG, { projectName: 'demo' });
  assert.ok(builderStart.missingVariables.includes('issueNumber'));
  assert.match(builderStart.prompt, /\{\{issueNumber\}\}/);
});

test('buildRoleResolutions resolves all four roles through config objects', () => {
  const roles = buildRoleResolutions(DEFAULT_CONFIG);
  assert.deepEqual(
    roles.map((role) => role.role),
    ['head', 'builder', 'reviewer_a', 'reviewer_b'],
  );
  const reviewerA = roles.find((role) => role.role === 'reviewer_a');
  assert.equal(reviewerA.reviewerId, 'reviewer-a');
  assert.equal(reviewerA.capabilities.canEditFiles, false);
});

test('config commands override default templates per kind', () => {
  const custom = { ...DEFAULT_CONFIG, commands: { builder_start: 'do {{issueNumber}}' } };
  const [builderStart] = buildPreview(custom, { projectName: 'demo', issueNumber: 9 });
  assert.equal(builderStart.prompt, 'do 9');
  // Untouched kinds still use the built-in defaults.
  assert.ok(DEFAULT_TEMPLATES.reviewer_start.length > 0);
});
