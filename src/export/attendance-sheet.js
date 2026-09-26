import ExcelJS from 'exceljs';

/**
 * One attendance session as a workbook:
 *
 *   Attendance  one row per person who marked, with when, which round, and
 *               where they were
 *   Rounds      when each round of attendance was opened and closed
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

export async function buildAttendanceSpreadsheet(session) {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Attendance', { views: [{ state: 'frozen', ySplit: 3, showGridLines: false }] });
  sheet.addRow([session.title]).font = { bold: true, size: 14 };
  sheet.addRow([`${session.code} · ${session.presentCount} present · ${session.pendingCount} pending · ${session.rejectedCount} removed`]);
  const headerRow = header(sheet, [
    'No.', 'Name', 'SAP ID', 'Email', 'Account', 'Status', 'Round', 'Late', 'Marked at', 'Confirmed at',
    'Location', 'Distance (m)', 'GPS accuracy (m)', 'Same phone as', 'Marked by'
  ]);
  session.marks.forEach((mark, index) => {
    const row = sheet.addRow([
      index + 1, mark.name, mark.sapId || '', mark.email || '', mark.isGuest ? 'Guest' : mark.email ? 'College' : 'No account',
      STATUS[mark.status] || mark.status, mark.round, mark.late ? 'Yes' : 'No',
      when(mark.markedAt), when(mark.confirmedAt),
      mark.location ? (mark.location.status === 'inside' ? 'In classroom' : 'Uncertain GPS') : 'Not checked',
      mark.location?.distanceMeters ?? '', mark.location?.accuracyMeters ?? '',
      mark.sameDeviceAs.join(', '),
      mark.addedByTeacher ? 'Teacher' : 'Student (QR)'
    ]);
    row.getCell(6).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FILL[mark.status] || 'FFFFFFFF' } };
  });
  sheet.getColumn(9).numFmt = 'dd-mmm-yyyy hh:mm:ss';
  sheet.getColumn(10).numFmt = 'dd-mmm-yyyy hh:mm:ss';
  [6, 28, 12, 30, 11, 22, 7, 6, 20, 20, 14, 12, 16, 30, 13].forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: 15 } };

  const rounds = workbook.addWorksheet('Rounds', { views: [{ showGridLines: false }] });
  header(rounds, ['Round', 'Opened at', 'Closed at', 'Marked in this round']);
  for (const round of session.rounds) {
    rounds.addRow([round.number, when(round.openedAt), round.closedAt ? when(round.closedAt) : 'Still open',
      session.marks.filter((mark) => mark.round === round.number && mark.status !== 'rejected').length]);
  }
  rounds.getColumn(2).numFmt = 'dd-mmm-yyyy hh:mm:ss';
  rounds.getColumn(3).numFmt = 'dd-mmm-yyyy hh:mm:ss';
  [8, 22, 22, 20].forEach((width, index) => { rounds.getColumn(index + 1).width = width; });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
