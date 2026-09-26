import assert from 'node:assert/strict';
import test from 'node:test';
import { leavingWarningState } from '../client/src/screens/student/leaving-rules.js';

test('away-time allowance glows during its final twenty percent', () => {
  const calm = leavingWarningState({ fullscreenExitCount: 0, fullscreenExitLimit: 3, fullscreenTotalAbsenceMs: 39_000, fullscreenAbsenceLimitSeconds: 60 });
  const low = leavingWarningState({ fullscreenExitCount: 0, fullscreenExitLimit: 3, fullscreenTotalAbsenceMs: 50_000, fullscreenAbsenceLimitSeconds: 60 });
  assert.equal(calm.awayLow, false);
  assert.equal(low.awayLow, true);
  assert.equal(low.remainingAwayMs, 10_000);
});

test('a revived allowance is calm even when its lifetime record is high', () => {
  const state = leavingWarningState({
    timesLeft: 8, timeAwayMs: 90_000,
    fullscreenExitCount: 0, fullscreenExitLimit: 3,
    fullscreenTotalAbsenceMs: 0, fullscreenAbsenceLimitSeconds: 60
  });
  assert.equal(state.low, false);
  assert.equal(state.over, false);
});

test('using the last permitted exit triggers the breathing warning', () => {
  const state = leavingWarningState({ fullscreenExitCount: 3, fullscreenExitLimit: 3, fullscreenTotalAbsenceMs: 0, fullscreenAbsenceLimitSeconds: 60 });
  assert.equal(state.exitsLow, true);
  assert.equal(state.low, true);
});
