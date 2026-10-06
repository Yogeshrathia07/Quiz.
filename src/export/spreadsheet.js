import ExcelJS from 'exceljs';
import { integrityCells, integrityHeaders } from '../domain/integrity.js';
import { oneLine, plainText } from '../domain/rich-text.js';

/**
 * The admin's Excel export. One workbook, one sheet per question you might ask
 * of a finished test:
 *
 *   Overview           how the class did, in a dozen numbers
 *   Results            one row per student: marks, timing, integrity
 *   Marks              one row per paper, one column per question - marks
 *                      typed into its short-answer cells upload back
 *   Answer grid        one row per student, one column per question - what
 *                      each student answered and whether it was right
 *   Question analysis  one row per question: how many got it right, and the
 *                      wrong answer most of them chose
 *   Responses          one row per student per question, with timings
 *   Integrity log      every departure, return, flag and lock, in order
 */

// The app's own palette, on a light sheet: a dark title band, the app's blue
// for headers, soft stripes and colour only where it means something.
const INK = 'FF1F2A37';
const MUTED = 'FF5B6775';
const BRAND = 'FF1488BC';
const DEEP = 'FF1F2A37';
const SOFT = 'FFEAF4FA';
const LABEL = 'FFF1F4F7';
const ZEBRA = 'FFF7F9FB';
const LINE = 'FFD9E0E6';
const FILL = {
  correct: 'FFDCF5E7',
  wrong: 'FFFBE1E1',
  pending: 'FFFFF2CC',
  // Part of a question's marks (a short answer marked so).
  partial: 'FFEAF5D3',
  blank: 'FFEFF1F4',
  notAsked: 'FFFFFFFF'
};
// Text on those fills, a shade darker so the word stands out, not just the colour.
const TEXT = { correct: 'FF15803D', wrong: 'FFB91C1C', pending: 'FFB45309', partial: 'FF4D7C0F', blank: 'FF4B5563', notAsked: INK };

const headers = [
  'Name', 'College email', 'SAP ID', 'Registration status', 'Requested at',
  'Attempt status', 'Started at', 'Submitted at', 'Answered', 'Marks',
  'Fullscreen exits', 'Time outside fullscreen (seconds)', 'Attempt locked', 'Lock reason',
  ...integrityHeaders,
  'Questions on paper', 'Out of (marks)', 'Percentage', 'Time taken (minutes)', 'Rank'
];
const responseHeaders = [
  'Student', 'College email', 'SAP ID', 'Attempt status', 'Submitted at',
  'Question no.', 'Question type', 'Question', 'Student answer', 'Correct answer',
  'Marks', 'Out of', 'Mark status', 'Answered at', 'Answered after (minutes)',
  'Time allowed (s)', 'Time spent (s)', 'Timed out'
];
const columnWidths = [22, 30, 15, 18, 22, 18, 22, 22, 11, 9, 16, 31, 16, 32, ...integrityHeaders.map(() => 16), 14, 12, 12, 16, 8];
const responseColumnWidths = [22, 30, 15, 16, 22, 13, 16, 42, 38, 38, 9, 8, 22, 22, 16, 14, 14, 11];
const logHeaders = ['Student', 'College email', 'SAP ID', 'When', 'What happened', 'Time away (seconds)', 'Detail'];
const logColumnWidths = [22, 30, 15, 22, 34, 18, 48];

// Excel shows a date exactly as stored, and the library stores UTC - so a
// paper handed in at 8:42 pm in India read 3:12 pm. Shift to this server's
// local time (the time everyone in the room sees) before writing.
const asDate = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
};
const minutesBetween = (from, to) => (from && to ? Math.round((new Date(to) - new Date(from)) / 600) / 100 : '');
const percent = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : '');
const clip = (text, length) => (String(text || '').length > length ? `${String(text).slice(0, length - 1)}…` : String(text || ''));

const thin = { style: 'thin', color: { argb: LINE } };
const box = { top: thin, left: thin, bottom: thin, right: thin };

function styleHeader(row) {
  row.height = 30;
  row.eachCell((cell) => {
    cell.font = { name: 'Aptos', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { top: { style: 'thin', color: { argb: BRAND } }, left: { style: 'thin', color: { argb: 'FF3AA5D6' } }, right: { style: 'thin', color: { argb: 'FF3AA5D6' } }, bottom: { style: 'thin', color: { argb: BRAND } } };
  });
}

/** Body rows: thin borders, and every other row softly striped (a cell already coloured keeps its colour). */
function styleDataRows(sheet, firstRow, rowCount) {
  for (let rowNumber = firstRow; rowNumber < firstRow + rowCount; rowNumber += 1) {
    const striped = (rowNumber - firstRow) % 2 === 1;
    sheet.getRow(rowNumber).eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: 'Aptos', size: 10, color: { argb: INK }, ...(cell.font?.bold ? { bold: true } : {}), ...(cell.font?.color && cell.font.color.argb !== INK ? { color: cell.font.color } : {}) };
      cell.alignment = { vertical: 'middle', wrapText: true, ...(cell.alignment?.horizontal ? { horizontal: cell.alignment.horizontal } : {}) };
      cell.border = box;
      if (striped && !(cell.fill && cell.fill.pattern === 'solid')) paint(cell, ZEBRA);
    });
  }
}

const paint = (cell, argb) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; };

const exportedAt = () => new Date().toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/** A dark title band and a light line under it, across `width` columns. */
function banner(sheet, title, subtitle, width) {
  for (let column = 1; column <= width; column += 1) {
    paint(sheet.getRow(1).getCell(column), DEEP);
    paint(sheet.getRow(2).getCell(column), SOFT);
  }
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { name: 'Aptos', size: 16, bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
  sheet.getCell('A2').value = subtitle;
  sheet.getCell('A2').font = { name: 'Aptos', size: 10, color: { argb: MUTED } };
  sheet.getCell('A2').alignment = { vertical: 'middle', indent: 1 };
  sheet.getRow(1).height = 34;
  sheet.getRow(2).height = 22;
  sheet.properties.tabColor = { argb: BRAND };
  sheet.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
}

/** Title, test code and export time above every sheet's table. */
function sheetTitle(workbook, name, title, test, width = 8) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 4, showGridLines: false }] });
  banner(sheet, title, `Test code: ${test.code}  ·  Exported: ${exportedAt()}`, width);
  return sheet;
}

function emptyNote(sheet, text) {
  sheet.getCell('A5').value = text;
  sheet.getCell('A5').font = { name: 'Aptos', size: 10, italic: true, color: { argb: MUTED } };
}

function answerStatus(response) {
  if (response.overridden) return `Marked by teacher (${response.marks} of ${response.maxMarks})`;
  if (!response.answered) return 'Not answered';
  if (response.manualGrading) {
    if (response.isCorrect === null) return 'Awaiting manual mark';
    if (response.partial) return 'Manual part marks';
    return response.isCorrect ? 'Manual correct' : 'Manual incorrect';
  }
  return response.isCorrect ? 'Correct' : 'Incorrect';
}

const statusFill = (response) => {
  if (!response) return FILL.notAsked;
  if (!response.answered) return FILL.blank;
  if (response.isCorrect === null) return FILL.pending;
  if (response.partial) return FILL.partial;
  return response.isCorrect ? FILL.correct : FILL.wrong;
};

/** Standard competition ranking (1, 2, 2, 4) over submitted scores, best first. */
function ranks(registrations) {
  const scores = registrations.filter((entry) => entry.attemptStatus === 'submitted').map((entry) => Number(entry.score) || 0);
  return (score) => (score === null || score === undefined ? '' : 1 + scores.filter((other) => other > score).length);
}

/* ---------------------------------------------------------------- sheets */

function overviewSheet(workbook, dashboard) {
  const { test, registrations } = dashboard;
  const sheet = sheetTitle(workbook, 'Overview', `${test.title} — overview`, test);
  const submitted = registrations.filter((entry) => entry.attemptStatus === 'submitted');
  const scores = submitted.map((entry) => Number(entry.score) || 0).sort((a, b) => a - b);
  const questionsPerPaper = Math.max(0, ...submitted.map((entry) => entry.totalQuestions || 0));
  // Full marks per paper (domain/marks.js): the most any paper is worth.
  const outOf = Math.max(0, ...submitted.map((entry) => entry.totalMarks || 0));
  const average = scores.length ? scores.reduce((total, value) => total + value, 0) / scores.length : null;
  const median = scores.length ? (scores[Math.floor((scores.length - 1) / 2)] + scores[Math.ceil((scores.length - 1) / 2)]) / 2 : null;
  const times = submitted.map((entry) => minutesBetween(entry.startedAt, entry.submittedAt)).filter((value) => value !== '');
  const leftOnce = registrations.filter((entry) => entry.integrity?.leaveCount > 0).length;
  const round = (value) => (value === null ? '—' : Math.round(value * 100) / 100);

  const rows = [
    ['Registered', registrations.length],
    ['Approved', registrations.filter((entry) => entry.status === 'approved').length],
    ['Started the test', registrations.filter((entry) => entry.attemptStatus).length],
    ['Submitted', submitted.length],
    ['Still in progress', registrations.filter((entry) => entry.attemptStatus === 'in_progress').length],
    ['Questions per paper', questionsPerPaper || '—'],
    ['Full marks per paper', outOf || '—'],
    ['Average marks', round(average)],
    ['Average percentage', average === null || !outOf ? '—' : `${percent(average, outOf)}%`],
    ['Median marks', round(median)],
    ['Highest marks', scores.length ? scores[scores.length - 1] : '—'],
    ['Lowest marks', scores.length ? scores[0] : '—'],
    ['Average time taken (minutes)', times.length ? round(times.reduce((total, value) => total + value, 0) / times.length) : '—'],
    ['Students who left the test at least once', leftOnce],
    ['Attempts locked right now', registrations.filter((entry) => entry.isLocked).length],
    ['Started', test.startedAt ? new Date(test.startedAt).toLocaleString() : 'Not started'],
    ['Time limit', test.untimed ? 'No end time (closed by the administrator)'
      : test.endsAt ? `Ends ${new Date(test.endsAt).toLocaleString()}` : `${test.durationMinutes} minutes from the start`],
    ['How it ended', !test.isClosed ? 'Still open' : test.closedAutomatically ? 'Automatically at the end time' : 'Closed by the administrator']
  ];
  const headerRow = sheet.getRow(4);
  headerRow.values = ['Measure', 'Value'];
  styleHeader(headerRow);
  rows.forEach((row) => sheet.addRow(row));
  styleDataRows(sheet, 5, rows.length);
  sheet.getColumn(1).width = 42;
  sheet.getColumn(2).width = 44;
}

function resultsSheet(workbook, dashboard) {
  const { test, registrations } = dashboard;
  const sheet = sheetTitle(workbook, 'Results', test.title, test);
  const rankOf = ranks(registrations);
  const rows = registrations.map((registration) => [
    registration.name,
    registration.email,
    registration.sapId,
    registration.status,
    asDate(registration.requestedAt),
    registration.attemptStatus || '',
    asDate(registration.startedAt),
    asDate(registration.submittedAt),
    registration.answeredCount,
    registration.score ?? '',
    registration.fullscreenExitCount,
    Math.round((registration.fullscreenTotalAbsenceMs || 0) / 1000),
    registration.isLocked ? 'Yes' : 'No',
    registration.lockReason || '',
    ...integrityCells(registration.integrity),
    registration.totalQuestions || '',
    registration.totalMarks ?? '',
    registration.score === null || registration.score === undefined ? '' : percent(registration.score, registration.totalMarks),
    minutesBetween(registration.startedAt, registration.submittedAt),
    registration.attemptStatus === 'submitted' ? rankOf(registration.score) : ''
  ]);
  const headerRow = sheet.getRow(4);
  headerRow.values = headers;
  styleHeader(headerRow);
  if (rows.length) {
    rows.forEach((row) => sheet.addRow(row));
    styleDataRows(sheet, 5, rows.length);
  } else {
    emptyNote(sheet, 'No registrations were recorded for this test.');
  }
  columnWidths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  [5, 7, 8].forEach((column) => { sheet.getColumn(column).numFmt = 'yyyy-mm-dd hh:mm'; });
}

/**
 * Students down, questions across. Each student drew their own set from the
 * bank, so a question they were not given is left white; otherwise the cell
 * holds their answer, coloured by its mark.
 */
function answerGridSheet(workbook, dashboard) {
  const { test, registrations } = dashboard;
  const bank = dashboard.questionBank || [];
  const sheet = sheetTitle(workbook, 'Answer grid', `${test.title} — every answer, side by side`, test);
  sheet.getCell('A3').value = 'Green: full marks · Light green: part marks · Red: no marks · Yellow: awaiting manual mark · Grey: left blank · White: not on this student’s paper';
  sheet.getCell('A3').font = { name: 'Aptos', size: 9, italic: true, color: { argb: MUTED } };
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: 4, showGridLines: false }];

  const byStudent = new Map();
  for (const response of dashboard.responses || []) {
    const key = response.registrationId || response.email;
    if (!byStudent.has(key)) byStudent.set(key, new Map());
    byStudent.get(key).set(response.questionId, response);
  }

  const headerRow = sheet.getRow(4);
  headerRow.values = ['Student', 'SAP ID', 'Marks', ...bank.map((question) => `Q${question.number} (${question.type.toUpperCase()}, ${question.maxMarks} mark${question.maxMarks === 1 ? '' : 's'}${question.retired ? ', old version' : ''}): ${clip(oneLine(question.prompt), 60)}`)];
  styleHeader(headerRow);
  headerRow.height = 60;

  const keyRow = sheet.addRow(['Answer key', '', '', ...bank.map((question) => (question.manualGrading ? 'Marked by hand' : question.correctAnswer))]);
  keyRow.eachCell((cell) => {
    cell.font = { name: 'Aptos', size: 9, bold: true, color: { argb: 'FF107044' } };
    cell.alignment = { vertical: 'top', wrapText: true };
  });

  const students = registrations.filter((registration) => registration.attemptStatus);
  students.forEach((registration) => {
    const answers = byStudent.get(registration.id) || byStudent.get(registration.email) || new Map();
    const row = sheet.addRow([
      registration.name,
      registration.sapId,
      registration.score === null || registration.score === undefined ? '' : `${registration.score} / ${registration.totalMarks}`,
      ...bank.map((question) => {
        const response = answers.get(question.id);
        if (!response) return '';
        const mark = response.isCorrect === null ? '' : response.partial ? ` (${response.marks}/${response.maxMarks})` : response.isCorrect ? ' ✓' : ' ✗';
        return response.answered ? `${response.selectedAnswer}${mark}` : '(blank)';
      })
    ]);
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cell.font = { name: 'Aptos', size: 10, color: { argb: INK } };
      cell.alignment = { vertical: 'top', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFE7E7EB' } }, right: { style: 'thin', color: { argb: 'FFE7E7EB' } } };
      if (column > 3) paint(cell, statusFill(answers.get(bank[column - 4]?.id)));
    });
  });
  if (!students.length) emptyNote(sheet, 'Nobody has started this test yet.');
  sheet.getColumn(1).width = 24;
  sheet.getColumn(2).width = 13;
  sheet.getColumn(3).width = 10;
  bank.forEach((_question, index) => { sheet.getColumn(index + 4).width = 26; });
}

/** Per question: who saw it, who got it right, and the favourite wrong answer. */
function questionAnalysisSheet(workbook, dashboard) {
  const { test } = dashboard;
  const bank = dashboard.questionBank || [];
  const sheet = sheetTitle(workbook, 'Question analysis', `${test.title} — question by question`, test);
  const headerRow = sheet.getRow(4);
  headerRow.values = [
    'Q no.', 'Type', 'Question', 'Correct answer', 'On how many papers', 'Answered', 'Left blank',
    'Correct', 'Part marks', 'Incorrect', 'Awaiting mark', '% correct (of those who got it)', 'Most common wrong answer', 'Chosen by'
  ];
  styleHeader(headerRow);

  const responses = dashboard.responses || [];
  bank.forEach((question) => {
    const forQuestion = responses.filter((response) => response.questionId === question.id);
    const answered = forQuestion.filter((response) => response.answered);
    const correct = answered.filter((response) => response.isCorrect === true).length;
    // Part marks (a short answer marked so) are neither right nor wrong.
    const partial = answered.filter((response) => response.partial).length;
    const incorrect = answered.filter((response) => response.isCorrect === false && !response.partial);
    const pending = answered.filter((response) => response.isCorrect === null).length;
    const wrongCounts = new Map();
    if (!question.manualGrading) incorrect.forEach((response) => wrongCounts.set(response.selectedAnswer, (wrongCounts.get(response.selectedAnswer) || 0) + 1));
    const [topWrong, topWrongCount] = [...wrongCounts.entries()].sort((a, b) => b[1] - a[1])[0] || ['', ''];
    const row = sheet.addRow([
      question.number,
      question.type.toUpperCase(),
      plainText(question.prompt),
      question.manualGrading ? 'Marked by hand' : question.correctAnswer,
      forQuestion.length,
      answered.length,
      forQuestion.length - answered.length,
      correct,
      partial,
      incorrect.length,
      pending,
      forQuestion.length ? percent(correct, forQuestion.length) : '',
      topWrong,
      topWrongCount
    ]);
    const share = forQuestion.length ? correct / forQuestion.length : null;
    if (share !== null) paint(row.getCell(12), share >= 0.7 ? FILL.correct : share >= 0.4 ? FILL.pending : FILL.wrong);
  });
  if (bank.length) styleDataRows(sheet, 5, bank.length);
  else emptyNote(sheet, 'This test has no questions.');
  [7, 8, 46, 34, 14, 11, 11, 10, 11, 11, 12, 16, 34, 10].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
}

function responsesSheet(workbook, dashboard) {
  const { test } = dashboard;
  const sheet = sheetTitle(workbook, 'Responses', `${test.title} — answer details`, test);
  const responses = dashboard.responses || [];
  const headerRow = sheet.getRow(4);
  headerRow.values = responseHeaders;
  styleHeader(headerRow);
  if (responses.length) {
    responses.forEach((response) => {
      const mark = response.marks ?? '';
      const row = sheet.addRow([
        response.studentName,
        response.email,
        response.sapId,
        response.attemptStatus,
        asDate(response.submittedAt),
        response.questionNumber,
        String(response.type || '').toUpperCase(),
        plainText(response.prompt),
        response.selectedAnswer,
        response.manualGrading ? 'Manual review' : response.correctAnswer,
        mark,
        response.maxMarks ?? '',
        answerStatus(response),
        asDate(response.answeredAt),
        minutesBetween(response.startedAt, response.answeredAt),
        // Strict timing only; blank on tests where students move freely.
        response.timeAllowedSeconds ?? (response.timeSpentSeconds !== undefined ? 'No limit' : ''),
        response.timeSpentSeconds ?? '',
        response.timedOut === undefined || response.timedOut === null ? '' : response.timedOut ? 'Yes' : 'No'
      ]);
      if (response.timedOut) paint(row.getCell(18), FILL.wrong);
      paint(row.getCell(13), statusFill(response));
    });
    styleDataRows(sheet, 5, responses.length);
  } else {
    emptyNote(sheet, 'No attempt responses were recorded for this test.');
  }
  responseColumnWidths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.getColumn(5).numFmt = 'yyyy-mm-dd hh:mm';
  sheet.getColumn(14).numFmt = 'yyyy-mm-dd hh:mm';
}

/** Every departure, return, flag and lock, in order - the evidence behind the counts. */
function integrityLogSheet(workbook, dashboard) {
  const { test } = dashboard;
  const sheet = sheetTitle(workbook, 'Integrity log', `${test.title} — integrity log`, test);
  const log = dashboard.integrityLog || [];
  const headerRow = sheet.getRow(4);
  headerRow.values = logHeaders;
  styleHeader(headerRow);
  if (log.length) {
    log.forEach((entry) => sheet.addRow([
      entry.studentName,
      entry.email,
      entry.sapId,
      asDate(entry.createdAt),
      entry.label,
      entry.durationMs === null || entry.durationMs === undefined ? '' : Math.round(entry.durationMs / 1000),
      entry.detail || ''
    ]));
    styleDataRows(sheet, 5, log.length);
  } else {
    emptyNote(sheet, 'Nobody left the test.');
  }
  logColumnWidths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.getColumn(4).numFmt = 'yyyy-mm-dd hh:mm:ss';
}

/** Every student's test, minute by minute: joining, each answer and change, each exit and return, submitting. */
function activitySheet(workbook, dashboard) {
  const { test } = dashboard;
  const sheet = sheetTitle(workbook, 'Activity log', `${test.title} — every student, minute by minute`, test);
  const rows = dashboard.activity || [];
  const headerRow = sheet.getRow(4);
  headerRow.values = ['Student', 'College email', 'SAP ID', 'Time', 'What happened', 'Details', 'Away (seconds)'];
  styleHeader(headerRow);
  if (rows.length) {
    rows.forEach((entry) => sheet.addRow([
      entry.studentName,
      entry.email,
      entry.sapId,
      asDate(entry.at),
      entry.label,
      entry.detail || '',
      entry.durationMs === null || entry.durationMs === undefined ? '' : Math.round(entry.durationMs / 1000)
    ]));
    styleDataRows(sheet, 5, rows.length);
  } else {
    emptyNote(sheet, 'No activity was recorded for this test.');
  }
  [26, 32, 14, 20, 34, 44, 14].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.getColumn(4).numFmt = 'yyyy-mm-dd hh:mm:ss';
  sheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 7 } };
}

/* ------------------------------------------ the Marks sheet: marking in Excel */

/**
 * The Marks sheet, its hidden row naming each column, and the hidden copy of
 * the marks as exported - all read back by services/marks-import.js.
 */
export const MARKS_SHEET = 'Marks';
export const MARKS_BASE_SHEET = 'Marks as exported';
export const MARKS_KEY_ROW = 5;
const MARKS_FIRST_QUESTION = 6;
const MARKS_EDITABLE = 'FFFFFBEA';

/**
 * One row per handed-in paper, one column per question: the marks each answer
 * earned, any of them changed here and uploaded on the test's Results tab
 * (services/marks-import.js); short answers still to mark are yellow. A hidden last column
 * and a hidden row name each student and question, so the file finds its way
 * back even with its rows sorted, and a hidden sheet keeps the marks as they
 * were exported: the upload changes only what was typed over them, so a mark
 * given in the app since is not undone by an older file. Total adds the row up
 * as marks are typed.
 */
function marksSheet(workbook, dashboard) {
  const { test } = dashboard;
  const bank = dashboard.questionBank || [];
  const lastQuestion = MARKS_FIRST_QUESTION - 1 + bank.length;
  const idColumn = lastQuestion + 1;
  const sheet = sheetTitle(workbook, MARKS_SHEET, `${test.title} — marks`, test, Math.max(8, lastQuestion));
  sheet.getCell('A3').value = 'Change any mark - yellow cells are short answers still to mark - then upload this file on the test’s Results tab. A choice question’s mark you change becomes your own; type its automatic mark to go back to that.';
  sheet.getCell('A3').font = { name: 'Aptos', size: 9, italic: true, color: { argb: MUTED } };
  sheet.views = [{ state: 'frozen', xSplit: 3, ySplit: MARKS_KEY_ROW, showGridLines: false }];

  const headerRow = sheet.getRow(4);
  headerRow.values = ['Student', 'SAP ID', 'College email', 'Total', 'Out of', ...bank.map((question) => (
    `Q${question.number} · ${question.manualGrading ? 'short answer' : question.type.toUpperCase()} · out of ${question.maxMarks}${question.retired ? ' (old version)' : ''}`
  )), 'Registration'];
  styleHeader(headerRow);
  headerRow.height = 44;
  // What each column is, for reading the file back.
  const keys = ['name', 'sapId', 'email', 'total', 'outOf', ...bank.map((question) => `q:${question.id}`), `test:${test.code}`];
  sheet.getRow(MARKS_KEY_ROW).values = keys;
  sheet.getRow(MARKS_KEY_ROW).hidden = true;

  const byStudent = new Map();
  for (const response of dashboard.responses || []) {
    if (!byStudent.has(response.registrationId)) byStudent.set(response.registrationId, new Map());
    byStudent.get(response.registrationId).set(response.questionId, response);
  }
  const papers = (dashboard.registrations || []).filter((registration) => registration.attemptStatus === 'submitted');
  const rowValues = (registration) => {
    const answers = byStudent.get(registration.id) || new Map();
    return [registration.name, registration.sapId || '', registration.email, null, registration.totalMarks ?? '',
      ...bank.map((question) => answers.get(question.id)?.marks ?? null), registration.id];
  };
  papers.forEach((registration, index) => {
    const answers = byStudent.get(registration.id) || new Map();
    const row = sheet.getRow(MARKS_KEY_ROW + 1 + index);
    row.values = rowValues(registration);
    // Total: the row added up, as marks are typed.
    row.getCell(4).value = bank.length
      ? { formula: `SUM(${row.getCell(MARKS_FIRST_QUESTION).address}:${row.getCell(lastQuestion).address})`, result: registration.score ?? 0 }
      : 0;
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      cell.font = { name: 'Aptos', size: 10, color: { argb: INK }, ...(column === 4 ? { bold: true } : {}) };
      cell.alignment = { vertical: 'middle', ...(column >= 4 ? { horizontal: 'center' } : {}) };
      cell.border = box;
    });
    bank.forEach((question, position) => {
      const cell = row.getCell(MARKS_FIRST_QUESTION + position);
      const response = answers.get(question.id);
      // Not on this student's paper.
      if (!response) { paint(cell, FILL.blank); return; }
      // A short answer still to mark stands out; any mark can be changed.
      if (question.manualGrading) paint(cell, response.marks === null ? FILL.pending : MARKS_EDITABLE);
      cell.dataValidation = {
        type: 'decimal', operator: 'between', allowBlank: true, formulae: [0, question.maxMarks],
        showErrorMessage: true, errorTitle: 'Marks', error: `From 0 to ${question.maxMarks}.`
      };
    });
  });
  if (!papers.length) {
    sheet.getCell('A6').value = 'Nobody has handed in a paper yet.';
    sheet.getCell('A6').font = { name: 'Aptos', size: 10, italic: true, color: { argb: MUTED } };
  }
  [26, 13, 30, 9, 9].forEach((columnWidth, index) => { sheet.getColumn(index + 1).width = columnWidth; });
  bank.forEach((_question, index) => { sheet.getColumn(MARKS_FIRST_QUESTION + index).width = 14; });
  sheet.getColumn(idColumn).hidden = true;

  // The marks as exported, out of sight.
  const base = workbook.addWorksheet(MARKS_BASE_SHEET, { state: 'veryHidden' });
  base.addRow(keys);
  papers.forEach((registration) => base.addRow(rowValues(registration)));
}

export async function buildTestSpreadsheet(dashboard) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Quiz';
  workbook.created = new Date();
  overviewSheet(workbook, dashboard);
  resultsSheet(workbook, dashboard);
  marksSheet(workbook, dashboard);
  answerGridSheet(workbook, dashboard);
  questionAnalysisSheet(workbook, dashboard);
  responsesSheet(workbook, dashboard);
  integrityLogSheet(workbook, dashboard);
  activitySheet(workbook, dashboard);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/* ------------------------------------------------ one student's own paper */

const TYPE_NAMES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
const DATE_FORMAT = 'd mmm yyyy, h:mm AM/PM';
const sentence = (value) => (value ? String(value).charAt(0).toUpperCase() + String(value).slice(1).replaceAll('_', ' ') : '—');
function lasted(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  return total % 60 ? `${minutes} min ${total % 60} s` : `${minutes} min`;
}
const howItEnded = (by) => ({ student: 'You submitted it', time: 'Time ran out, so it was submitted automatically', admin: 'Closed by your teacher', teacher: 'Handed in by your teacher' }[by] || (by ? sentence(by) : '—'));

function studentResult(answer) {
  if (answer.manualGrading && answer.isCorrect === null) return answer.answered ? 'Awaiting marking' : 'Not answered';
  if (!answer.answered) return 'Not answered';
  if (answer.partial) return `Part marks (${answer.marks} of ${answer.maxMarks})`;
  if (answer.manualGrading) return answer.isCorrect ? 'Correct (marked)' : 'Incorrect (marked)';
  return answer.isCorrect ? 'Correct' : 'Incorrect';
}
const resultTone = (answer) => {
  if (answer.manualGrading && answer.answered && answer.isCorrect === null) return 'pending';
  if (!answer.answered) return 'blank';
  if (answer.isCorrect === null) return 'pending';
  if (answer.partial) return 'partial';
  return answer.isCorrect ? 'correct' : 'wrong';
};

/** A labelled number in the row of tiles at the top of "My responses". */
function tile(sheet, from, to, label, value, tone) {
  if (from !== to) {
    sheet.mergeCells(`${from}4:${to}4`);
    sheet.mergeCells(`${from}5:${to}5`);
  }
  const fill = tone === 'brand' ? BRAND : FILL[tone] || LABEL;
  const first = sheet.getCell(`${from}4`).col;
  const last = sheet.getCell(`${to}4`).col;
  for (const row of [4, 5]) for (let column = first; column <= last; column += 1) paint(sheet.getRow(row).getCell(column), fill);
  const head = sheet.getCell(`${from}4`);
  head.value = label.toUpperCase();
  head.font = { name: 'Aptos', size: 8.5, bold: true, color: { argb: tone === 'brand' ? 'FFFFFFFF' : MUTED } };
  head.alignment = { horizontal: 'center', vertical: 'bottom' };
  const body = sheet.getCell(`${from}5`);
  body.value = value;
  body.font = { name: 'Aptos', size: typeof value === 'number' || tone === 'brand' ? 18 : 11, bold: true, color: { argb: tone === 'brand' ? 'FFFFFFFF' : TEXT[tone] || INK } };
  body.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  return body;
}

/** A section of label / value rows on "Test record". Returns the next free row. */
function recordSection(sheet, rowNumber, title, rows) {
  const heading = sheet.getRow(rowNumber);
  heading.getCell(1).value = title;
  heading.getCell(1).font = { name: 'Aptos', size: 10.5, bold: true, color: { argb: BRAND } };
  heading.getCell(1).alignment = { vertical: 'middle', indent: 1 };
  [1, 2].forEach((column) => { paint(heading.getCell(column), SOFT); heading.getCell(column).border = box; });
  heading.height = 24;
  rows.forEach(([label, value, isDate], index) => {
    const row = sheet.getRow(rowNumber + 1 + index);
    const empty = value === '' || value === null || value === undefined;
    row.getCell(1).value = label;
    row.getCell(2).value = empty ? '—' : value;
    row.getCell(1).font = { name: 'Aptos', size: 10, bold: true, color: { argb: MUTED } };
    row.getCell(2).font = { name: 'Aptos', size: 10, color: { argb: INK } };
    paint(row.getCell(1), LABEL);
    [1, 2].forEach((column) => { row.getCell(column).border = box; row.getCell(column).alignment = { vertical: 'middle', horizontal: 'left', wrapText: true, indent: 1 }; });
    if (isDate && !empty) row.getCell(2).numFmt = DATE_FORMAT;
    row.height = 20;
  });
  return rowNumber + rows.length + 2;
}

/**
 * The workbook of one person's paper. A student downloading their own gets
 * exactly two sheets - their responses and their test record - and nothing
 * more. The Users page's audit download (audit: true) adds the full activity,
 * integrity and location evidence behind the mark. Short answers not yet
 * marked say so; the sheet is built fresh on each download, so downloading
 * again after marking brings them in.
 */
export async function buildStudentResponseSpreadsheet(data, { audit = false } = {}) {
  const { test, student, registration = {}, attempt, integrity, activity = [], location, locationTrail = [], device = null, answers, summary } = data;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Quiz';
  workbook.created = new Date();

  /* My responses */
  const sheet = workbook.addWorksheet('My responses', { views: [{ showGridLines: false }] });
  [7, 16, 50, 32, 32, 20, 9].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  banner(sheet, test.title, `Your responses  ·  ${test.code}  ·  Downloaded ${exportedAt()}`, 7);
  sheet.getRow(3).height = 8;

  const final = summary.ungraded === 0;
  tile(sheet, 'A', 'B', 'Marks', `${summary.score} / ${summary.totalMarks ?? summary.total}`, 'brand');
  tile(sheet, 'C', 'C', 'Correct', summary.correct, 'correct');
  tile(sheet, 'D', 'D', 'Incorrect', summary.incorrect, 'wrong');
  tile(sheet, 'E', 'E', 'Not answered', summary.unanswered, 'blank');
  tile(sheet, 'F', 'G', 'Status', final ? 'Final' : `Provisional: ${summary.ungraded} to mark`, final ? 'correct' : 'pending');
  sheet.getRow(4).height = 18;
  sheet.getRow(5).height = 36;
  sheet.getRow(6).height = 10;

  const details = [['Name', student.name], ['Email', student.email], ['SAP ID', student.sapId || '—'], ['Submitted', asDate(attempt.submittedAt)]];
  details.forEach(([label, value], index) => {
    const rowNumber = 7 + index;
    for (let column = 1; column <= 7; column += 1) {
      const any = sheet.getRow(rowNumber).getCell(column);
      any.border = box;
      paint(any, column <= 2 ? LABEL : 'FFFFFFFF');
    }
    sheet.mergeCells(`A${rowNumber}:B${rowNumber}`);
    sheet.mergeCells(`C${rowNumber}:G${rowNumber}`);
    const name = sheet.getCell(`A${rowNumber}`);
    const cell = sheet.getCell(`C${rowNumber}`);
    name.value = label;
    cell.value = value || '—';
    name.font = { name: 'Aptos', size: 10, bold: true, color: { argb: MUTED } };
    cell.font = { name: 'Aptos', size: 10, bold: label === 'Name', color: { argb: INK } };
    name.alignment = { vertical: 'middle', indent: 1 };
    cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    if (label === 'Submitted' && value) cell.numFmt = DATE_FORMAT;
    sheet.getRow(rowNumber).height = 20;
  });

  const headerRowNumber = 7 + details.length + 1;
  sheet.getRow(headerRowNumber - 1).height = 10;
  const headerRow = sheet.getRow(headerRowNumber);
  headerRow.values = ['Q', 'Type', 'Question', 'Your answer', 'Correct answer', 'Result', 'Marks'];
  styleHeader(headerRow);
  answers.forEach((answer) => {
    const tone = resultTone(answer);
    const row = sheet.addRow([
      answer.questionNumber,
      TYPE_NAMES[answer.type] || sentence(answer.type),
      plainText(answer.prompt),
      answer.answered ? answer.selectedAnswer : '—',
      answer.manualGrading ? 'Marked by your teacher' : answer.correctAnswer,
      studentResult(answer),
      answer.marks === null || answer.marks === undefined ? '…' : `${answer.marks} / ${answer.maxMarks}`
    ]);
    [6, 7].forEach((column) => {
      paint(row.getCell(column), FILL[tone]);
      row.getCell(column).font = { name: 'Aptos', size: 10, bold: true, color: { argb: TEXT[tone] } };
      row.getCell(column).alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
  });
  if (answers.length) styleDataRows(sheet, headerRowNumber + 1, answers.length);
  else sheet.getCell(`A${headerRowNumber + 1}`).value = 'No questions were recorded on this paper.';
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber, showGridLines: false }];
  sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: 7 } };

  /* Test record */
  const record = workbook.addWorksheet('Test record', { views: [{ showGridLines: false }] });
  record.getColumn(1).width = 30;
  record.getColumn(2).width = 58;
  banner(record, test.title, `Your test record  ·  ${test.code}  ·  Downloaded ${exportedAt()}`, 2);
  const timeTaken = attempt.startedAt && attempt.submittedAt ? lasted((new Date(attempt.submittedAt) - new Date(attempt.startedAt)) / 1000) : '';
  let next = 4;
  next = recordSection(record, next, 'The test', [
    ['Test', test.title], ['Test code', test.code], ['Test date', asDate(test.startsAt), true],
    ['End time', asDate(test.endsAt), true], ['Closed at', asDate(test.closedAt), true]
  ]);
  next = recordSection(record, next, 'Your registration', [
    ['Status', sentence(registration.status)], ['Requested', asDate(registration.requestedAt), true], ['Decided', asDate(registration.decidedAt), true]
  ]);
  next = recordSection(record, next, 'Your attempt', [
    ['Status', sentence(attempt.status)], ['Started', asDate(attempt.startedAt), true], ['Submitted', asDate(attempt.submittedAt), true],
    ['How it ended', howItEnded(attempt.submittedBy)], ['Time taken', timeTaken],
    ...(audit && device ? [
      ['Began on', device.began || '—'], ['Device last seen', device.last],
      ['Device notes', device.notes.join(' ') || 'None'], ['Device exception given', device.exception ? 'Yes' : 'No']
    ] : [])
  ]);
  if (integrity) {
    recordSection(record, next, 'Leaving the test', [
      ['Times you left', integrity.leaveCount || 0],
      ['Time away in total', lasted((integrity.awayMs || 0) / 1000)],
      ['Times locked', integrity.lockCount || 0],
      ...(audit ? [
        ['Longest time away', lasted((integrity.longestAwayMs || 0) / 1000)],
        ['Copy, cut, paste or drag attempts', (integrity.flags?.copy || 0) + (integrity.flags?.cut || 0) + (integrity.flags?.paste || 0) + (integrity.flags?.drop || 0)],
        ['Keyboard opened another app while typing (not counted as leaving)', integrity.flags?.keyboard_app || 0],
        ['Screenshot, print or developer-tools attempts', (integrity.flags?.screenshot || 0) + (integrity.flags?.print || 0) + (integrity.flags?.devtools || 0)],
        ['Attempt locked now', attempt.locked ? 'Yes' : 'No'],
        ['Lock reason', attempt.lockReason || '—']
      ] : [])
    ]);
  }
  record.pageSetup.orientation = 'portrait';

  if (audit) auditSheets(workbook, { test, student, integrity, activity, location, locationTrail });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** The Users page's audit download: the evidence behind the mark, event by event. */
function auditSheets(workbook, { test, student, integrity, activity, location, locationTrail = [] }) {
  const activitySheet = sheetTitle(workbook, 'Activity log', `${test.title} — ${student.name}'s activity`, test);
  activitySheet.getRow(4).values = ['When', 'What happened', 'Type', 'Details', 'Away (seconds)'];
  styleHeader(activitySheet.getRow(4));
  if (activity.length) {
    activity.forEach((entry) => activitySheet.addRow([
      asDate(entry.at), entry.label, entry.kind, entry.detail || '',
      entry.durationMs === null || entry.durationMs === undefined ? '' : Math.round(entry.durationMs / 1000)
    ]));
    styleDataRows(activitySheet, 5, activity.length);
  } else {
    emptyNote(activitySheet, 'No activity was recorded for this test.');
  }
  [22, 38, 16, 50, 16].forEach((width, index) => { activitySheet.getColumn(index + 1).width = width; });
  activitySheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
  activitySheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 5 } };

  const integritySheet = sheetTitle(workbook, 'Integrity log', `${test.title} — ${student.name}'s integrity log`, test);
  const events = integrity?.events || [];
  integritySheet.getRow(4).values = ['When', 'What happened', 'Event type', 'Recorded detail', 'Away (seconds)'];
  styleHeader(integritySheet.getRow(4));
  if (events.length) {
    events.forEach((event) => integritySheet.addRow([
      asDate(event.createdAt), event.label, event.type, event.detail || '',
      event.durationMs === null || event.durationMs === undefined ? '' : Math.round(event.durationMs / 1000)
    ]));
    styleDataRows(integritySheet, 5, events.length);
  } else {
    emptyNote(integritySheet, 'No integrity events were recorded for this test.');
  }
  [22, 38, 22, 46, 16].forEach((width, index) => { integritySheet.getColumn(index + 1).width = width; });
  integritySheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
  integritySheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 5 } };

  const locationSheet = sheetTitle(workbook, 'Location checks', `${test.title} — ${student.name}'s venue checks`, test);
  locationSheet.getRow(4).values = ['Check', 'Value'];
  styleHeader(locationSheet.getRow(4));
  const locationRows = location ? [
    ['In-range readings', location.inRange || 0],
    ['Out-of-range readings', location.outOfRange || 0],
    ['Inconclusive readings', location.inconclusive || 0],
    ['Times outside the venue', location.outsideCount || 0],
    ['Time outside the venue (seconds)', Math.round((location.outsideMs || 0) / 1000)],
    ['Last reading status', location.last?.status || '—'],
    ['Last reading distance (metres)', location.last?.distanceMeters ?? '—'],
    ['Last reading at', asDate(location.last?.checkedAt)],
    ['Last reading trigger', location.last?.trigger || '—'],
    ['Submission location status', location.submit?.status || '—'],
    ['Submission location distance (metres)', location.submit?.distanceMeters ?? '—'],
    ['Submission location checked at', asDate(location.submit?.checkedAt)]
  ] : [['Venue monitoring', 'Not required for this test.']];
  locationRows.forEach((row) => locationSheet.addRow(row));
  styleDataRows(locationSheet, 5, locationRows.length);
  locationSheet.getColumn(1).width = 42;
  locationSheet.getColumn(2).width = 48;
  [12, 16].forEach((rowNumber) => { locationSheet.getCell(`B${rowNumber}`).numFmt = 'yyyy-mm-dd hh:mm:ss'; });

  // Every reading taken while the paper was open, with where it was and a map link.
  if (!location && !locationTrail.length) return;
  const readingsSheet = sheetTitle(workbook, 'Locations', `${test.title} — ${student.name}'s location readings`, test);
  readingsSheet.getRow(4).values = ['When', 'Latitude', 'Longitude', 'Accuracy (m)', 'From the venue (m)', 'Reading', 'Taken when', 'Map'];
  styleHeader(readingsSheet.getRow(4));
  if (locationTrail.length) {
    locationTrail.forEach((reading) => {
      const known = reading.latitude !== null && reading.longitude !== null;
      const row = readingsSheet.addRow([
        asDate(reading.at), known ? reading.latitude : '', known ? reading.longitude : '',
        reading.accuracyMeters ?? '', reading.distanceMeters ?? '',
        READING_WORDS[reading.status] || reading.status, TRIGGER_WORDS[reading.trigger] || reading.trigger || '',
        known ? { text: 'Open map', hyperlink: `https://www.google.com/maps?q=${reading.latitude},${reading.longitude}` } : 'No reading'
      ]);
      if (known) row.getCell(8).font = { color: { argb: 'FF1598D1' }, underline: true };
    });
    styleDataRows(readingsSheet, 5, locationTrail.length);
  } else {
    emptyNote(readingsSheet, 'No readings were kept for this paper.');
  }
  [22, 14, 14, 14, 18, 22, 22, 14].forEach((width, index) => { readingsSheet.getColumn(index + 1).width = width; });
  readingsSheet.getColumn(1).numFmt = 'yyyy-mm-dd hh:mm:ss';
  readingsSheet.getColumn(2).numFmt = '0.000000';
  readingsSheet.getColumn(3).numFmt = '0.000000';
  readingsSheet.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: 7 } };
}

const READING_WORDS = { inRange: 'At the venue', outOfRange: 'Away from the venue', inconclusive: 'Could not tell' };
const TRIGGER_WORDS = { start: 'Began', timer: 'Regular check', question: 'Changed question', manual: 'Checked again', blocked: 'While shut out', submit: 'At submit' };

