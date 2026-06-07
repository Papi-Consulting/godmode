// Run-artifact path/capture tests for issue #10. Pure path logic plus a small
// filesystem helper over a temp dir (mirroring `pty.test.js`) — no Electron. Run
// against the compiled main output (`npm run build:main` first) via `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendArtifact,
  ensureRunArtifactDir,
  readReviewerArtifact,
  reviewerArtifactPath,
  reviewerArtifactRelPath,
  runArtifactRelDir,
  runFindingsPath,
  runFindingsRelPath,
  safeArtifactSegment,
  writeRunFindings,
} from '../dist/main/artifacts.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-artifacts-'));
}

test('runArtifactRelDir is the gitignored project-relative run dir', () => {
  assert.equal(runArtifactRelDir('run-10'), '.godmode/runs/run-10');
});

test('reviewerArtifactRelPath is the gitignored per-reviewer log path', () => {
  assert.equal(reviewerArtifactRelPath('run-10', 'reviewer-a'), '.godmode/runs/run-10/reviewer-a.log');
});

test('a config-controlled reviewer id cannot escape the run dir', () => {
  // A malicious/typo'd reviewer id with path separators or `..` is reduced to a
  // single safe segment, so the artifact stays confined to .godmode/runs/<run>/.
  assert.equal(safeArtifactSegment('../../etc/passwd'), '______etc_passwd');
  assert.equal(safeArtifactSegment(''), '_');
  const root = tempRoot();
  const escaped = reviewerArtifactPath(root, 'run-10', '../../evil');
  const runDir = path.resolve(root, '.godmode', 'runs', 'run-10');
  assert.ok(escaped.startsWith(runDir + path.sep), `${escaped} must stay under ${runDir}`);
  assert.ok(!reviewerArtifactRelPath('run-10', '../../evil').includes('..'));
});

test('ensureRunArtifactDir creates the absolute run dir under the operated project', () => {
  const root = tempRoot();
  const dir = ensureRunArtifactDir(root, 'run-10');
  assert.equal(dir, path.resolve(root, '.godmode', 'runs', 'run-10'));
  assert.ok(fs.statSync(dir).isDirectory());
  // Idempotent: a second call on an existing dir does not throw.
  assert.doesNotThrow(() => ensureRunArtifactDir(root, 'run-10'));
});

test('reviewerArtifactPath resolves one reviewer log under the run dir', () => {
  const root = tempRoot();
  const file = reviewerArtifactPath(root, 'run-10', 'reviewer-a');
  assert.equal(file, path.resolve(root, '.godmode', 'runs', 'run-10', 'reviewer-a.log'));
});

test('appendArtifact accumulates captured output and reports success', () => {
  const root = tempRoot();
  ensureRunArtifactDir(root, 'run-10');
  const file = reviewerArtifactPath(root, 'run-10', 'reviewer-a');
  assert.equal(appendArtifact(file, 'first chunk\n'), true);
  assert.equal(appendArtifact(file, 'second chunk\n'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'first chunk\nsecond chunk\n');
});

test('appendArtifact reports failure (not a throw) when the target dir is missing', () => {
  const root = tempRoot();
  // No ensureRunArtifactDir — the parent dir does not exist. Capture must not
  // throw into the data callback, but it must report the failure so the caller
  // can mark the reviewer failed rather than silently completing.
  const file = reviewerArtifactPath(root, 'missing-run', 'reviewer-a');
  let ok;
  assert.doesNotThrow(() => {
    ok = appendArtifact(file, 'dropped\n');
  });
  assert.equal(ok, false);
  assert.ok(!fs.existsSync(file));
});

// --- Findings persistence (issue #11) ----------------------------------------

test('readReviewerArtifact returns captured text, or null when absent', () => {
  const root = tempRoot();
  ensureRunArtifactDir(root, 'run-11');
  appendArtifact(reviewerArtifactPath(root, 'run-11', 'reviewer-a'), 'DONE: ROLE=reviewer STATUS=pass BLOCKING=0\n');
  assert.match(readReviewerArtifact(root, 'run-11', 'reviewer-a'), /STATUS=pass/);
  // An absent artifact (e.g. a launch failure) reads as null, not a throw — the
  // caller parses it to an ambiguous result rather than crashing synthesis.
  assert.equal(readReviewerArtifact(root, 'run-11', 'reviewer-b'), null);
});

test('runFindingsRelPath/runFindingsPath point at the gitignored findings doc', () => {
  assert.equal(runFindingsRelPath('run-11'), '.godmode/runs/run-11/findings.json');
  const root = tempRoot();
  assert.equal(runFindingsPath(root, 'run-11'), path.resolve(root, '.godmode', 'runs', 'run-11', 'findings.json'));
});

test('writeRunFindings persists a round-trippable findings doc under the run dir', () => {
  const root = tempRoot();
  const doc = { runId: 'run-11', cycle: 1, results: [], merge: { mergeReady: false }, acceptedBlockers: [], fetchedAt: 'now' };
  assert.equal(writeRunFindings(root, 'run-11', doc), true);
  const written = JSON.parse(fs.readFileSync(runFindingsPath(root, 'run-11'), 'utf8'));
  assert.deepEqual(written, doc);
});
