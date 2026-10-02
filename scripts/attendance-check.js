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
  addManualMark, addManualMarks, attendanceExportData, attendanceForAdmin, attendanceRegisterData, attendanceRoster, attendanceForStudent,
  attendanceSettings, beginAttendanceGuest, closeAttendance, createAttendance, listAttendance, markAttendance, reopenAttendance, searchPeople,
  setMarkStatus, setMarkStatuses
} from '../src/services/attendance-service.js';
import { buildAttendanceRegisterSpreadsheet, buildAttendanceSpreadsheet } from '../src/export/attendance-sheet.js';

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
  assert.equal(session.qr.keys.length, 30, 'the teacher\'s screen gets the next minute of QR codes');
  assert.match(session.qr.link, new RegExp(`\\?attend=${session.code}&k=$`));
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

  // Ben signs in on Asha's phone and tries her scan: each scan marks one person.
  await expectPublicError(() => markAttendance({ ...student('ben'), signedCookies: asha.request.signedCookies }, session.code, { ...inClass, sapId: sap(2), deviceId: 'phone-1' }), 403, 'SCAN_AGAIN');
  const spent = await attendanceForStudent({ ...student('ben'), signedCookies: asha.request.signedCookies }, cookieResponse(), session.code);
  assert.equal(spent.session.hasPass, false, 'a used pass reads as "scan again"');

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
  assert.equal(view.qr, null, 'no QR codes once closed');
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

  // A guest's SAP ID is compared only with other guests': one a registered
  // student has is fine, that student can still mark, and only a second
  // guest giving it is refused - scanning or added by the teacher.
  const { session: kinds } = await createAttendance(adminReq, { title: `SAP kinds ${identifier}`, allowGuests: true });
  createdCodes.push(kinds.code);
  const guestScan2 = async (name) => {
    const visitor = await beginAttendanceGuest(cookieResponse(), { attendanceCode: kinds.code, name });
    return scan({ portalUser: { email: visitor.user.email, displayName: visitor.user.name, role: visitor.user.role } }, kinds);
  };
  // Asha's SAP ID (sap 1) is on her account: a guest gives it first, then Asha marks herself.
  await markAttendance((await guestScan2('Visitor Two')).request, kinds.code, { sapId: sap(1) });
  await markAttendance((await scan(student('asha'), kinds)).request, kinds.code, {});
  let kindMarks = (await attendanceForAdmin(adminReq, kinds.code)).session.marks;
  assert.equal(kindMarks.filter((mark) => mark.sapId === sap(1)).length, 2, 'a guest with a registered SAP ID does not stop its student marking');
  assert.deepEqual(kindMarks.filter((mark) => mark.sapId === sap(1)).map((mark) => Boolean(mark.isGuest)).sort(), [false, true]);
  await expectPublicError(async () => markAttendance((await guestScan2('Visitor Three')).request, kinds.code, { sapId: sap(1) }), 409);
  // Added by the teacher: a guest with Chen's SAP ID (sap 3), then Chen himself; a second guest with it is refused.
  await addManualMark(adminReq, kinds.code, { as: 'guest', sapId: sap(3), name: 'Guest With Chens SAP' });
  await addManualMark(adminReq, kinds.code, { as: 'college', lookup: sap(3) });
  await expectPublicError(() => addManualMark(adminReq, kinds.code, { as: 'guest', sapId: sap(3), name: 'Second Guest' }), 409);
  kindMarks = (await attendanceForAdmin(adminReq, kinds.code)).session.marks;
  assert.equal(kindMarks.filter((mark) => mark.sapId === sap(3)).length, 2, 'one guest and Chen share a SAP ID; no more');

  // One mark per phone: a second student on a phone already used is sent to
  // the teacher - known by the server's cookie even with the page's id gone -
  // until the first mark is removed. Lookalike phones are "possibly" the same.
  const { session: strict } = await createAttendance(adminReq, { title: `Strict ${identifier}`, oneMarkPerPhone: true });
  createdCodes.push(strict.code);
  assert.equal(strict.oneMarkPerPhone, true);
  const onPhone = async (name, cookie) => {
    const scanned = await scan(student(name), strict);
    return { ...scanned.request, signedCookies: { ...scanned.request.signedCookies, attend_device: cookie } };
  };
  const pixel = { model: 'Pixel 8', platformVersion: '15', chPlatform: 'Android', screenW: 412, screenH: 915, dpr: 2.625, cores: 8, memory: 8 };
  await markAttendance(await onPhone('asha', 'cookie-a'), strict.code, { sapId: sap(1), deviceId: 'page-a', phone: pixel });
  await expectPublicError(async () => markAttendance(await onPhone('ben', 'cookie-a'), strict.code, { sapId: sap(2), deviceId: 'page-new' }), 409, 'PHONE_USED');
  // A private tab on the same phone: a new cookie and page id, the same phone traits - allowed, and pointed out.
  await markAttendance(await onPhone('dev', 'cookie-d'), strict.code, { sapId: sap(4), deviceId: 'page-d', phone: pixel });
  let strictView = (await attendanceForAdmin(adminReq, strict.code)).session;
  assert.deepEqual(strictView.marks.find((mark) => mark.name === 'Student dev').similarDeviceAs, ['Student asha']);
  assert.equal(strictView.flaggedCount, 2);
  const ashaStrict = strictView.marks.find((mark) => mark.name === 'Student asha');
  await setMarkStatus(adminReq, strict.code, ashaStrict.id, 'reject');
  await markAttendance(await onPhone('ben', 'cookie-a'), strict.code, { sapId: sap(2), deviceId: 'page-new' });

  // Several at once: removed together, put back together.
  strictView = (await attendanceForAdmin(adminReq, strict.code)).session;
  const others = strictView.marks.filter((mark) => mark.status !== 'rejected').map((mark) => mark.id);
  let changed = await setMarkStatuses(adminReq, strict.code, others, 'reject');
  assert.equal(changed.changed, 2);
  assert.equal(changed.session.rejectedCount, 3);
  changed = await setMarkStatuses(adminReq, strict.code, [...others, ashaStrict.id], 'restore');
  assert.equal(changed.changed, 3);
  assert.equal(changed.session.rejectedCount, 0);
  await expectPublicError(() => setMarkStatuses(adminReq, strict.code, ['nobody'], 'reject'), 404);

  // The class roster: whoever came to its other sessions and not this one is
  // absent - and can be marked present together.
  const classTitle = `Class ${identifier}`;
  const { session: monday } = await createAttendance(adminReq, { title: classTitle, allowGuests: true });
  createdCodes.push(monday.code);
  await addManualMarks(adminReq, monday.code, [
    { as: 'college', lookup: sap(3) }, { as: 'guest', sapId: sap(8), name: 'Guest Regular' }
  ]);
  const { session: tuesday } = await createAttendance(adminReq, { title: classTitle });
  createdCodes.push(tuesday.code);
  await addManualMark(adminReq, tuesday.code, { as: 'college', lookup: sap(3) });
  const roster = await attendanceRoster(adminReq, tuesday.code);
  assert.equal(roster.sessionCount, 1);
  assert.deepEqual(roster.people.map((person) => person.name).sort(), ['Guest Regular', 'Student chen']);
  const full = await attendanceExportData(adminReq, tuesday.code);
  assert.deepEqual(full.absent.map((person) => person.name), ['Guest Regular'], 'Chen is here; the guest is absent');
  const both = await addManualMarks(adminReq, tuesday.code, [{ as: 'guest', sapId: sap(8), name: 'Guest Regular' }, { as: 'college', lookup: sap(3) }]);
  assert.equal(both.added, 1);
  assert.equal(both.skipped.length, 1, 'someone already marked is skipped, and said so');
  assert.equal((await attendanceExportData(adminReq, tuesday.code)).absent.length, 0);

  // A filtered download: only the rows on screen, in that order, with the line saying how.
  const tuesdayMarks = (await attendanceForAdmin(adminReq, tuesday.code)).session.marks;
  const shownOnly = await attendanceExportData(adminReq, tuesday.code, { ids: [tuesdayMarks[1].id], note: 'Shown on screen: Marked · Guest' });
  assert.deepEqual(shownOnly.marks.map((mark) => mark.name), ['Guest Regular']);
  assert.equal(shownOnly.note, 'Shown on screen: Marked · Guest');
  await expectPublicError(() => attendanceExportData(adminReq, tuesday.code, { ids: ['nobody'] }), 400);
  const filteredBook = new ExcelJS.Workbook();
  await filteredBook.xlsx.load(await buildAttendanceSpreadsheet(shownOnly));
  assert.equal(filteredBook.getWorksheet('Attendance').rowCount, 4 + 1, 'title, summary, the filter line, header, one row');

  // The list: flags counted, and the last classroom offered for the next session.
  await attendanceSettings(adminReq, kinds.code, { locationRequired: true, locationRadiusMeters: 60, locationLatitude: 30.1, locationLongitude: 78.1 });
  const listed = await listAttendance(adminReq);
  // Asha back: she and Ben share a phone, and Dev's looks like hers.
  assert.equal(listed.sessions.find((entry) => entry.code === strict.code).flaggedCount, 3);
  assert.deepEqual(listed.lastVenue, { locationRadiusMeters: 60, locationLatitude: 30.1, locationLongitude: 78.1 }, 'the latest session with a distance check');

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

  // Many sessions as one register: only this teacher's, only those chosen, oldest first.
  const everything = await attendanceRegisterData(adminReq, {});
  assert.ok(everything.sessions.length >= 3 && everything.sessions.every((entry) => createdCodes.includes(entry.code)), 'all of theirs, nobody else\'s');
  const chosen = await attendanceRegisterData(adminReq, { codes: `${kinds.code.toLowerCase()}, ${session.code}`, min: 60 });
  assert.deepEqual(chosen.sessions.map((entry) => entry.code), [session.code, kinds.code]);
  assert.equal(chosen.minShare, 0.6, 'the minimum the teacher chose');
  assert.equal(everything.minShare, 0.75, '75% unless chosen');
  await expectPublicError(() => attendanceRegisterData({ portalUser: { email: `other-${identifier}@ddn.upes.ac.in`, role: 'admin' } }, { codes: session.code }), 404);
  const register = new ExcelJS.Workbook();
  await register.xlsx.load(await buildAttendanceRegisterSpreadsheet(chosen));
  const registerSheet = register.getWorksheet('Register');
  assert.ok(String(registerSheet.getRow(4).getCell(6).value).startsWith(`${chosen.sessions[0].title}\n`));
  const ashaRow = registerSheet.getRows(5, registerSheet.rowCount - 4).find((row) => row.getCell(2).value === 'Student asha');
  assert.ok(ashaRow, 'a student who marked is on the register');

  console.log('Attendance check passed: fresh-QR pass, one mark per scan, location check, one mark per account and SAP ID, shared-phone flag, one mark per phone, lookalike phones, bulk remove/restore, the class roster and marking absentees present, filtered downloads, guests only when allowed, close marks present, take again for latecomers, remove/restore, adding students by hand as college students or guests, searching registered users, repairing names saved as "Student", editing details, owner-only access, the Excel export, and many sessions as one register.');
} finally {
  if (createdCodes.length) await attendanceSessions().deleteMany({ code: { $in: createdCodes } });
  await studentProfiles().deleteMany({ email: { $in: profileEmails } });
  await accounts().deleteMany({ _id: { $in: profileEmails } });
  await closeDatabase();
}
