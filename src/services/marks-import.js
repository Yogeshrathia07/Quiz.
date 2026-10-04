import ExcelJS from 'exceljs';
import { PublicTestError } from '../lib/errors.js';
import { isSapId } from '../domain/test-builder.js';
import { earnedMarks, questionMarks, roundMarks } from '../domain/marks.js';
import { refuseIfFrozen } from '../domain/freeze.js';
import { requireOwnedTest, updateRegistration } from '../data/test-repository.js';
import { markUpdate, markWrite } from './admin-service.js';
import { MARKS_BASE_SHEET, MARKS_KEY_ROW, MARKS_SHEET } from '../export/spreadsheet.js';

const SHOWN = 20;

/** A cell's number: typed, a formula's result, or text such as "1.5" or "1,5". Empty is null; anything else NaN. */
function cellNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object') {
    if ('result' in value) return cellNumber(value.result);
    if (Array.isArray(value.richText)) return cellNumber(value.richText.map((part) => part.text).join(''));
    return Number.NaN;
  }
  const text = String(value).trim().replace(',', '.');
  return text === '' ? null : Number(text);
}

const cellText = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return cellText(value.result ?? value.text ?? (value.richText || []).map((part) => part.text).join(''));
  return String(value).trim();
};

const sameMark = (typed, was) => was !== null && Number.isFinite(typed) && roundMarks(typed) === roundMarks(was);

/**
 * The marks as they were exported (a hidden sheet of the same file): student
 * registration → question id → marks, or null when the file has none - one
 * exported before the sheet existed.
 */
function marksAsExported(workbook) {
  const base = workbook.getWorksheet(MARKS_BASE_SHEET);
  if (!base) return null;
  const keys = [];
  base.getRow(1).eachCell((cell, column) => { keys[column] = cellText(cell.value); });
  const idColumn = keys.findIndex((key) => key?.startsWith('test:'));
  const marks = new Map();
  base.eachRow((row, number) => {
    if (number === 1 || idColumn < 0) return;
    const values = new Map();
    keys.forEach((key, column) => { if (key?.startsWith('q:')) values.set(Number(key.slice(2)), cellNumber(row.getCell(column).value)); });
    marks.set(cellText(row.getCell(idColumn).value), values);
  });
  return marks;
}

/**
 * Marks typed into a test's Marks sheet (export/spreadsheet.js), read back:
 * each row finds its student by the hidden registration, else their SAP ID,
 * else their email, and each short-answer cell holding a number from 0 to
 * what the question is worth becomes that answer's mark - a short answer's, or
 * the teacher's own for a choice answer (markUpdate). An empty cell, or one
 * holding the mark it was exported with, is left as it is. Nothing is half-applied for a student: their marks are written
 * together, and what could not be used is reported, row by row.
 */
export async function importMarks(req, code, buffer) {
  if (!buffer?.length) throw new PublicTestError(400, 'Choose the Excel file to upload.');
  const test = await requireOwnedTest(req, code);
  refuseIfFrozen(test, 'upload marks');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(buffer); } catch {
    throw new PublicTestError(400, 'That file is not an Excel workbook (.xlsx).');
  }
  const sheet = workbook.getWorksheet(MARKS_SHEET);
  if (!sheet) throw new PublicTestError(400, 'This workbook has no Marks sheet. Use Export Excel on this test, fill in its Marks sheet, and upload that file.');

  // The hidden row names each column: "test:CODE", then name, sapId, email, ..., "q:<question id>".
  const keys = new Map();
  sheet.getRow(MARKS_KEY_ROW).eachCell((cell, column) => keys.set(cellText(cell.value), column));
  const testKey = [...keys.keys()].find((key) => key.startsWith('test:'));
  if (!testKey) throw new PublicTestError(400, 'The Marks sheet is missing its hidden header row. Export Excel again and type the marks into the new file.');
  if (testKey !== `test:${test.code}`) throw new PublicTestError(400, `This Marks sheet belongs to another test (${testKey.slice(5)}).`);

  const bank = new Map((test.questions || []).map((question, index) => [question.id, { question, number: index + 1 }]));
  const columns = [...keys].filter(([key]) => key.startsWith('q:')).map(([key, column]) => ({ id: Number(key.slice(2)), column }))
    .filter(({ id }) => bank.has(id));
  const exported = marksAsExported(workbook);

  const registrations = test.registrations || [];
  const byId = new Map(registrations.map((registration) => [registration.id, registration]));
  const byEmail = new Map(registrations.map((registration) => [String(registration.collegeEmail || '').toLowerCase(), registration]));
  // A SAP ID finds a student only when one student on this test has it.
  const sapCounts = new Map();
  for (const registration of registrations) if (registration.sapId) sapCounts.set(registration.sapId, (sapCounts.get(registration.sapId) || 0) + 1);
  const bySap = new Map(registrations.filter((registration) => sapCounts.get(registration.sapId) === 1).map((registration) => [registration.sapId, registration]));

  const result = { students: 0, marks: 0, unmatched: [], notSubmitted: [], invalid: [], ignored: 0 };
  for (let rowNumber = MARKS_KEY_ROW + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const read = (key) => (keys.has(key) ? cellText(row.getCell(keys.get(key)).value) : '');
    const regId = cellText(row.getCell(keys.get(testKey)).value);
    const name = read('name');
    // A SAP ID that is not nine digits finds nobody, rather than stopping the upload.
    const sapId = isSapId(read('sapId')) ? read('sapId') : '';
    const email = read('email').toLowerCase();
    if (!regId && !name && !sapId && !email) continue;
    const label = name || sapId || email || `Row ${rowNumber}`;

    const registration = byId.get(regId) || (sapId && bySap.get(sapId)) || (email && byEmail.get(email));
    if (!registration) { result.unmatched.push(label); continue; }
    const attempt = registration.attempt;
    if (attempt?.status !== 'submitted') { result.notSubmitted.push(label); continue; }

    const answers = new Map((attempt.answers || []).map((answer) => [answer.questionId, answer]));
    const wasExported = exported?.get(registration.id);
    const changes = [];
    for (const { id, column } of columns) {
      const typed = cellNumber(row.getCell(column).value);
      if (typed === null) continue;
      // Not typed over since the export: a mark given in the app since then stays.
      if (wasExported?.has(id) && sameMark(typed, wasExported.get(id))) continue;
      const { question, number } = bank.get(id);
      const answer = answers.get(id);
      // Not on this student's paper.
      if (!answer) continue;
      const worth = questionMarks(test, question);
      if (!Number.isFinite(typed) || typed < 0 || typed > worth) {
        result.invalid.push(`${label}, Q${number}: "${cellText(row.getCell(column).value)}" (0 to ${worth})`);
        continue;
      }
      if (roundMarks(typed) === earnedMarks(answer)) continue;
      // A short answer takes the mark; a choice answer takes it as the teacher's
      // own - or, typed as the automatic mark, goes back to that (markUpdate).
      changes.push({ id, update: markUpdate(test, question, answer, { marks: roundMarks(typed) }) });
    }
    if (!changes.length) continue;
    const writes = changes.map((change, index) => markWrite(change.update, `a${index}`));
    const unset = Object.assign({}, ...writes.map((write) => write.$unset || {}));
    await updateRegistration(test.code, registration.id,
      { $set: Object.assign({}, ...writes.map((write) => write.$set)), ...(Object.keys(unset).length ? { $unset: unset } : {}) },
      { arrayFilters: changes.map((change, index) => ({ [`a${index}.questionId`]: change.id })) });
    result.students += 1;
    result.marks += changes.length;
  }

  return {
    students: result.students,
    marks: result.marks,
    ignored: result.ignored,
    unmatched: { count: result.unmatched.length, names: result.unmatched.slice(0, SHOWN) },
    notSubmitted: { count: result.notSubmitted.length, names: result.notSubmitted.slice(0, SHOWN) },
    invalid: { count: result.invalid.length, cells: result.invalid.slice(0, SHOWN) }
  };
}
