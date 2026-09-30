import { accounts, attendanceSessions, registrations, tests } from '../db/index.js';
import { canManageUsers } from '../auth/portal-auth.js';
import { adminEmail } from '../data/test-repository.js';

/**
 * The faculty home page's numbers, counted in the database. The Tests page's
 * list reads every student's answers to work out scores; the home page only
 * needs how many of each thing there is, so it asks for exactly that.
 */
export async function homeSummary(req) {
  const owner = adminEmail(req);
  const owned = await tests().find({ ownerEmail: owner }, { projection: { _id: 0, code: 1, isStarted: 1, isClosed: 1, archivedAt: 1 } }).toArray();
  const inTests = { testCode: { $in: owned.map((test) => test.code) } };
  const count = (filter) => (owned.length ? registrations().countDocuments({ ...inTests, ...filter }) : 0);
  const managesUsers = canManageUsers(req.portalUser);
  const [pending, submitted, toMark, sessions, open, accountCount, facultyCount] = await Promise.all([
    count({ status: 'pending' }),
    count({ 'attempt.status': 'submitted' }),
    // Handed in, with a written answer nobody has marked yet.
    count({ 'attempt.status': 'submitted', 'attempt.answers': { $elemMatch: { isCorrect: null, answeredAt: { $ne: null } } } }),
    attendanceSessions().countDocuments({ ownerEmail: owner }),
    attendanceSessions().countDocuments({ ownerEmail: owner, rounds: { $elemMatch: { closedAt: null } } }),
    managesUsers ? accounts().countDocuments({}) : null,
    // Faculty accounts carry the admin role; everyone else is a student.
    managesUsers ? accounts().countDocuments({ role: 'admin' }) : null
  ]);
  return {
    tests: {
      total: owned.filter((test) => !test.archivedAt).length,
      live: owned.filter((test) => test.isStarted && !test.isClosed).length,
      pending
    },
    results: { submitted, toMark },
    attendance: { sessions, open },
    users: accountCount === null ? null : { accounts: accountCount, students: accountCount - facultyCount, faculty: facultyCount }
  };
}
