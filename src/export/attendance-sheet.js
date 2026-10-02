import ExcelJS from 'exceljs';
import { registerKey } from '../domain/attendance.js';

export { registerKey };

/**
 * One attendance session as a workbook:
 *
 *   Attendance  one row per person who marked, with when, which round, and
 *               where they were
 *   Absent      everyone seen in the class's other sessions who did not mark
 *               in this one, with how often they come
 *   Rounds      when each round of attendance was opened and closed
 *
 * Downloaded from a filtered list, it holds only the rows that were shown -
 * marks, absentees, or both - and says how they were chosen.
 */

const STATUS = { present: 'Present', pending: 'Pending (not closed yet)', rejected: 'Removed by teacher' };
const FILL = { present: 'FFE3F5EA', pending: 'FFFFF4D6', rejected: 'FFFDE7E7' };
const when = (value) => (value ? new Date(value) : '');

function header(sheet, titles) {
  const row = sheet.addRow(titles);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17162D' } }; });
  return row.number;
}

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const account = (person) => (person.isGuest ? 'Guest' : person.email ? 'College' : 'No account');
/** In roll order: by SAP ID, then by name; anyone without one after. */
const rollOrder = (a, b) => (a.sapId ? 0 : 1) - (b.sapId ? 0 : 1) || String(a.sapId || '').localeCompare(String(b.sapId || '')) || a.name.localeCompare(b.name);

export async function buildAttendanceSpreadsheet(session) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  const marks = session.marks || [];
  const absent = session.absent || [];
  const picked = Boolean(session.note);
  const counts = `${session.code} · ${session.presentCount} present · ${session.pendingCount} pending · ${session.rejectedCount} removed`
    + (session.classSessions ? ` · absent: ${(session.absent || []).length}${picked ? ' shown' : ''}` : '');

  /* Sheet title rows, and the line saying which rows were chosen. */
  const top = (sheet) => {
    sheet.addRow([session.title]).font = { bold: true, size: 14 };
    sheet.addRow([counts]);
    if (picked) sheet.addRow([session.note]).font = { italic: true, color: { argb: 'FF5A6066' } };
  };
  const headerAt = picked ? 4 : 3;

  if (marks.length || !absent.length) {
    const sheet = workbook.addWorksheet('Attendance', { views: [{ state: 'frozen', ySplit: headerAt, showGridLines: false }] });
    top(sheet);
    const headerRow = header(sheet, [
      'No.', 'Name', 'SAP ID', 'Email', 'Account', 'Status', 'Round', 'Late', 'Marked at', 'Confirmed at',
      'Location', 'Distance (m)', 'GPS accuracy (m)', 'Same phone as', 'Marked by', 'Possibly same phone as'
    ]);
    marks.forEach((mark, index) => {
      const row = sheet.addRow([
        index + 1, mark.name, mark.sapId || '', mark.email || '', account(mark),
        STATUS[mark.status] || mark.status, mark.round, mark.late ? 'Yes' : 'No',
        when(mark.markedAt), when(mark.confirmedAt),
        mark.location ? (mark.location.status === 'inside' ? 'In classroom' : 'Uncertain GPS') : 'Not checked',
        mark.location?.distanceMeters ?? '', mark.location?.accuracyMeters ?? '',
        (mark.sameDeviceAs || []).join(', '),
        mark.addedByTeacher ? 'Teacher' : 'Student (QR)',
        (mark.similarDeviceAs || []).join(', ')
      ]);
      row.getCell(6).fill = fill(FILL[mark.status] || 'FFFFFFFF');
    });
    sheet.getColumn(9).numFmt = 'dd-mmm-yyyy hh:mm:ss';
    sheet.getColumn(10).numFmt = 'dd-mmm-yyyy hh:mm:ss';
    [6, 28, 12, 30, 11, 22, 7, 6, 20, 20, 14, 12, 16, 30, 13, 30].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: 16 } };
  }

  if (absent.length) {
    const sheet = workbook.addWorksheet('Absent', { views: [{ state: 'frozen', ySplit: headerAt, showGridLines: false }] });
    top(sheet);
    const headerRow = header(sheet, ['No.', 'Name', 'SAP ID', 'Email', 'Account', 'Classes attended', 'Of', 'Attendance', 'Last seen']);
    // A filtered download keeps the order on screen; the whole list is in roll order.
    (picked ? absent : [...absent].sort(rollOrder)).forEach((person, index) => {
      const row = sheet.addRow([
        index + 1, person.name, person.sapId || '', person.email || '', account(person),
        person.seen, session.classSessions, session.classSessions ? person.seen / session.classSessions : '', when(person.lastSeenAt)
      ]);
      row.getCell(8).numFmt = '0%';
    });
    sheet.getColumn(9).numFmt = 'dd-mmm-yyyy';
    [6, 28, 12, 30, 11, 16, 6, 12, 14].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
    sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: 9 } };
  }

  const rounds = workbook.addWorksheet('Rounds', { views: [{ showGridLines: false }] });
  header(rounds, ['Round', 'Opened at', 'Closed at', 'Marked in this round']);
  for (const round of session.rounds) {
    rounds.addRow([round.number, when(round.openedAt), round.closedAt ? when(round.closedAt) : 'Still open',
      marks.filter((mark) => mark.round === round.number && mark.status !== 'rejected').length]);
  }
  rounds.getColumn(2).numFmt = 'dd-mmm-yyyy hh:mm:ss';
  rounds.getColumn(3).numFmt = 'dd-mmm-yyyy hh:mm:ss';
  [8, 22, 22, 20].forEach((width, index) => { rounds.getColumn(index + 1).width = width; });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/* ------------------------------------------------ many sessions: a register */

/** Colleges commonly require this much attendance; below it, a student's total shows in red. */
export const REGISTER_MIN_SHARE = 0.75;
const CELL = {
  present: { text: 'P', fill: 'FFE3F5EA' },
  late: { text: 'L', fill: 'FFD5EFE0' },
  pending: { text: '?', fill: 'FFFFF4D6' },
  rejected: { text: 'R', fill: 'FFFDE7E7' },
  absent: { text: 'A', fill: 'FFF6F6F7' }
};

/** Where one person stands in one session: their best mark there, or absent. */
function standing(marks) {
  if (marks.some((mark) => mark.status === 'present' && !mark.late)) return 'present';
  if (marks.some((mark) => mark.status === 'present')) return 'late';
  if (marks.some((mark) => mark.status === 'pending')) return 'pending';
  if (marks.some((mark) => mark.status === 'rejected')) return 'rejected';
  return 'absent';
}

/**
 * The register behind the workbook, oldest session first: one row per person,
 * their standing in each session, and their totals. Removed marks and absence
 * count against a student; a mark still pending (its session not closed) counts
 * neither way.
 */
export function attendanceRegister(sessions) {
  const ordered = [...sessions].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const people = new Map();
  ordered.forEach((session, index) => {
    for (const mark of session.marks || []) {
      const key = registerKey(mark);
      const person = people.get(key) || { key, name: mark.name, sapId: '', email: '', isGuest: Boolean(mark.isGuest), marks: ordered.map(() => []) };
      // The latest session's name and details win: a corrected name carries through.
      person.name = mark.name || person.name;
      person.sapId = mark.sapId || person.sapId;
      person.email = mark.email || person.email;
      person.marks[index].push(mark);
      people.set(key, person);
    }
  });
  const rows = [...people.values()].map((person) => {
    const cells = person.marks.map(standing);
    const present = cells.filter((cell) => cell === 'present' || cell === 'late').length;
    const pending = cells.filter((cell) => cell === 'pending').length;
    const counted = cells.length - pending;
    return {
      name: person.name, sapId: person.sapId, email: person.email, isGuest: person.isGuest, cells,
      present, pending, absent: counted - present, share: counted ? present / counted : null
    };
  });
  rows.sort(rollOrder);
  return { sessions: ordered, rows };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const clockParts = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: 'numeric', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
/** "01 Sep 2026, 09:30", in Indian time: the same on every server, whatever its locale. */
function dateLabel(value) {
  const part = Object.fromEntries(clockParts.formatToParts(new Date(value)).map((entry) => [entry.type, entry.value]));
  return `${part.day} ${MONTHS[Number(part.month) - 1]} ${part.year}, ${part.hour}:${part.minute}`;
}

/**
 * Classes a student must attend in a row, from now, to reach `min` - null when
 * they cannot (a minimum of 100% with an absence already).
 */
export function classesToReach(person, min) {
  const counted = person.present + person.absent;
  if (!counted || person.present / counted >= min) return 0;
  if (min >= 1) return null;
  return Math.ceil((min * counted - person.present) / (1 - min));
}

/**
 * Several sessions as one workbook:
 *
 *   Register    one row per student, one column per session (P present, L late,
 *               A absent, R removed by you, ? not closed yet), and their totals
 *   Below 75%   the students short of the minimum (`minShare`, 75% unless
 *               chosen), and how many classes in a row would bring them up
 *   Sessions    each session: when, its code, how many were present
 *   All marks   every mark in every session, with where and how it was made
 */
export async function buildAttendanceRegisterSpreadsheet({ sessions, exportedAt, minShare = REGISTER_MIN_SHARE }) {
  const { sessions: ordered, rows } = attendanceRegister(sessions);
  const minPercent = Math.round(minShare * 100);
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Register', { views: [{ state: 'frozen', xSplit: 3, ySplit: 4, showGridLines: false }] });
  sheet.addRow(['Attendance register']).font = { bold: true, size: 14 };
  const first = ordered[0]?.createdAt;
  const last = ordered.at(-1)?.createdAt;
  sheet.addRow([`${ordered.length} session${ordered.length === 1 ? '' : 's'}${first ? ` · ${dateLabel(first)} to ${dateLabel(last)}` : ''} · ${rows.length} student${rows.length === 1 ? '' : 's'} · downloaded ${dateLabel(exportedAt || new Date())}`]);
  sheet.addRow([`P present · L present, marked in a later round · A absent · R removed by you (counted absent) · ? not closed yet (not counted) · totals under ${minPercent}% in red`]).font = { italic: true, color: { argb: 'FF5A6066' } };
  const sessionTitles = ordered.map((session) => `${session.title}\n${dateLabel(session.createdAt)}`);
  const headerRow = header(sheet, ['No.', 'Name', 'SAP ID', 'Email', 'Account', ...sessionTitles, 'Present', 'Absent', 'Not closed', 'Attendance']);
  sheet.getRow(headerRow).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };
  sheet.getRow(headerRow).height = 44;
  const firstSession = 6;
  const total = firstSession + ordered.length;
  rows.forEach((person, index) => {
    const row = sheet.addRow([
      index + 1, person.name, person.sapId || '', person.email || '', person.email ? 'College' : person.isGuest ? 'Guest' : 'No account',
      ...person.cells.map((cell) => CELL[cell].text),
      person.present, person.absent, person.pending, person.share
    ]);
    person.cells.forEach((cell, column) => {
      const target = row.getCell(firstSession + column);
      target.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: CELL[cell].fill } };
      target.alignment = { horizontal: 'center' };
      if (cell === 'absent' || cell === 'rejected') target.font = { color: { argb: 'FFB42318' }, bold: true };
    });
    const share = row.getCell(total + 3);
    share.numFmt = '0%';
    if (person.share !== null && person.share < minShare) share.font = { color: { argb: 'FFB42318' }, bold: true };
  });
  [6, 26, 12, 30, 9, ...ordered.map(() => 13), 9, 9, 10, 11].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: total + 3 } };

  const short = rows.filter((person) => person.share !== null && person.share < minShare);
  if (short.length) {
    const below = workbook.addWorksheet(`Below ${minPercent}%`, { views: [{ state: 'frozen', ySplit: 2, showGridLines: false }] });
    below.addRow([`${short.length} student${short.length === 1 ? '' : 's'} under ${minPercent}% attendance · "Classes needed": in a row, from now, to reach ${minPercent}%`]).font = { italic: true, color: { argb: 'FF5A6066' } };
    const belowHeader = header(below, ['No.', 'Name', 'SAP ID', 'Email', 'Account', 'Present', 'Absent', 'Attendance', 'Classes needed']);
    [...short].sort((a, b) => a.share - b.share || rollOrder(a, b)).forEach((person, index) => {
      const needed = classesToReach(person, minShare);
      const row = below.addRow([index + 1, person.name, person.sapId || '', person.email || '', person.email ? 'College' : person.isGuest ? 'Guest' : 'No account',
        person.present, person.absent, person.share, needed ?? 'Cannot reach']);
      row.getCell(8).numFmt = '0%';
      row.getCell(8).font = { color: { argb: 'FFB42318' }, bold: true };
    });
    [6, 26, 12, 30, 11, 9, 9, 11, 15].forEach((width, index) => { below.getColumn(index + 1).width = width; });
    below.autoFilter = { from: { row: belowHeader, column: 1 }, to: { row: belowHeader, column: 9 } };
  }

  const list = workbook.addWorksheet('Sessions', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  header(list, ['Date', 'Title', 'Code', 'Present', 'Not closed yet', 'Removed', 'Rounds', 'Last closed']);
  for (const session of ordered) {
    const closed = session.rounds?.at(-1)?.closedAt;
    list.addRow([when(session.createdAt), session.title, session.code, session.presentCount, session.pendingCount, session.rejectedCount,
      session.rounds?.length || 1, closed ? when(closed) : 'Still open']);
  }
  list.getColumn(1).numFmt = 'dd-mmm-yyyy hh:mm';
  list.getColumn(8).numFmt = 'dd-mmm-yyyy hh:mm';
  [18, 32, 14, 9, 14, 9, 8, 18].forEach((width, index) => { list.getColumn(index + 1).width = width; });

  const all = workbook.addWorksheet('All marks', { views: [{ state: 'frozen', ySplit: 1, showGridLines: false }] });
  const allHeader = header(all, [
    'Session date', 'Session', 'Code', 'Name', 'SAP ID', 'Email', 'Account', 'Status', 'Round', 'Late', 'Marked at', 'Confirmed at',
    'Location', 'Distance (m)', 'GPS accuracy (m)', 'Same phone as', 'Marked by', 'Possibly same phone as'
  ]);
  for (const session of ordered) {
    for (const mark of session.marks || []) {
      const row = all.addRow([
        when(session.createdAt), session.title, session.code, mark.name, mark.sapId || '', mark.email || '',
        mark.isGuest ? 'Guest' : mark.email ? 'College' : 'No account', STATUS[mark.status] || mark.status, mark.round, mark.late ? 'Yes' : 'No',
        when(mark.markedAt), when(mark.confirmedAt),
        mark.location ? (mark.location.status === 'inside' ? 'In classroom' : 'Uncertain GPS') : 'Not checked',
        mark.location?.distanceMeters ?? '', mark.location?.accuracyMeters ?? '', (mark.sameDeviceAs || []).join(', '),
        mark.addedByTeacher ? 'Teacher' : 'Student (QR)', (mark.similarDeviceAs || []).join(', ')
      ]);
      row.getCell(8).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[mark.status] || 'FFFFFFFF' } };
    }
  }
  [1, 11, 12].forEach((column) => { all.getColumn(column).numFmt = 'dd-mmm-yyyy hh:mm'; });
  [18, 28, 13, 26, 12, 30, 10, 22, 7, 6, 18, 18, 14, 12, 16, 28, 13, 28].forEach((width, index) => { all.getColumn(index + 1).width = width; });
  all.autoFilter = { from: { row: allHeader, column: 1 }, to: { row: allHeader, column: 18 } };

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
