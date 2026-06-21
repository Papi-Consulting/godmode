// Live-Electron dogfood smoke test (issue #35).
//
// Launches the REAL built GodMode app (production renderer, real preload, real
// IPC, real PTY) and asserts the operator-visible wiring end to end — but with
// FAKE agents and NO network mutations. Real agent CLIs (claude/codex/hermes)
// and mutating `gh` calls must never run here: the launched app gets an empty
// PATH so `gh` is deterministically absent (the gh_missing degradation branch),
// and every role is bound to a fake CLI fixture resolved by project-relative
// path. This is the regression guard for the #34 preload failure (window.godmode
// absent) that typecheck/build could not catch.
//
// Run via `npm run smoke` (builds first). NOT part of `npm test` — it needs a
// GUI/display and a build. On any assertion failure it captures a screenshot +
// renderer console log to a gitignored artifacts dir, tears the app down, and
// verifies no stray Electron/PTY processes remain.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import {
  FAKE_AGENT_MARKER,
  cleanupBaseDir,
  createHarnessRepo,
  createNonHarnessDir,
  createSmokeBaseDir,
} from './fixtures.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..', '..');
const ARTIFACT_DIR = path.join(APP_ROOT, '.godmode', 'smoke');

// Short per-assertion budget — the app is local. Whole-suite budget is well
// under the issue's 1–2 minute target.
const STEP_TIMEOUT = 12_000;

// Inject a mid-run failure (after the PTY launch) to exercise the diagnostic +
// teardown + stray-process path. Used to demonstrate the failure branch locally.
const FORCE_FAIL = process.env.GODMODE_SMOKE_FORCE_FAIL === '1';

const consoleLog = [];

function log(message) {
  process.stdout.write(`[smoke] ${message}\n`);
}

/** Resolve the bundled Electron binary path (the `electron` package default export). */
async function resolveElectronPath() {
  const mod = await import('electron');
  const electronPath = mod.default ?? mod;
  if (typeof electronPath !== 'string') {
    throw new Error('Could not resolve the Electron executable path from the `electron` package.');
  }
  return electronPath;
}

/** Fail early with a clear message if the production build outputs are missing. */
function assertBuildPresent() {
  const required = [
    'dist/main/index.js',
    'dist/preload/index.cjs',
    'dist/renderer/index.html',
  ];
  for (const rel of required) {
    if (!fs.existsSync(path.join(APP_ROOT, rel))) {
      throw new Error(
        `Missing build output ${rel}. Run \`npm run build\` first (\`npm run smoke\` does this for you).`,
      );
    }
  }
}

/** Wait for a renderer-side predicate, with a descriptive error on timeout. */
async function waitFor(page, description, pageFunction, arg) {
  try {
    await page.waitForFunction(pageFunction, arg, { timeout: STEP_TIMEOUT });
  } catch {
    throw new Error(`Timed out waiting for: ${description}`);
  }
}

/** True if a process with this pid is still running. */
function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Assert no stray processes remain after the app is closed: the Electron main
 * process must be gone, and no process command line may still reference the
 * fixture base dir (which would mean a leaked fake-CLI/PTY child). Read-only.
 */
function assertNoStrayProcesses({ electronPid, baseDir, soft }) {
  const problems = [];

  if (isProcessAlive(electronPid)) {
    problems.push(`Electron main process ${electronPid} is still alive after close.`);
  }

  try {
    const ps = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' });
    const selfPid = String(process.pid);
    const strays = ps
      .split('\n')
      .filter((line) => line.includes(baseDir))
      // Exclude our own process line (it may carry baseDir in argv/env echoes).
      .filter((line) => line.trim().split(/\s+/)[0] !== selfPid);
    if (strays.length > 0) {
      problems.push(`Stray process(es) still referencing the fixture dir:\n${strays.join('\n')}`);
    }
  } catch {
    // `ps` unavailable — fall back to the pid check above only.
  }

  if (problems.length > 0) {
    const message = `Stray-process check failed:\n${problems.join('\n')}`;
    if (soft) {
      log(`WARNING (post-failure): ${message}`);
      return;
    }
    throw new Error(message);
  }
  log('stray-process check passed (no Electron/PTY children remain).');
}

async function captureDiagnostics(page, error) {
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'error.txt'), String(error?.stack ?? error));
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'console.log'), consoleLog.join('\n'));
    if (page) {
      await page.screenshot({ path: path.join(ARTIFACT_DIR, 'smoke-failure.png') }).catch(() => {});
    }
    log(`failure diagnostics written to ${path.relative(APP_ROOT, ARTIFACT_DIR)}/`);
  } catch (diagErr) {
    log(`could not write diagnostics: ${diagErr}`);
  }
}

async function run() {
  assertBuildPresent();

  const baseDir = createSmokeBaseDir();
  const harnessRepo = createHarnessRepo(baseDir);
  const nonHarnessDir = createNonHarnessDir(baseDir);
  // Empty PATH dir → `gh` is deterministically not found, so the smoke exercises
  // the gh_missing degradation branch on any machine, with or without `gh`
  // installed, and never makes a network call. The fake CLI is resolved by
  // project-relative path, so it does not need PATH.
  const emptyBin = path.join(baseDir, 'emptybin');
  fs.mkdirSync(emptyBin, { recursive: true });

  const electronPath = await resolveElectronPath();

  // Curated env for the launched app: strip dev-server signals (so the app loads
  // the PRODUCTION renderer via loadFile), force production, and replace PATH so
  // `gh` is absent. HOME/TMPDIR/LANG are preserved for normal app operation.
  const launchEnv = { ...process.env };
  delete launchEnv.VITE_DEV_SERVER_URL;
  launchEnv.NODE_ENV = 'production';
  launchEnv.PATH = emptyBin;

  log(`launching Electron against the production build (operated fixture: ${harnessRepo})`);
  const electronApp = await electron.launch({
    args: [APP_ROOT],
    executablePath: electronPath,
    cwd: APP_ROOT,
    env: launchEnv,
    timeout: 30_000,
  });
  const electronPid = electronApp.process().pid;

  let page = null;
  let closed = false;
  const closeApp = async () => {
    if (closed) return;
    closed = true;
    await electronApp.close().catch(() => {});
  };

  try {
    page = await electronApp.firstWindow();
    page.on('console', (msg) => consoleLog.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => consoleLog.push(`[pageerror] ${err.message}`));
    await page.waitForLoadState('domcontentloaded');
    await waitFor(page, 'the ProjectBar to render', () =>
      Boolean(document.querySelector('input[aria-label="Project path"]')),
    );

    // --- Assertion 1: preload bridge (the #34 regression). Runs FIRST. --------
    const bridge = await page.evaluate(() => {
      const api = window.godmode;
      if (!api) return { present: false, missing: ['<window.godmode is undefined>'] };
      const expected = ['getApp', 'getProject', 'selectProject', 'getConfig', 'getGithub', 'getRun',
        'selectManualTask', 'selectIssueRun', 'getHandoff', 'sendHandoff', 'startPty', 'onPtyData', 'onPtyExit',
        'getPtyStates', 'onPtyState'];
      const missing = expected.filter((name) => typeof api[name] !== 'function');
      return { present: true, missing };
    });
    assert.ok(bridge.present, 'window.godmode must be exposed by the preload bridge (the #34 regression).');
    assert.deepEqual(
      bridge.missing,
      [],
      `window.godmode is missing expected API functions: ${bridge.missing.join(', ')}`,
    );
    log('✓ [1] preload bridge present with the expected API surface.');

    // --- Assertion 2: app identity -------------------------------------------
    const appState = await page.evaluate(() => window.godmode.getApp());
    assert.equal(appState.name, 'godmode', 'getApp() should report the GodMode app repo name.');
    assert.ok(appState.root && fs.existsSync(appState.root), 'getApp() should report a real app root.');
    log(`✓ [2] app identity: ${appState.name} @ ${appState.root}`);

    // --- Assertion 3: project selection — fixture repo via the ProjectBar UI ---
    await page.fill('input[aria-label="Project path"]', harnessRepo);
    await page.click('.project-open button:has-text("Open")');
    await waitFor(page, 'the project label to update to the fixture repo', (root) =>
      document.querySelector('.project-id strong')?.textContent === root, harnessRepo);
    await waitFor(page, 'harness status to report valid', () =>
      Boolean(document.querySelector('.harness-chip.harness-valid')));
    // The fixture repo is not the app repo, so no dogfooding badge.
    const fixtureBadge = await page.evaluate(() => Boolean(document.querySelector('.dogfood-badge')));
    assert.equal(fixtureBadge, false, 'The fixture repo must NOT show the dogfooding badge.');
    log('✓ [3] fixture repo selected via ProjectBar UI: label updated, harness valid, no badge.');

    // --- Assertion 5: config-derived panes (fixture display names) ------------
    await waitFor(page, 'the terminals panel to report config loaded', () =>
      document.querySelector('.terminals-panel .panel-header .header-chip')?.textContent === 'config loaded');
    const paneText = await page.evaluate(() => document.querySelector('.terminal-grid')?.textContent ?? '');
    for (const name of ['Fake Head', 'Fake Builder', 'Fake Reviewer A', 'Fake Reviewer B']) {
      assert.ok(paneText.includes(name), `Config-derived panes should show the display name "${name}".`);
    }
    log('✓ [5] config-derived panes render the fixture role display names; config loaded.');

    // --- Assertion 6: GitHub degradation (gh missing, controlled PATH) --------
    await waitFor(page, 'the GitHub pane to report gh missing', () =>
      document.querySelector('.github-pane .header-chip')?.textContent === 'gh missing');
    const github = await page.evaluate(() => ({
      guidance: document.querySelector('.github-guidance')?.textContent ?? '',
      repoLabel: document.querySelector('.github-pane .repo-name')?.textContent ?? '',
    }));
    assert.match(github.guidance, /not found|install it/i, 'gh_missing guidance should be actionable.');
    assert.notEqual(
      github.repoLabel,
      'Run inside the GodMode app',
      'The GitHub pane must not show the "Run inside the GodMode app" no-bridge fallback.',
    );
    log('✓ [6] GitHub pane degrades to gh_missing guidance (no crash, bridge present).');

    // --- Assertion 7: PTY launch in the operated-project root ------------------
    await page.evaluate(() => {
      window.__smokePtyData = '';
      window.__smokePtyExit = null;
      window.godmode.onPtyData((event) => {
        if (event.paneId === 'builder') window.__smokePtyData += event.data;
      });
      window.godmode.onPtyExit((event) => {
        if (event.paneId === 'builder') window.__smokePtyExit = event.exit;
      });
    });
    await page.click('button[aria-label="Start BUILDER session"]');
    await waitFor(page, 'the fake builder CLI to emit its marker and exit', (marker) =>
      typeof window.__smokePtyData === 'string' &&
      window.__smokePtyData.includes(marker) &&
      window.__smokePtyExit !== null, FAKE_AGENT_MARKER);
    const pty = await page.evaluate(() => ({ data: window.__smokePtyData, exit: window.__smokePtyExit }));
    assert.match(pty.data, new RegExp(FAKE_AGENT_MARKER), 'Builder PTY output should contain the fake-CLI marker.');
    assert.ok(
      pty.data.includes(`cwd=${harnessRepo}`),
      `Builder PTY should launch in the operated-project root.\n  expected cwd=${harnessRepo}\n  got: ${pty.data}`,
    );
    assert.equal(pty.exit.exitCode, 0, 'The fake builder session should exit cleanly (0).');
    log('✓ [7] builder PTY launched in the operated-project root, emitted marker, exited cleanly.');

    // --- Assertion 7b: pane session-state lifecycle truth (issue #63) ----------
    // After the one-shot fake builder exits, main must report the builder pane as
    // `exited` with the real exit code — not a live "running"/"watching" pane — and
    // the renderer must disable the message Send control (no live PTY to deliver to).
    await waitFor(page, 'the builder pane session-state to settle on exited', () =>
      window.godmode.getPtyStates().then((states) => {
        const builder = states.find((s) => s.paneId === 'builder');
        return builder?.lifecycle === 'exited' && builder?.live === false;
      }));
    const sessionTruth = await page.evaluate(async () => {
      const states = await window.godmode.getPtyStates();
      const builder = states.find((s) => s.paneId === 'builder');
      const sendDisabled = document
        .querySelector('button[aria-label="Send message to BUILDER"]')
        ?.hasAttribute('disabled');
      return { lifecycle: builder?.lifecycle, exitCode: builder?.exitCode, sendDisabled };
    });
    assert.equal(sessionTruth.lifecycle, 'exited', 'Builder pane should report `exited` after the one-shot CLI ends.');
    assert.equal(sessionTruth.exitCode, 0, 'Builder pane session-state should carry the real exit code (0).');
    assert.equal(sessionTruth.sendDisabled, true, 'Message Send must be disabled when the pane has no live PTY.');
    log('✓ [7b] builder pane reflects exited session-state; Send disabled with no live PTY.');

    // --- Assertion 8: run + handoff binding -----------------------------------
    // Manual task: creates a run, handoff binds to it, but send is blocked
    // (no GitHub issue → the documented needs_spec routing).
    await page.fill('input[aria-label="Manual task title"]', 'Smoke manual task');
    await page.fill('textarea[aria-label="Manual task description"]', 'Verify manual handoff binding and send-block.');
    await page.click('.manual-task-form button:has-text("Create manual task")');
    await waitFor(page, 'the manual task run to be created', () =>
      window.godmode.getRun().then((r) => r?.sourceType === 'manual_task'));
    const manual = await page.evaluate(async () => {
      const r = await window.godmode.getRun();
      const h = await window.godmode.getHandoff();
      return { status: r?.status, canSend: h.canSend, blockedReason: h.blockedReason };
    });
    assert.equal(manual.status, 'issue_selected', 'A manual task should create a run in issue_selected.');
    assert.equal(manual.canSend, false, 'A manual-task handoff must not be directly sendable.');
    assert.match(
      manual.blockedReason ?? '',
      /needs_spec/i,
      'A blocked manual handoff should document the needs_spec routing.',
    );
    log('✓ [8a] manual task creates a run; handoff binds but send is blocked (needs_spec).');

    // Issue run (no network mutation): selectIssueRun resolves the handoff
    // variables. gh is absent so the issue detail degrades, but the run is still
    // created and the handoff template resolves (issueNumber/issueTitle bound).
    const issue = await page.evaluate(async () => {
      // Clear is guarded terminal-only (issue #41): route the active manual run
      // through cancel (a terminal status) before clearing it.
      await window.godmode.dispatchRun({ action: 'cancel', reason: 'smoke reset' });
      await window.godmode.clearRun();
      const result = await window.godmode.selectIssueRun({ issueNumber: 4242, issueTitle: 'Smoke fixture issue' });
      const h = await window.godmode.getHandoff();
      return { ok: result.ok, sourceType: result.run?.sourceType, canSend: h.canSend, missing: h.missingVariables };
    });
    assert.ok(issue.ok, 'selectIssueRun should create a run.');
    assert.equal(issue.sourceType, 'github_issue', 'An issue run should bind a github_issue source.');
    assert.deepEqual(issue.missing, [], 'An issue handoff should leave no unresolved template variables.');
    assert.equal(issue.canSend, true, 'An issue handoff with resolved variables should be sendable.');
    log('✓ [8b] issue run binds a handoff whose template variables resolve.');
    await page.evaluate(async () => {
      // Guarded clear (issue #41): cancel the active issue run, then clear it.
      await window.godmode.dispatchRun({ action: 'cancel', reason: 'smoke reset' });
      await window.godmode.clearRun();
    });

    // --- Assertion 3 (negative): non-harness dir → missing --------------------
    await page.fill('input[aria-label="Project path"]', nonHarnessDir);
    await page.click('.project-open button:has-text("Open")');
    await waitFor(page, 'harness status to report missing for a non-harness dir', (root) =>
      document.querySelector('.project-id strong')?.textContent === root &&
      Boolean(document.querySelector('.harness-chip.harness-missing')), nonHarnessDir);
    log('✓ [3-] non-harness dir reports harness missing.');

    // --- Assertion 4: dogfooding badge when the app repo is selected ----------
    await page.fill('input[aria-label="Project path"]', appState.root);
    await page.click('.project-open button:has-text("Open")');
    await waitFor(page, 'the dogfooding badge to appear for the app repo', (root) =>
      document.querySelector('.project-id strong')?.textContent === root &&
      Boolean(document.querySelector('.dogfood-badge')), appState.root);
    log('✓ [4] selecting the GodMode app repo shows the dogfooding badge.');

    // Forced mid-run failure injection (exercises diagnostics + teardown).
    if (FORCE_FAIL) {
      throw new Error('Forced mid-run failure (GODMODE_SMOKE_FORCE_FAIL=1).');
    }

    // --- Assertion 9: clean shutdown + no stray processes ---------------------
    await closeApp();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assertNoStrayProcesses({ electronPid, baseDir });
    log('✓ [9] app quit cleanly with no orphaned Electron/PTY processes.');

    log('ALL SMOKE ASSERTIONS PASSED.');
  } catch (error) {
    await captureDiagnostics(page, error);
    await closeApp();
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Post-failure stray check is best-effort: report, but don't mask the cause.
    assertNoStrayProcesses({ electronPid, baseDir, soft: true });
    throw error;
  } finally {
    await closeApp();
    cleanupBaseDir(baseDir);
  }
}

run().then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`\n[smoke] FAILED: ${error?.stack ?? error}\n`);
    process.exit(1);
  },
);
