import test from 'node:test';
import assert from 'node:assert/strict';
import { clampExamSplit, DEFAULT_EXAM_SPLIT, examSplitAtPointer, examSplitLimits } from '../client/src/screens/student/exam-split.js';

test('wide paper allows roughly 30 percentage points of travel either way', () => {
  assert.deepEqual(examSplitLimits(1800), { min: 20, max: 80 });
  assert.equal(clampExamSplit(5, examSplitLimits(1800)), 20);
  assert.equal(clampExamSplit(95, examSplitLimits(1800)), 80);
});

test('tablet and landscape phone keep both panes readable', () => {
  for (const width of [550, 620, 900, 1050]) {
    const limits = examSplitLimits(width);
    const room = Math.min(1, Math.max(0, (width - 600) / 300));
    const questionMin = 210 + 90 * room;
    const answerMin = 210 + 130 * room;
    assert.ok(width * limits.min / 100 >= questionMin - 0.001);
    assert.ok(width * (100 - limits.max) / 100 >= answerMin - 0.001);
    assert.ok(limits.min <= DEFAULT_EXAM_SPLIT && limits.max >= DEFAULT_EXAM_SPLIT);
  }
});

test('pane minimums change smoothly across a tablet breakpoint', () => {
  const before = examSplitLimits(799);
  const after = examSplitLimits(800);
  assert.ok(Math.abs(before.min - after.min) < 1);
  assert.ok(Math.abs(before.max - after.max) < 1);
});

test('very narrow landscape screens pin the divider to the centre', () => {
  assert.deepEqual(examSplitLimits(400), { min: 50, max: 50 });
  assert.equal(clampExamSplit(DEFAULT_EXAM_SPLIT, examSplitLimits(400)), 50);
});

test('pointer geometry accounts for the divider width and clamps both edges', () => {
  const limits = examSplitLimits(1000);
  assert.equal(examSplitAtPointer(612, 100, 1000, 24, limits), 50);
  assert.equal(examSplitAtPointer(-100, 100, 1000, 24, limits), limits.min);
  assert.equal(examSplitAtPointer(2000, 100, 1000, 24, limits), limits.max);
});
