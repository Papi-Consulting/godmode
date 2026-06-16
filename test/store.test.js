// Run-persistence tests for issue #40. Exercise the SQLite/JSON store, the
// write-through hook + resume restore in run.ts, dead-session marking, and the
// failure-degradation contract — all over temp project roots (mirroring
// artifacts.test.js), no Electron. Run against compiled output via `npm test`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  archiveRun,
  closeAllRunStores,
  loadUnfinishedRun,
  preferredBackendKind,
  saveRun,
  storeBackendKind,
  validateRunSnapshot,
} from '../dist/main/store.js';
import {
  adoptResumedRun,
  applyAction,
  clearRun,
  createRun,
  dispatchRunAction,
  getCurrentRun,
  markRunSessionsDead,
  RESUMED_SESSION_DEAD_REASON,
  selectIssueRun,
  setRunPersistHook,
} from '../dist/main/run.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-store-'));
}

/** The faithful persisted form of a snapshot (JSON drops undefined-valued keys). */
function persistedForm(run) {
  return JSON.parse(JSON.stringify(run));
}

/** Build a realistic non-terminal snapshot advanced to `pr_opened`. */
function makeRun(overrides = {}) {
  let run = createRun({ issueNumber: 40, issueTitle: 'Persist run state', id: 'run-40-test', now: '2026-06-16T00:00:00.000Z' });
  run = applyAction(run, 'select_issue', { now: '2026-06-16T00:00:01.000Z' }).run;
  run = applyAction(run, 'mark_ready', { now: '2026-06-16T00:00:02.000Z' }).run;
  run = applyAction(run, 'start_builder', { now: '2026-06-16T00:00:03.000Z' }).run;
  run = applyAction(run, 'open_pr', {
    branch: 'fe/issue-40',
    prNumber: 77,
    expectedCommit: 'abc1234',
    now: '2026-06-16T00:00:04.000Z',
  }).run;
  return { ...run, ...overrides };
}

test('saveRun + loadUnfinishedRun round-trip the snapshot faithfully (SQLite)', () => {
  const root = tempRoot();
  const run = makeRun();
  const result = saveRun(root, run);
  assert.equal(result.ok, true);
  assert.equal(result.backend, 'sqlite');
  // The DB lives under the operated project root, gitignored alongside artifacts.
  assert.ok(fs.existsSync(path.join(root, '.godmode', 'godmode.db')));

  const loaded = loadUnfinishedRun(root);
  assert.ok(loaded);
  assert.equal(loaded.backend, 'sqlite');
  assert.deepEqual(loaded.run, persistedForm(run));
  closeAllRunStores();
});

test('loadUnfinishedRun never creates a store for a project with no persisted run', () => {
  const root = tempRoot();
  assert.equal(loadUnfinishedRun(root), null);
  assert.ok(!fs.existsSync(path.join(root, '.godmode', 'godmode.db')));
});

test('a terminal run is kept as history but never offered for resume', () => {
  const root = tempRoot();
  let run = makeRun();
  // Drive to a terminal state and persist it.
  run = applyAction(run, 'cancel', { reason: 'done', now: '2026-06-16T00:01:00.000Z' }).run;
  assert.equal(saveRun(root, run).ok, true);
  assert.equal(loadUnfinishedRun(root), null);
  closeAllRunStores();
});

test('the most recent unfinished run is the one offered', () => {
  const root = tempRoot();
  const older = { ...makeRun({ id: 'run-old' }), updatedAt: '2026-06-16T00:00:04.000Z' };
  const newer = { ...makeRun({ id: 'run-new' }), updatedAt: '2026-06-16T09:00:00.000Z' };
  assert.equal(saveRun(root, older).ok, true);
  assert.equal(saveRun(root, newer).ok, true);
  const loaded = loadUnfinishedRun(root);
  assert.equal(loaded.run.id, 'run-new');
  closeAllRunStores();
});

test('archiveRun (Discard) removes the run from the resume offer but keeps it in the store', () => {
  const root = tempRoot();
  const run = makeRun();
  assert.equal(saveRun(root, run).ok, true);
  assert.equal(archiveRun(root, run.id), true);
  // No longer offered...
  assert.equal(loadUnfinishedRun(root), null);
  // ...but nothing was deleted: the DB file is still present (history retained).
  assert.ok(fs.existsSync(path.join(root, '.godmode', 'godmode.db')));
  closeAllRunStores();
});

test('a later save updates the persisted snapshot in place (write-through)', () => {
  const root = tempRoot();
  const run = makeRun();
  assert.equal(saveRun(root, run).ok, true);
  const advanced = applyAction(run, 'start_reviewers', { now: '2026-06-16T00:05:00.000Z' }).run;
  assert.equal(saveRun(root, advanced).ok, true);
  const loaded = loadUnfinishedRun(root);
  assert.equal(loaded.run.status, 'reviewers_running');
  closeAllRunStores();
});

test('validateRunSnapshot gates corrupt/foreign data without stripping valid audit fields', () => {
  const run = makeRun();
  // A faithful object passes and is returned as-is (not a stripped copy).
  const persisted = persistedForm(run);
  const valid = validateRunSnapshot(persisted);
  assert.deepEqual(valid, persisted);
  assert.equal(valid, persisted, 'returns the original object, not a stripped zod copy');
  // Garbage / wrong-shape input is rejected.
  assert.equal(validateRunSnapshot(null), null);
  assert.equal(validateRunSnapshot({ id: 'x' }), null);
  assert.equal(validateRunSnapshot({ ...run, status: 'not_a_status' }), null);
});

test('JSON fallback backend round-trips with the same interface', () => {
  const root = tempRoot();
  process.env.GODMODE_STORE_BACKEND = 'json';
  try {
    assert.equal(preferredBackendKind(), 'json');
    const run = makeRun();
    const result = saveRun(root, run);
    assert.equal(result.ok, true);
    assert.equal(result.backend, 'json');
    assert.ok(fs.existsSync(path.join(root, '.godmode', 'godmode.db.json')));
    const loaded = loadUnfinishedRun(root);
    assert.equal(loaded.backend, 'json');
    assert.deepEqual(loaded.run, persistedForm(run));
    assert.equal(archiveRun(root, run.id), true);
    assert.equal(loadUnfinishedRun(root), null);
  } finally {
    delete process.env.GODMODE_STORE_BACKEND;
    closeAllRunStores();
  }
});

test('persistence failure degrades to ok:false instead of throwing', () => {
  const root = tempRoot();
  // Make the .godmode dir read-only so no backend can write inside it.
  const godmodeDir = path.join(root, '.godmode');
  fs.mkdirSync(godmodeDir);
  fs.chmodSync(godmodeDir, 0o500);
  try {
    const result = saveRun(root, makeRun());
    assert.equal(result.ok, false);
    assert.ok(result.error && result.error.length > 0);
  } finally {
    fs.chmodSync(godmodeDir, 0o700);
    closeAllRunStores();
  }
});

test('storeBackendKind reports the in-use backend for a project', () => {
  const root = tempRoot();
  assert.equal(saveRun(root, makeRun()).ok, true);
  assert.equal(storeBackendKind(root), 'sqlite');
  closeAllRunStores();
});

// --- run.ts write-through hook + resume restore ------------------------------

test('the persist hook fires only on accepted mutations, never on rejected ones', () => {
  clearRun();
  const saved = [];
  setRunPersistHook((run) => saved.push(run.status));
  try {
    // Accepted: select an issue → issue_selected persisted.
    const selected = selectIssueRun({ issueNumber: 41, now: '2026-06-16T00:00:00.000Z' });
    assert.equal(selected.ok, true);
    assert.equal(saved.at(-1), 'issue_selected');
    const countAfterSelect = saved.length;

    // Rejected: an illegal transition must not persist.
    const rejected = dispatchRunAction('mark_merged');
    assert.equal(rejected.ok, false);
    assert.equal(saved.length, countAfterSelect, 'a rejected transition must not be persisted');

    // Accepted: a legal transition persists again.
    const ok = dispatchRunAction('mark_ready');
    assert.equal(ok.ok, true);
    assert.equal(saved.at(-1), 'ready_to_build');
  } finally {
    setRunPersistHook(null);
    clearRun();
  }
});

test('markRunSessionsDead fails live reviewer sessions and leaves terminal ones intact', () => {
  const base = makeRun();
  const run = {
    ...base,
    reviewers: [
      { reviewerId: 'reviewer-a', paneId: 'reviewer_a', sessionToken: 't1', displayName: 'A', status: 'running', commentPosted: false, pid: 123, updatedAt: '2026-06-16T00:00:00.000Z' },
      { reviewerId: 'reviewer-b', paneId: 'reviewer_b', sessionToken: 't2', displayName: 'B', status: 'comment_posted', commentPosted: true, updatedAt: '2026-06-16T00:00:00.000Z' },
    ],
  };
  const dead = markRunSessionsDead(run, '2026-06-16T01:00:00.000Z');
  const a = dead.reviewers.find((r) => r.paneId === 'reviewer_a');
  const b = dead.reviewers.find((r) => r.paneId === 'reviewer_b');
  assert.equal(a.status, 'failed');
  assert.equal(a.error, RESUMED_SESSION_DEAD_REASON);
  assert.equal(a.pid, undefined);
  // A terminal session is untouched (its captured outcome stays valid evidence).
  assert.equal(b.status, 'comment_posted');
});

test('adoptResumedRun restores the snapshot, marks sessions dead, and recomputes actions', () => {
  clearRun();
  try {
    const base = makeRun();
    const stored = {
      ...base,
      status: 'reviewers_running',
      reviewers: [
        { reviewerId: 'reviewer-a', paneId: 'reviewer_a', sessionToken: 't1', displayName: 'A', status: 'running', commentPosted: false, updatedAt: '2026-06-16T00:00:00.000Z' },
      ],
      // A deliberately stale action set captured before the restart.
      availableActions: ['bogus_action'],
    };
    const restored = adoptResumedRun(stored, '2026-06-16T02:00:00.000Z');
    assert.equal(getCurrentRun().id, restored.id);
    assert.equal(restored.reviewers[0].status, 'failed');
    // availableActions is recomputed from the transition table, not the stale set.
    assert.ok(!restored.availableActions.includes('bogus_action'));
    assert.ok(restored.availableActions.includes('synthesize_reviews'));
  } finally {
    clearRun();
  }
});
