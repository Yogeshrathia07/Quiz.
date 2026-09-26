/**
 * End-to-end check of attendance against a real MongoDB: an admin opens a
 * session, students scan and mark, the admin closes it, takes it again for a
 * latecomer, removes a mark, and exports. Run it with `npm run test:attendance`.
 */
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { accounts, attendanceSessions, closeDatabase, initializeDatabase, portalSessions, studentProfiles } from '../src/db/index.js';
import { repairAttendanceNames } from '../src/db/repair-attendance-names.js';
import { PublicTestError } from '../src/lib/errors.js';
import { currentQrKey } from '../src/domain/attendance.js';
import {
  addManualMark, attendanceExportData, attendanceForAdmin, attendanceForStudent, attendanceQrSvg, attendanceSettings, beginAttendanceGuest,
  closeAttendance, createAttendance, markAttendance, reopenAttendance, searchPeople, setMarkStatus
} from '../src/services/attendance-service.js';
import { buildAttendanceSpreadsheet } from '../src/export/attendance-sheet.js';

const identifier = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const sapBase = Date.now();
const sap = (offset) => String(100_000_000 + ((sapBase + offset * 7_919) % 890_000_000));
const studentEmail = (name) => `att-${name}-${identifier}@stu.upes.ac.in`;
// Shaped like req.portalUser really is - the stored session - so the name is `displayName`.
const adminReq = { portalUser: { email: `att-admin-${identifier}@ddn.upes.ac.in`, displayName: 'Attendance Admin', role: 'admin' } };
const student = (name) => ({ portalUser: { email: studentEmail(name), displayName: `Student ${name}`, role: 'student' } });
const profileEmails = ['asha', 'ben', 'chen', 'dev', 'erin'].map(studentEmail);
const createdCodes = [];

function cookieResponse() {
  const cookies = new Map();
  return { cookies, cookie(name, value) { cookies.set(name, value); } };
}

async function expectPublicError(action, status, code) {
  await assert.rejects(action, (error) => error instanceof PublicTestError && error.status === status && (!code || error.code === code));
}

/** A student's phone scanning the QR on the screen: it comes away with a pass. */
async function scan(request, session) {
  const doc = await attendanceSessions().findOne({ code: session.code });
  const response = cookieResponse();
  const seen = await attendanceForStudent(request, response, session.code, currentQrKey(doc.secret));
  const pass = response.cookies.get(`attend_pass_${session.code}`);
  return { seen, request: { ...request, signedCookies: pass ? { [`attend_pass_${session.code}`]: pass } : {} } };
}

await initializeDatabase();
try {
  const { session } = await createAttendance(adminReq, {
    title: `Attendance ${identifier}`, allowGuests: false,
    locationRequired: true, locationRadiusMeters: 100, locationLatitude: 30.3165, locationLongitude: 78.0322
  });
  createdCodes.push(session.code);
  assert.equal(session.isOpen, true, 'a new session is open at once');
  assert.match(await attendanceQrSvg(adminReq, session.code, 'http://localhost'), /<svg/);
  const inClass = { latitude: 30.3165, longitude: 78.0322, accuracyMeters: 15 };

  // No pass without a fresh QR: a shared link, or an old photo of the QR.
  const stale = await attendanceForStudent(student('asha'), cookieResponse(), session.code, 'not-the-code');
  assert.equal(stale.session.hasPass, false);
  await expectPublicError(() => markAttendance(student('asha'), session.code, { ...inClass, sapId: sap(1) }), 403, 'SCAN_AGAIN');

  // Asha scans in class and is pending.
  const asha = await scan(student('asha'), session);
  assert.equal(asha.seen.session.hasPass, true);
  let marked = await markAttendance(asha.request, session.code, { ...inClass, sapId: sap(1), deviceId: 'phone-1' });
  assert.equal(marked.session.myMark.status, 'pending');
  marked = await markAttendance(asha.request, session.code, { ...inClass, deviceId: 'phone-1' });
  assert.equal(marked.session.myMark.status, 'pending', 'marking twice changes nothing');

  // Location: refused outside, required when the check is on.
  const ben = await scan(student('ben'), session);
  await expectPublicError(() => markAttendance(ben.request, session.code, { latitude: 30.33, longitude: 78.05, accuracyMeters: 10, sapId: sap(2) }), 403, 'OUT_OF_RANGE');
  await expectPublicError(() => markAttendance(ben.request, session.code, { sapId: sap(2) }), 403, 'LOCATION_NEEDED');
  // Ben marks from Asha's phone: allowed, but the admin sees it.
  await markAttendance(ben.request, session.code, { ...inClass, sapId: sap(2), deviceId: 'phone-1' });
  // One SAP ID, one mark.
  const chen = await scan(student('chen'), session);
  await expectPublicError(() => markAttendance(chen.request, session.code, { ...inClass, sapId: sap(1) }), 409);

  // Guests only when allowed.
  await expectPublicError(() => beginAttendanceGuest(cookieResponse(), { attendanceCode: session.code, name: 'Visitor' }), 403);
  await attendanceSettings(adminReq, session.code, { allowGuests: true });
  const guestResponse = cookieResponse();
  const guest = await beginAttendanceGuest(guestResponse, { attendanceCode: session.code, name: 'Visitor' });
  const guestScan = await scan({ portalUser: { email: guest.user.email, displayName: guest.user.name, role: guest.user.role } }, session);
  await markAttendance(guestScan.request, session.code, { ...inClass, sapId: sap(9) });

  let view = (await attendanceForAdmin(adminReq, session.code)).session;
  assert.equal(view.pendingCount, 3);
  assert.equal(view.presentCount, 0);
  const ashaMark = view.marks.find((mark) => mark.name === 'Student asha');
  assert.deepEqual(ashaMark.sameDeviceAs, ['Student ben'], 'one phone marking two students is flagged');
  assert.equal(ashaMark.location.status, 'inside');
  assert.equal(view.marks.find((mark) => mark.isGuest).name, 'Visitor');
  assert.equal((await studentProfiles().findOne({ email: studentEmail('asha') })).displayName, 'Student asha', 'a SAP ID given while marking keeps the name');

  // Closing makes every pending mark present, with the time.
  view = (await closeAttendance(adminReq, session.code)).session;
  assert.equal(view.isOpen, false);
  assert.equal(view.presentCount, 3);
  assert.ok(view.marks.every((mark) => mark.confirmedAt));
  await expectPublicError(() => closeAttendance(adminReq, session.code), 409);
  await expectPublicError(() => attendanceQrSvg(adminReq, session.code, 'http://localhost'), 409);
  // Too late while closed.
  await expectPublicError(() => markAttendance(chen.request, session.code, { ...inClass, sapId: sap(3) }), 409, 'ATTENDANCE_CLOSED');

  // Taken again for a latecomer: the others stay present, the latecomer is late.
  view = (await reopenAttendance(adminReq, session.code)).session;
  assert.equal(view.round, 2);
  assert.equal(view.presentCount, 3);
  await expectPublicError(() => reopenAttendance(adminReq, session.code), 409);
  const dev = await scan(student('dev'), session);
  const late = await markAttendance(dev.request, session.code, { ...inClass, sapId: sap(4) });
  assert.equal(late.session.myMark.late, true);
  assert.equal(late.session.myMark.round, 2);
  view = (await closeAttendance(adminReq, session.code)).session;
  assert.equal(view.presentCount, 4);
  assert.ok(view.rounds.every((round) => round.openedAt && round.closedAt), 'each round keeps its times');

  // Removing a proxy, and putting them back.
  const benMark = view.marks.find((mark) => mark.name === 'Student ben');
  view = (await setMarkStatus(adminReq, session.code, benMark.id, 'reject')).session;
  assert.equal(view.presentCount, 3);
  assert.equal(view.rejectedCount, 1);
  view = (await setMarkStatus(adminReq, session.code, benMark.id, 'restore')).session;
  assert.equal(view.marks.find((mark) => mark.id === benMark.id).status, 'present', 'restored in a closed round is present');

  // Added by hand, as a college student (by SAP ID or college email - they
  // bring their own name, and see the mark too) or as a guest.
  await studentProfiles().insertOne({ email: studentEmail('chen'), displayName: 'Student chen', sapId: sap(3), createdAt: new Date(), updatedAt: new Date() });
  let added = await addManualMark(adminReq, session.code, { as: 'college', lookup: sap(3) });
  assert.equal(added.added.name, 'Student chen', 'a registered SAP ID brings its own name');
  const chenMark = added.session.marks.find((mark) => mark.sapId === sap(3));
  assert.equal(chenMark.status, 'present', 'the teacher adding someone makes them present at once');
  assert.equal(chenMark.addedByTeacher, true);
  assert.equal(chenMark.isGuest, false);
  const chenSees = await attendanceForStudent(student('chen'), cookieResponse(), session.code);
  assert.equal(chenSees.session.myMark.status, 'present', 'the student sees a mark the teacher added');
  await expectPublicError(() => addManualMark(adminReq, session.code, { as: 'college', lookup: sap(3) }), 409);
  await expectPublicError(() => addManualMark(adminReq, session.code, { as: 'college', lookup: studentEmail('dev') }), 409, undefined);
  await expectPublicError(() => addManualMark(adminReq, session.code, { as: 'college', lookup: sap(5) }), 404, 'NOT_REGISTERED');
  await expectPublicError(() => addManualMark(adminReq, session.code, { as: 'guest', sapId: sap(3), name: 'Not Chen' }), 409);
  added = await addManualMark(adminReq, session.code, { as: 'guest', sapId: sap(5), name: 'No Phone' });
  const guestMark = added.session.marks.find((mark) => mark.sapId === sap(5));
  assert.equal(guestMark.isGuest, true);
  assert.equal(guestMark.name, 'No Phone');
  // Someone removed is put back with Restore, not added a second time.
  await setMarkStatus(adminReq, session.code, benMark.id, 'reject');
  await expectPublicError(() => addManualMark(adminReq, session.code, { as: 'college', lookup: sap(2) }), 409);
  await setMarkStatus(adminReq, session.code, benMark.id, 'restore');

  // Finding a registered user to add: by part of the name, the SAP ID, or
  // the email - each saying whether they are already on this session.
  const byName = (await searchPeople(adminReq, session.code, 'student ch')).people.find((person) => person.email === studentEmail('chen'));
  assert.equal(byName?.sapId, sap(3), 'a name search brings the SAP ID from the profile');
  assert.equal(byName.marked, true, 'someone already on the session says so');
  assert.ok((await searchPeople(adminReq, session.code, sap(4))).people.some((person) => person.email === studentEmail('dev')), 'found by SAP ID');
  assert.ok((await searchPeople(adminReq, session.code, `att-asha-${identifier}`)).people.some((person) => person.name === 'Student asha'), 'found by email');
  assert.deepEqual((await searchPeople(adminReq, session.code, 'a')).people, [], 'one character is not a search');

  // Marks saved as "Student" before the name was read from the right field,
  // and a profile saved without one, get the account's name back.
  const erinEmail = studentEmail('erin');
  await accounts().insertOne({ _id: erinEmail, email: erinEmail, displayName: 'Student erin', role: 'student', createdAt: new Date() });
  await studentProfiles().insertOne({ email: erinEmail, displayName: null, sapId: sap(6), createdAt: new Date(), updatedAt: new Date() });
  const unnamed = { id: `unnamed-${identifier}`, email: erinEmail, name: 'Student', sapId: sap(6), isGuest: false, status: 'present', round: 1, markedAt: new Date(), confirmedAt: new Date(), rejectedAt: null, location: null, deviceId: null };
  await attendanceSessions().updateOne({ code: session.code }, { $push: { marks: unnamed } });
  const collections = { accounts, portalSessions, studentProfiles, attendanceSessions };
  await repairAttendanceNames({ collection: (name) => collections[name]() });
  assert.equal((await attendanceSessions().findOne({ code: session.code })).marks.find((mark) => mark.id === unnamed.id).name, 'Student erin');
  assert.equal((await studentProfiles().findOne({ email: erinEmail })).displayName, 'Student erin');
  await attendanceSessions().updateOne({ code: session.code }, { $pull: { marks: { id: unnamed.id } } });

  // The details can change after the session is made.
  view = (await attendanceSettings(adminReq, session.code, { title: `Renamed ${identifier}`, locationRequired: false })).session;
  assert.equal(view.title, `Renamed ${identifier}`);
  assert.equal(view.locationRequired, false);

  // Someone the teacher added, removed and put back while attendance is still
  // open is present again - not pending, as a scanned mark would be.
  const { session: open } = await createAttendance(adminReq, { title: `Restore ${identifier}` });
  createdCodes.push(open.code);
  const byHand = (await addManualMark(adminReq, open.code, { as: 'guest', sapId: sap(7), name: 'Put Back' })).session.marks[0];
  await setMarkStatus(adminReq, open.code, byHand.id, 'reject');
  const putBack = (await setMarkStatus(adminReq, open.code, byHand.id, 'restore')).session;
  assert.equal(putBack.isOpen, true);
  assert.equal(putBack.marks[0].status, 'present', 'a mark added by hand comes back present');

  // Another admin cannot see it.
  await expectPublicError(() => attendanceForAdmin({ portalUser: { email: `other-${identifier}@ddn.upes.ac.in`, role: 'admin' } }, session.code), 404);

  // Export.
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildAttendanceSpreadsheet(await attendanceExportData(adminReq, session.code)));
  assert.equal(workbook.getWorksheet('Attendance').getRow(3).getCell(2).value, 'Name');
  const sheet = workbook.getWorksheet('Attendance');
  assert.equal(sheet.rowCount, 3 + 6, 'title, summary, header, then Asha, Ben, the guest, Dev, and the two added by hand');
  assert.equal(sheet.getRow(3).getCell(15).value, 'Marked by');
  assert.equal(sheet.getRow(sheet.rowCount).getCell(15).value, 'Teacher');
  assert.equal(sheet.getRow(sheet.rowCount).getCell(5).value, 'Guest');
  assert.equal(workbook.getWorksheet('Rounds').rowCount, 3);

  console.log('Attendance check passed: fresh-QR pass, location check, one mark per account and SAP ID, shared-phone flag, guests only when allowed, close marks present, take again for latecomers, remove/restore, adding students by hand as college students or guests, searching registered users, repairing names saved as "Student", editing details, owner-only access, and the Excel export.');
} finally {
  if (createdCodes.length) await attendanceSessions().deleteMany({ code: { $in: createdCodes } });
  await studentProfiles().deleteMany({ email: { $in: profileEmails } });
  await accounts().deleteMany({ _id: { $in: profileEmails } });
  await closeDatabase();
}
