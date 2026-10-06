import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildStudentResponseSpreadsheet, buildTestSpreadsheet } from '../src/export/spreadsheet.js';

test('the Excel export includes a response-level analysis sheet', async () => {
  const file = await buildTestSpreadsheet({
    test: { title: 'Algorithms quiz', code: 'TEST-EXPORT' },
    registrations: [{
      name: 'Student One', email: 'student@stu.upes.ac.in', sapId: '5001', status: 'approved', requestedAt: '2026-09-20T10:00:00.000Z',
      attemptStatus: 'submitted', startedAt: '2026-09-20T10:05:00.000Z', submittedAt: '2026-09-20T10:10:00.000Z', answeredCount: 1,
      score: 1, fullscreenExitCount: 0, fullscreenTotalAbsenceMs: 0, isLocked: false, lockReason: ''
    }],
    responses: [{
      studentName: 'Student One', email: 'student@stu.upes.ac.in', sapId: '5001', attemptStatus: 'submitted', submittedAt: '2026-09-20T10:10:00.000Z',
      questionNumber: 1, type: 'short', prompt: 'Explain a stack.', selectedAnswer: 'A last-in, first-out collection.', correctAnswer: '',
      manualGrading: true, answered: true, isCorrect: null, marks: null, maxMarks: 2, answeredAt: '2026-09-20T10:06:00.000Z'
    }]
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  const responses = workbook.getWorksheet('Responses');
  assert.ok(responses);
  assert.equal(responses.getCell('A4').value, 'Student');
  assert.equal(responses.getCell('H5').value, 'Explain a stack.');
  assert.equal(responses.getCell('I5').value, 'A last-in, first-out collection.');
  // Marks earned (none yet), out of what the question is worth, and where it stands.
  assert.equal(responses.getCell('K4').value, 'Marks');
  assert.equal(responses.getCell('L5').value, 2);
  assert.equal(responses.getCell('M5').value, 'Awaiting manual mark');
  assert.ok(workbook.getWorksheet('Marks'), 'and a Marks sheet to mark in');
});

const onePaper = () => ({
    test: {
      title: 'Algorithms quiz', code: 'TEST-AUDIT',
      startsAt: '2026-09-20T10:00:00.000Z', endsAt: '2026-09-20T10:30:00.000Z', closedAt: '2026-09-20T10:31:00.000Z'
    },
    student: { name: 'Student One', email: 'student@stu.upes.ac.in', sapId: '40004711' },
    registration: { status: 'approved', requestedAt: '2026-09-20T09:55:00.000Z', decidedAt: '2026-09-20T09:57:00.000Z' },
    attempt: {
      status: 'submitted', startedAt: '2026-09-20T10:01:00.000Z', submittedAt: '2026-09-20T10:20:00.000Z',
      submittedBy: 'student', locked: false, lockReason: null
    },
    integrity: {
      leaveCount: 1, awayMs: 8_000, longestAwayMs: 8_000, lockCount: 0,
      flags: { copy: 1, cut: 0, paste: 0, screenshot: 0, print: 0, devtools: 0 },
      events: [{
        createdAt: '2026-09-20T10:08:00.000Z', label: 'Left fullscreen', type: 'fullscreen_exit', detail: 'tab_switch', durationMs: 8_000
      }]
    },
    activity: [{
      at: '2026-09-20T10:05:00.000Z', label: 'Answered Q1', kind: 'answer', detail: 'Queue', durationMs: null
    }],
    location: {
      inRange: 3, outOfRange: 1, inconclusive: 0, outsideCount: 1, outsideMs: 5_000,
      last: { status: 'inRange', distanceMeters: 12, checkedAt: '2026-09-20T10:19:00.000Z', trigger: 'submit' },
      submit: { status: 'inRange', distanceMeters: 12, checkedAt: '2026-09-20T10:20:00.000Z' }
    },
    answers: [{
      questionNumber: 1, type: 'mcq', prompt: 'Which structure is FIFO?', selectedAnswer: 'Queue', correctAnswer: 'Queue',
      answered: true, manualGrading: false, isCorrect: true
    }],
    summary: { total: 1, score: 1, correct: 1, incorrect: 0, unanswered: 0, ungraded: 0 }
});
const load = async (file) => { const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file); return workbook; };
const rowWith = (sheet, text) => { let found = null; sheet.eachRow((row) => { if (!found && row.values.includes(text)) found = row; }); return found; };
// The row whose label (first column) is `label`.
const labelled = (sheet, label) => { let found = null; sheet.eachRow((row) => { if (!found && row.getCell(1).value === label) found = row; }); return found; };

test('a student downloading their own paper gets only their responses and their test record', async () => {
  const workbook = await load(await buildStudentResponseSpreadsheet(onePaper()));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['My responses', 'Test record']);
  const sheet = workbook.getWorksheet('My responses');
  assert.equal(sheet.getCell('A1').value, 'Algorithms quiz');
  assert.equal(sheet.getCell('A5').value, '1 / 1', 'the score tile');
  const header = rowWith(sheet, 'Your answer');
  assert.ok(header, 'the question table');
  const first = sheet.getRow(header.number + 1);
  assert.equal(first.getCell(3).value, 'Which structure is FIFO?');
  assert.equal(first.getCell(6).value, 'Correct');
  assert.equal(first.getCell(6).fill.fgColor.argb, 'FFDCF5E7', 'a correct answer is green');
  const record = workbook.getWorksheet('Test record');
  const submitted = labelled(record, 'Submitted');
  const expected = new Date('2026-09-20T10:20:00.000Z');
  // Written in local time, so Excel shows the time the student saw.
  assert.equal(submitted.getCell(2).value.getTime(), expected.getTime() - expected.getTimezoneOffset() * 60_000);
  assert.ok(!rowWith(record, 'Copy, cut or paste attempts'), 'no audit detail for the student');
});

test('the Users page audit download adds the complete activity, integrity and location evidence', async () => {
  const workbook = await load(await buildStudentResponseSpreadsheet(onePaper(), { audit: true }));
  assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), [
    'My responses', 'Test record', 'Activity log', 'Integrity log', 'Location checks', 'Locations'
  ]);
  assert.ok(rowWith(workbook.getWorksheet('Test record'), 'Test date'));
  assert.ok(rowWith(workbook.getWorksheet('Test record'), 'Copy, cut, paste or drag attempts'));
  assert.ok(!rowWith(workbook.getWorksheet('Test record'), 'Text that appeared all at once'), 'a check taken out (RETIRED_FLAGS) has no row');
  assert.equal(workbook.getWorksheet('Activity log').getCell('B5').value, 'Answered Q1');
  assert.equal(workbook.getWorksheet('Integrity log').getCell('C5').value, 'fullscreen_exit');
  assert.equal(workbook.getWorksheet('Location checks').getCell('B5').value, 3);
});

test('the audit download lists every location reading, with a map link', async () => {
  const data = onePaper();
  data.locationTrail = [
    { at: '2026-10-05T04:30:00.000Z', trigger: 'start', status: 'inRange', latitude: 30.3166, longitude: 78.0322, accuracyMeters: 15, distanceMeters: 11 },
    { at: '2026-10-05T04:31:00.000Z', trigger: 'timer', status: 'inconclusive', latitude: null, longitude: null, accuracyMeters: null, distanceMeters: null }
  ];
  const sheet = (await load(await buildStudentResponseSpreadsheet(data, { audit: true }))).getWorksheet('Locations');
  assert.deepEqual([sheet.getCell('B5').value, sheet.getCell('C5').value, sheet.getCell('F5').value, sheet.getCell('G5').value], [30.3166, 78.0322, 'At the venue', 'Began']);
  assert.equal(sheet.getCell('H5').value.hyperlink, 'https://www.google.com/maps?q=30.3166,78.0322');
  assert.equal(sheet.getCell('H6').value, 'No reading');
  // A student's own download has none of it.
  assert.equal((await load(await buildStudentResponseSpreadsheet(data))).getWorksheet('Locations'), undefined);
});
