// Tests for the review/fix loop config resolver (issue #39 §5). Conservative
// defaults must preserve today's behavior: auto + autoSendFix off unless a project
// explicitly opts in, and maxCycles falls back to the standard budget.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG, resolveLoopConfig } from '../dist/main/config.js';

test('resolveLoopConfig defaults are conservative (manual, no auto-send, budget 3)', () => {
  const resolved = resolveLoopConfig({ ...DEFAULT_CONFIG, loop: undefined });
  assert.deepEqual(resolved, { auto: false, autoSendFix: false, maxCycles: 3 });
});

test('resolveLoopConfig honors an explicit opt-in block', () => {
  const resolved = resolveLoopConfig({ ...DEFAULT_CONFIG, loop: { auto: true, autoSendFix: true, maxCycles: 5 } });
  assert.deepEqual(resolved, { auto: true, autoSendFix: true, maxCycles: 5 });
});

test('resolveLoopConfig treats only an exact `true` as enabling (no truthy coercion)', () => {
  const resolved = resolveLoopConfig({ ...DEFAULT_CONFIG, loop: { auto: false, maxCycles: 2 } });
  assert.equal(resolved.auto, false);
  assert.equal(resolved.autoSendFix, false);
  assert.equal(resolved.maxCycles, 2);
});

test('DEFAULT_CONFIG itself resolves to manual mode (regression-safe default)', () => {
  const resolved = resolveLoopConfig(DEFAULT_CONFIG);
  assert.equal(resolved.auto, false);
  assert.equal(resolved.autoSendFix, false);
});
