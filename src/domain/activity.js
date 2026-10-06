import { describeEvent, keptEvents } from './integrity.js';
import { kindWord } from './device.js';

/**
 * Every answer a student saves is appended to `attempt.answerLog`, capped so
 * a class of 200 stays well inside MongoDB's document limit. The integrity
 * events keep their own capped log. This file merges both, plus the
 * registration and attempt milestones, into one timeline per student.
 */
export const ANSWER_LOG_MAX = 150;
// Typing a short answer autosaves every half second; saves of the same
// question closer together than this are one entry in the log.
export const TYPING_MERGE_MS = 60_000;

const optionTexts = (question, ids) => (ids || [])
  .map((id) => question?.options?.[Number(id)])
  .filter((text) => text !== undefined);

function answerEntries(test, attempt) {
  const questions = new Map((test.questions || []).map((question) => [question.id, question]));
  const numbers = new Map((attempt.questions || []).map((assigned) => [assigned.questionId, assigned.questionIndex + 1]));
  const answeredBefore = new Set();

  // Attempts from before the answer log only know when each question was last answered.
  const log = attempt.answerLog?.length
    ? attempt.answerLog
    : (attempt.answers || []).filter((answer) => answer.answeredAt).map((answer) => ({
      questionId: answer.questionId, at: answer.answeredAt, selectedOptions: answer.selectedOptions,
      textLength: (answer.answerText || '').length, cleared: false
    }));

  return log.map((entry) => {
    const question = questions.get(entry.questionId);
    const number = numbers.get(entry.questionId) ?? '?';
    const changed = answeredBefore.has(entry.questionId);
    if (entry.cleared) {
      answeredBefore.delete(entry.questionId);
      return { at: entry.at, kind: 'answer', label: `Cleared answer to Q${number}`, detail: '' };
    }
    answeredBefore.add(entry.questionId);
    const detail = question?.manualGrading
      ? `Wrote ${entry.textLength || 0} character${entry.textLength === 1 ? '' : 's'}`
      : optionTexts(question, entry.selectedOptions).join(' • ');
    // Held on the device by a lost connection (domain/late-answers.js): placed
    // when the device says it was made, and marked with when it arrived.
    if (entry.late) {
      return {
        at: entry.late.madeAt || entry.at,
        kind: 'late',
        label: `${changed ? 'Changed answer to' : 'Answered'} Q${number} (arrived late)`,
        detail: [detail, 'time is when the device says it was made'].filter(Boolean).join(' · '),
        late: { madeAt: new Date(entry.late.madeAt || entry.at).toISOString(), arrivedAt: new Date(entry.at).toISOString() }
      };
    }
    return { at: entry.at, kind: 'answer', label: `${changed ? 'Changed answer to' : 'Answered'} Q${number}`, detail };
  });
}

const EVENT_KIND = {
  venue_left: 'exit', venue_returned: 'return',
  fullscreen_exit: 'exit', fullscreen_return: 'return', integrity_flag: 'flag',
  attempt_locked: 'lock', attempt_warned: 'flag', attempt_resumed: 'lock', attempt_restarted: 'restart',
  teacher_paused: 'lock', teacher_continued: 'lock', teacher_submitted: 'restart', teacher_reopened: 'restart',
  device_kind_changed: 'flag',
  // Noted for the teacher, never counted as leaving.
  connection_lost: 'offline', late_answer: 'late'
};

/** One student's whole test, oldest first. */
export function activityLog(test, registration) {
  const attempt = registration.attempt;
  const entries = [];
  const add = (at, kind, label, detail = '', durationMs = null) => { if (at) entries.push({ at, kind, label, detail, durationMs }); };

  add(registration.requestedAt, 'join', 'Asked to join the test');
  if (registration.decidedAt) {
    add(registration.decidedAt, 'join', registration.status === 'rejected' ? 'Registration rejected' : 'Registration approved');
  }
  if (attempt) {
    add(attempt.startedAt, 'start', 'Started the test', attempt.device ? `On a ${kindWord(attempt.device.kind)} (${attempt.device.label})` : '');
    entries.push(...answerEntries(test, attempt));
    for (const event of keptEvents(attempt.events)) {
      const described = describeEvent(event);
      const label = event.type === 'fullscreen_exit' ? `Left the test: ${described.label.toLowerCase()}` : described.label;
      add(event.createdAt, EVENT_KIND[event.type] || 'other', label, described.detail || '', described.durationMs);
    }
    // Strict timing: each question closing, by the student or by its clock.
    const numbers = new Map((attempt.questions || []).map((assigned) => [assigned.questionId, assigned.questionIndex + 1]));
    for (const entry of attempt.strict?.log || []) {
      const seconds = Math.max(0, Math.round((new Date(entry.closedAt) - new Date(entry.shownAt)) / 1000));
      add(entry.closedAt, entry.how === 'time' ? 'lock' : 'answer',
        entry.how === 'time' ? `Time ran out on Q${numbers.get(entry.questionId) ?? '?'}` : `Moved on from Q${numbers.get(entry.questionId) ?? '?'}`,
        `after ${seconds}s`);
    }
    if (attempt.status === 'submitted') add(attempt.submittedAt, 'submit', attempt.submittedBy === 'time' ? 'Submitted automatically (time up)' : 'Submitted the test');
  }
  add(registration.exitedAt, 'submit', 'Signed out (guest) - paper submitted');

  return entries
    .map((entry, order) => ({ ...entry, order }))
    .sort((a, b) => new Date(a.at) - new Date(b.at) || a.order - b.order)
    .map(({ order, ...entry }) => ({ ...entry, at: new Date(entry.at).toISOString() }));
}
