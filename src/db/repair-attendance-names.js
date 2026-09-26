/**
 * Attendance once read the signed-in person's name from the wrong field, so
 * every mark was saved as "Student", and a SAP ID first given while marking
 * attendance went onto a profile with no name. This puts the real names back
 * when the server starts: from the account, or - for a guest - from their
 * session while it lasts. A name it cannot find is left as it is, and a
 * second run finds nothing more to do.
 */
const FALLBACK = 'Student';
const clean = (value) => String(value || '').replace(/^Guest:\s*/, '').trim();

export async function repairAttendanceNames(database) {
  const accounts = database.collection('accounts');
  const sessions = database.collection('portalSessions');
  const profiles = database.collection('studentProfiles');
  const attendance = database.collection('attendanceSessions');

  const nameOf = async (email) => {
    if (!email) return '';
    const account = await accounts.findOne({ _id: email }, { projection: { displayName: 1 } });
    if (clean(account?.displayName)) return clean(account.displayName);
    const session = await sessions.findOne(
      { email, displayName: { $nin: [null, ''] } },
      { sort: { createdAt: -1 }, projection: { displayName: 1 } }
    );
    return clean(session?.displayName);
  };

  for (const profile of await profiles.find({ displayName: { $in: [null, ''] } }, { projection: { email: 1 } }).toArray()) {
    const name = await nameOf(profile.email);
    if (name) await profiles.updateOne({ _id: profile._id }, { $set: { displayName: name } });
  }

  for (const session of await attendance.find({ 'marks.name': FALLBACK }, { projection: { code: 1, marks: 1 } }).toArray()) {
    for (const mark of session.marks.filter((entry) => entry.name === FALLBACK)) {
      const name = await nameOf(mark.email);
      if (name && name !== FALLBACK) {
        await attendance.updateOne({ code: session.code, 'marks.id': mark.id }, { $set: { 'marks.$.name': name } });
      }
    }
  }
}
