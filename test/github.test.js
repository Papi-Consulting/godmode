// Regression coverage for the commit-verification expected-commit resolution
// (issue #41). In worktree mode the run's working branch lives on the worktree
// and the primary checkout intentionally stays on another branch, so the expected
// commit must come from the *branch tip*, not the primary checkout's HEAD. These
// tests drive `getCommitVerification` against a scratch `git init` repo in a temp
// dir; `gh` is irrelevant here (the PR fetch may fail/be absent — the expected
// commit is resolved from git before any `gh` call). Run via `npm test`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { getCommitVerification } from '../dist/main/github.js';
import { createWorktree, deriveWorktreePlan } from '../dist/main/worktree.js';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/** A scratch repo on `main` with one commit (no remote needed for these tests). */
function makeRepo() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-gh-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# scratch\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

const NOW = '2026-06-14T00:00:00.000Z';

test('getCommitVerification resolves the run branch tip, not the primary HEAD (#41)', async () => {
  const root = makeRepo();
  const primaryHead = git(root, ['rev-parse', 'HEAD']).trim();

  // Create the run worktree on its branch, then commit in it so the run branch
  // tip diverges from the primary checkout's HEAD (the isolated-run reality).
  const plan = deriveWorktreePlan(root, 'run-verify-41');
  const created = await createWorktree({ projectRoot: root, dir: plan.dir, branch: plan.branch });
  assert.equal(created.ok, true);
  fs.writeFileSync(path.join(plan.dir, 'work.txt'), 'builder work\n');
  git(plan.dir, ['add', '.']);
  git(plan.dir, ['commit', '-m', 'builder commit on run branch']);
  const branchTip = git(plan.dir, ['rev-parse', 'HEAD']).trim();
  assert.notEqual(branchTip, primaryHead, 'precondition: branch tip must differ from primary HEAD');

  // The primary checkout is still on main; passing the run branch must verify the
  // branch tip (not the primary HEAD), sourced as branch_tip.
  const v = await getCommitVerification(root, { branch: plan.branch }, NOW);
  assert.equal(v.expectedCommit, branchTip);
  assert.equal(v.expectedCommitSource, 'branch_tip');
  assert.notEqual(v.expectedCommit, primaryHead);
});

test('getCommitVerification uses the current branch tip in shared mode (no branch passed)', async () => {
  const root = makeRepo();
  const primaryHead = git(root, ['rev-parse', 'HEAD']).trim();

  // No branch passed and no run-recorded commit: shared-mode runs resolve the
  // current branch and verify its tip (which equals HEAD on a clean checkout).
  const v = await getCommitVerification(root, {}, NOW);
  assert.equal(v.expectedCommit, primaryHead);
  assert.equal(v.expectedCommitSource, 'branch_tip');
});

test('getCommitVerification falls back to local HEAD when the branch is unresolvable (detached)', async () => {
  const root = makeRepo();
  const primaryHead = git(root, ['rev-parse', 'HEAD']).trim();

  // Detached HEAD: no current branch and no run branch, so the only resolvable
  // expected commit is the local HEAD itself.
  git(root, ['checkout', '--detach']);
  const v = await getCommitVerification(root, {}, NOW);
  assert.equal(v.expectedCommit, primaryHead);
  assert.equal(v.expectedCommitSource, 'local_head');
});

test('getCommitVerification scopes to the bound branch even in shared mode with a moved checkout (#38 A-1/B-1)', async () => {
  // Regression for the Reviewer A/B blocker: a shared run binds a discovered PR
  // branch, but the operator's checkout has since moved off it (to `main`, here).
  // The index.ts callers must verify against the *recorded* branch, never the
  // current checkout. This proves the contract those callers now rely on: passing
  // the bound branch resolves its tip; falling back to the checkout (the old
  // `worktree ? branch : undefined` behavior) would verify the wrong commit.
  const root = makeRepo();
  const mainHead = git(root, ['rev-parse', 'HEAD']).trim();

  // A divergent PR branch, then the operator's checkout moves back to main.
  git(root, ['checkout', '-b', 'feat/discovered-pr']);
  fs.writeFileSync(path.join(root, 'pr-work.txt'), 'builder work\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'builder commit on the PR branch']);
  const prBranchTip = git(root, ['rev-parse', 'HEAD']).trim();
  git(root, ['checkout', 'main']);
  assert.notEqual(prBranchTip, mainHead, 'precondition: PR branch tip must differ from main HEAD');
  assert.equal(git(root, ['rev-parse', 'HEAD']).trim(), mainHead, 'precondition: checkout sits on main');

  // The fix: passing the bound branch verifies the PR branch tip.
  const bound = await getCommitVerification(root, { branch: 'feat/discovered-pr' }, NOW);
  assert.equal(bound.expectedCommit, prBranchTip);
  assert.equal(bound.expectedCommitSource, 'branch_tip');
  assert.equal(bound.branch, 'feat/discovered-pr');

  // The old behavior (no branch -> current checkout) would have verified main's
  // HEAD instead — the wrong target. Pinned here to lock in why the fix matters.
  const fellBack = await getCommitVerification(root, {}, NOW);
  assert.equal(fellBack.expectedCommit, mainHead);
  assert.notEqual(fellBack.expectedCommit, bound.expectedCommit);
});

test('getCommitVerification prefers the run-recorded commit over any git lookup', async () => {
  const root = makeRepo();
  const recorded = 'a'.repeat(40);
  const v = await getCommitVerification(root, { branch: 'main', expectedCommit: recorded }, NOW);
  assert.equal(v.expectedCommit, recorded);
  assert.equal(v.expectedCommitSource, 'run_recorded');
});
