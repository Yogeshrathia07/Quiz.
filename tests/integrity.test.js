import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { integritySummary, leaveReason } from '../src/domain/integrity.js';
import { attemptView } from '../src/domain/presenters.js';
import { buildTestSpreadsheet } from '../src/export/spreadsheet.js';

test('an attempt from before the lifetime record is summarised from its event log', () => {
  const summary = integritySummary({
    events: [
      { type: 'fullscreen_exit', detail: 'tab_switch' },
      { type: 'fullscreen_return', durationMs: 4_000 },
      { type: 'fullscreen_exit', detail: 'fullscreen' },
      { type: 'fullscreen_return', durationMs: 9_000 },
      { type: 'attempt_locked', detail: 'Left the test 2 times (limit: 2).' }
    ]
  });
  assert.equal(summary.leaveCount, 2);
  assert.equal(summary.awayMs, 13_000);
  assert.equal(summary.longestAwayMs, 9_000);
  assert.equal(summary.lockCount, 1);
  assert.equal(summary.leaves.tab_switch, 1);
  assert.equal(summary.leaves.fullscreen, 1);
});

test('only known leave reasons become counter keys', () => {
  assert.equal(leaveReason('tab_switch'), 'tab_switch');
  assert.equal(leaveReason('$where'), 'fullscreen');
  assert.equal(leaveReason('__proto__'), 'fullscreen');
});

test('reviving refreshes the allowance but keeps lifetime exits and away time visible', () => {
  const attempt = {
    id: 'revived-paper', status: 'in_progress', startedAt: new Date(), submittedAt: null,
    questions: [], answers: [], isLocked: false,
    fullscreenExitCount: 0, fullscreenTotalAbsenceMs: 0,
    integrity: { leaveCount: 4, awayMs: 11_000, longestAwayMs: 7_000, lockCount: 1, leaves: { focus_lost: 4 }, flags: {} }
  };
  const view = attemptView({ code: 'REVIVE', title: 'Revive check', untimed: true, questionCount: 0, fullscreenExitLimit: 3, fullscreenAbsenceLimitSeconds: 10 }, attempt);
  assert.equal(view.fullscreenExitCount, 0);
  assert.equal(view.fullscreenTotalAbsenceMs, 0);
  assert.equal(view.timesLeft, 4);
  assert.equal(view.timeAwayMs, 11_000);
});

test('the export carries the integrity counts and a per-event log', async () => {
  const integrity = integritySummary({ integrity: { leaveCount: 3, awayMs: 12_000, longestAwayMs: 8_000, lockCount: 1, leaves: { tab_switch: 3 }, flags: { paste: 2 } } });
  const file = await buildTestSpreadsheet({
    test: { title: 'Integrity quiz', code: 'TEST-INTEG' },
    registrations: [{
      name: 'Student One', email: 'one@stu.upes.ac.in', sapId: '50000001', status: 'approved', requestedAt: null,
      attemptStatus: 'submitted', startedAt: null, submittedAt: null, answeredCount: 1, score: 1,
      fullscreenExitCount: 0, fullscreenTotalAbsenceMs: 0, isLocked: false, lockReason: '', integrity
    }],
    responses: [],
    integrityLog: [{
      studentName: 'Student One', email: 'one@stu.upes.ac.in', sapId: '50000001',
      label: 'Switched app or tab', createdAt: '2026-09-20T10:06:00.000Z', durationMs: null, detail: null
    }]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  const results = workbook.getWorksheet('Results');
  assert.equal(results.getCell('O4').value, 'Times left the test (total)');
  assert.equal(results.getCell('O5').value, 3, 'revive-proof total, not the lock counter');
  assert.equal(results.getCell('W4').value, 'Went offline');
  assert.equal(results.getCell('X5').value, 2, 'copy / cut / paste attempts');
  assert.equal(workbook.getWorksheet('Integrity log').getCell('E5').value, 'Switched app or tab');
});
