// Coverage for run-scoped git worktree isolation (issue #41): pure path/branch
// derivation, the PTY cwd allowlist, and the git-backed lifecycle (create /
// inspect / remove / list) against a scratch `git init` repo in a temp dir —
// including the 2026-06-04 collision regression (a builder session in a worktree
// leaves the primary checkout's branch and working tree untouched). Run via
// `npm test` (which builds the main process first).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  createWorktree,
  deriveWorktreePlan,
  inspectWorktree,
  isGitRepo,
  isManagedWorktreePath,
  listManagedWorktrees,
  managedWorktreesParent,
  removeWorktree,
  safeWorktreeSegment,
} from '../dist/main/worktree.js';
import { isAllowedPtyCwd } from '../dist/main/pty.js';

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

/**
 * Build a scratch operated project: a git repo on branch `main` with one commit,
 * a bare remote, and `main` pushed so remote-tracking refs exist (so the unpushed
 * check behaves like a real cloned repo). Returns the work tree root.
 */
function makeGitProject() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-wt-'));
  const root = path.join(base, 'project');
  const remote = path.join(base, 'remote.git');
  fs.mkdirSync(root, { recursive: true });

  git(root, ['init', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'README.md'), '# scratch\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);

  git(root, ['init', '--bare', remote]);
  git(root, ['remote', 'add', 'origin', remote]);
  git(root, ['push', '-u', 'origin', 'main']);

  return root;
}

test('safeWorktreeSegment reduces to a single safe segment', () => {
  assert.equal(safeWorktreeSegment('run-abc-issue-41-1'), 'run-abc-issue-41-1');
  assert.equal(safeWorktreeSegment('weird/../path name'), 'weird-path-name');
  assert.equal(safeWorktreeSegment('///'), 'project');
  assert.equal(safeWorktreeSegment(''), 'project');
});

test('deriveWorktreePlan places the worktree in a sibling dir on a run branch', () => {
  const root = path.join(os.tmpdir(), 'demo', 'myproj');
  const plan = deriveWorktreePlan(root, 'run-xyz-issue-41-1');
  assert.equal(plan.branch, 'godmode/run-xyz-issue-41-1');
  // Sibling of the checkout, never inside it (avoids watcher/build interference).
  assert.equal(path.dirname(path.dirname(plan.dir)), path.dirname(root));
  assert.equal(path.basename(path.dirname(plan.dir)), '.godmode-worktrees');
  assert.equal(path.basename(plan.dir), 'myproj-run-xyz-issue-41-1');
});

test('isManagedWorktreePath admits only paths under the managed parent', () => {
  const root = path.join(os.tmpdir(), 'demo', 'myproj');
  const plan = deriveWorktreePlan(root, 'run-1');
  assert.equal(isManagedWorktreePath(root, plan.dir), true);
  assert.equal(isManagedWorktreePath(root, root), false);
  assert.equal(isManagedWorktreePath(root, managedWorktreesParent(root)), false);
  assert.equal(isManagedWorktreePath(root, '/etc'), false);
});

test('isAllowedPtyCwd admits only the project root and the active worktree', () => {
  const root = '/tmp/proj';
  const wt = '/tmp/.godmode-worktrees/proj-run-1';
  assert.equal(isAllowedPtyCwd(root, undefined, root), true);
  assert.equal(isAllowedPtyCwd(root, undefined, wt), false);
  assert.equal(isAllowedPtyCwd(root, wt, wt), true);
  assert.equal(isAllowedPtyCwd(root, wt, '/tmp/somewhere-else'), false);
  // Resolves before comparing, so a trailing-slash/relative form still matches.
  assert.equal(isAllowedPtyCwd(root, wt, `${root}/`), true);
});

test('isGitRepo distinguishes a repo from a plain directory', async () => {
  const root = makeGitProject();
  assert.equal(await isGitRepo(root), true);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'godmode-plain-'));
  assert.equal(await isGitRepo(plain), false);
});

test('createWorktree makes a worktree on its branch and leaves the primary checkout untouched', async () => {
  const root = makeGitProject();
  const beforeBranch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const plan = deriveWorktreePlan(root, 'run-collision-1');

  const created = await createWorktree({ projectRoot: root, dir: plan.dir, branch: plan.branch });
  assert.equal(created.ok, true);
  assert.equal(created.reused, false);
  assert.ok(fs.existsSync(plan.dir));
  assert.equal(git(plan.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), plan.branch);

  // Collision regression (2026-06-04): a full builder session in the worktree —
  // here, switching files and committing — must not touch the primary checkout.
  fs.writeFileSync(path.join(plan.dir, 'builder-work.txt'), 'in worktree\n');
  git(plan.dir, ['add', '.']);
  git(plan.dir, ['commit', '-m', 'builder commit in worktree']);

  assert.equal(git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(), beforeBranch);
  assert.equal(git(root, ['status', '--porcelain']).trim(), '');
  assert.equal(fs.existsSync(path.join(root, 'builder-work.txt')), false);

  // Idempotent reuse: a second create against an existing dir reuses it.
  const again = await createWorktree({ projectRoot: root, dir: plan.dir, branch: plan.branch });
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);
});

test('inspectWorktree reports clean, then unpushed, then dirty', async () => {
  const root = makeGitProject();
  const plan = deriveWorktreePlan(root, 'run-clean-1');
  await createWorktree({ projectRoot: root, dir: plan.dir, branch: plan.branch });

  // Fresh worktree off a pushed base: clean (nothing uncommitted, nothing unpushed).
  const fresh = await inspectWorktree(plan.dir);
  assert.equal(fresh.clean, true, JSON.stringify(fresh));
  assert.equal(fresh.dirty, false);
  assert.equal(fresh.unpushed, false);

  // A committed-but-unpushed change is not clean.
  fs.writeFileSync(path.join(plan.dir, 'a.txt'), 'a\n');
  git(plan.dir, ['add', '.']);
  git(plan.dir, ['commit', '-m', 'unpushed work']);
  const committed = await inspectWorktree(plan.dir);
  assert.equal(committed.clean, false);
  assert.equal(committed.unpushed, true);

  // An uncommitted change is dirty.
  fs.writeFileSync(path.join(plan.dir, 'b.txt'), 'b\n');
  const dirty = await inspectWorktree(plan.dir);
  assert.equal(dirty.clean, false);
  assert.equal(dirty.dirty, true);
});

test('removeWorktree refuses a dirty tree but removes a clean one', async () => {
  const root = makeGitProject();
  const plan = deriveWorktreePlan(root, 'run-remove-1');
  await createWorktree({ projectRoot: root, dir: plan.dir, branch: plan.branch });

  // Dirty (uncommitted) → git itself refuses removal without --force.
  fs.writeFileSync(path.join(plan.dir, 'wip.txt'), 'wip\n');
  const refused = await removeWorktree({ projectRoot: root, dir: plan.dir });
  assert.equal(refused.ok, false);
  assert.ok(fs.existsSync(plan.dir));

  // Clean it, then removal succeeds.
  fs.rmSync(path.join(plan.dir, 'wip.txt'));
  const removed = await removeWorktree({ projectRoot: root, dir: plan.dir });
  assert.equal(removed.ok, true);
  assert.equal(fs.existsSync(plan.dir), false);
});

test('listManagedWorktrees finds managed worktrees and flags the current run', async () => {
  const root = makeGitProject();
  const a = deriveWorktreePlan(root, 'run-a');
  const b = deriveWorktreePlan(root, 'run-b');
  await createWorktree({ projectRoot: root, dir: a.dir, branch: a.branch });
  await createWorktree({ projectRoot: root, dir: b.dir, branch: b.branch });

  const list = await listManagedWorktrees(root, a.dir);
  const paths = list.map((wt) => path.basename(wt.path)).sort();
  assert.deepEqual(paths, [path.basename(a.dir), path.basename(b.dir)].sort());

  // git reports realpaths (e.g. /private/var on macOS), so match by basename.
  const entryA = list.find((wt) => path.basename(wt.path) === path.basename(a.dir));
  const entryB = list.find((wt) => path.basename(wt.path) === path.basename(b.dir));
  assert.equal(entryA.isCurrentRun, true);
  assert.equal(entryB.isCurrentRun, false);
  assert.equal(entryA.branch, a.branch);
  // The primary checkout is NOT a managed worktree, so it never appears.
  assert.equal(list.some((wt) => path.basename(wt.path) === path.basename(root)), false);
});
