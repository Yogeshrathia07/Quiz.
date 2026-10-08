import { kindWord } from './device.js';

/**
 * Integrity record of one attempt
 * -------------------------------
 * Two sets of numbers are kept, on purpose:
 *
 * - `fullscreenExitCount` / `fullscreenTotalAbsenceMs` drive the LOCK. They
 *   count since the attempt was last unlocked - automatically after the lock
 *   wait, or by the admin - so every unlock gives a fresh set of tries.
 * - `integrity` is the LIFETIME record for the report. Reviving never clears
 *   it and restarting carries it over, so the dashboard, analysis and export
 *   always show every time the student left, whatever the limits allowed.
 *
 * Leaving is recorded whether or not the test's limits permit it: a limit of 0
 * means "never lock", not "don't watch".
 *
 * Losing the connection is not leaving. It is noted - when, and for how long
 * (`offlineCount`, `offlineMs`, a `connection_lost` event) - for the teacher
 * to set against the rest of the log, and never counts towards a limit.
 * Papers from before that still carry it as a leave (`leaves.offline`).
 */

/** Why the student was away. Only these reach the database as counter keys. */
export const LEAVE_REASONS = Object.freeze({
  fullscreen: 'Left fullscreen',
  tab_switch: 'Switched app or tab',
  // On a laptop another window came to the front; on a phone something opened
  // over the test (the notification panel, a floating app, a search overlay).
  focus_lost: 'Another window or pop-up came in front',
  reload: 'Reloaded or reopened the page',
  not_fullscreen: 'Was not in fullscreen',
  // Papers from before going offline stopped counting as leaving.
  offline: 'Went offline',
  // The test shared the screen with something else (split screen, pop-up).
  split_screen: 'Used split screen'
});

/** Things worth noting that are not a departure and never lock. */
export const FLAG_REASONS = Object.freeze({
  copy: 'Tried to copy',
  cut: 'Tried to cut',
  paste: 'Tried to paste',
  drop: 'Tried to drag text in',
  context_menu: 'Opened the context menu',
  fullscreen_denied: 'Browser refused fullscreen',
  print: 'Tried to print',
  // Left the page while typing an answer and back within moments - often a
  // keyboard's own button (voice typing on Gboard or SwiftKey, its settings)
  // opening that keyboard's app on an iPhone, though the page cannot see why.
  // Noted in the log, never counted, and not a blocked action - see
  // KEYBOARD_GRACE_MS in attempt-service.js, which also caps how often.
  keyboard_app: 'Left for a moment while typing (not counted)'
});
/** Notes that are not blocked actions, left out of `flagCount`. */
const NOT_BLOCKED = new Set(['keyboard_app']);

/**
 * Keep the event log bounded. Every student lives in one test document, and
 * 200 students x 200 events stays far below MongoDB's 16 MB document limit.
 * The counters above keep counting after the log starts dropping old entries.
 */
export const MAX_EVENTS = 200;

/**
 * What leaving the test does - the admin's two switches, Warn and Lock:
 * 'record' (neither: every exit is only recorded), 'warn' (a warning each
 * time, never a lock), 'lock' (no warnings; past the limit the attempt waits
 * for the admin's approval) or 'warn_lock' (a numbered warning each time,
 * then the lock).
 * Tests made before the choice existed lock. `lockingEnabled` is the server-wide
 * switch (LOCK_ON_EXIT): off, nothing locks, whatever the test says.
 */
export const VIOLATION_ACTIONS = ['record', 'warn', 'lock', 'warn_lock'];
export const violationActionOf = (test) => (VIOLATION_ACTIONS.includes(test?.violationAction) ? test.violationAction : 'lock');
export const locksOnViolation = (test, lockingEnabled) => Boolean(lockingEnabled) && ['lock', 'warn_lock'].includes(violationActionOf(test));
/**
 * With Lock on, how many times the student may go past a limit - more exits
 * than allowed, or more time away in total than allowed - and only be warned.
 * The next time locks. 0 locks the first time, with no warning.
 */
export const warningsBeforeLockOf = (test) => (violationActionOf(test) === 'warn_lock'
  ? Math.max(1, Math.min(20, Number.isInteger(test.warningsBeforeLock) ? test.warningsBeforeLock : 1))
  : 0);
/** Whether the student's screen warns them on each exit: "warn only" and "warn, then lock". */
export const warnsOnViolation = (test) => ['warn', 'warn_lock'].includes(violationActionOf(test));

/**
 * Checks taken out because they were guesses that misfired or could not see
 * what they claimed to: a translator, a password manager or the phone
 * browser's own additions to the page passed for a browser extension; voice
 * typing or a keyboard's suggestion passed for pasted text; a screenshot is
 * taken by the operating system (a phone's buttons, Win+Shift+S never reach
 * the page), and developer tools open from the browser's menu unseen - only a
 * few keys were ever noticed, so "0" said nothing. Never recorded again - a
 * page still open from before may send them, and they are dropped - and those
 * already on a paper are left out of every count (`integritySummary` counts
 * FLAG_REASONS only), log and report.
 */
export const RETIRED_FLAGS = Object.freeze(['extension', 'text_burst', 'screenshot', 'devtools']);
const isRetiredFlag = (event) => event?.type === 'integrity_flag' && RETIRED_FLAGS.includes(event.detail);
/** A paper's event log, without the retired checks. */
export const keptEvents = (events) => (events || []).filter((event) => !isRetiredFlag(event));

export const leaveReason = (value) => (Object.hasOwn(LEAVE_REASONS, value) ? value : 'fullscreen');
export const flagReason = (value) => (Object.hasOwn(FLAG_REASONS, value) ? value : null);

export const emptyIntegrity = () => ({
  leaveCount: 0,
  awayMs: 0,
  longestAwayMs: 0,
  lockCount: 0,
  leaves: {},
  flags: {},
  // Offline periods: noted, never counted as leaving (see above).
  offlineCount: 0,
  offlineMs: 0,
  longestOfflineMs: 0,
  // Answers made in time on the device but held there by the connection (domain/late-answers.js).
  lateAnswers: 0
});

/**
 * Attempts written before the lifetime record existed only have their event
 * log; rebuild the same numbers from it so old results still report sensibly.
 */
function integrityFromEvents(events = []) {
  const record = emptyIntegrity();
  for (const event of events) {
    if (event.type === 'fullscreen_exit') {
      const reason = leaveReason(event.detail);
      record.leaveCount += 1;
      record.leaves[reason] = (record.leaves[reason] || 0) + 1;
    } else if (event.type === 'fullscreen_return') {
      const duration = Number(event.durationMs) || 0;
      record.awayMs += duration;
      record.longestAwayMs = Math.max(record.longestAwayMs, duration);
    } else if (event.type === 'attempt_locked') {
      record.lockCount += 1;
    } else if (event.type === 'connection_lost') {
      const duration = Number(event.durationMs) || 0;
      record.offlineCount += 1;
      record.offlineMs += duration;
      record.longestOfflineMs = Math.max(record.longestOfflineMs, duration);
    } else if (event.type === 'late_answer') {
      record.lateAnswers += 1;
    }
  }
  return record;
}

export const integrityRecord = (attempt) => (attempt?.integrity
  ? { ...emptyIntegrity(), ...attempt.integrity }
  : integrityFromEvents(attempt?.events));

/** The shape the dashboard, the analysis view and the export all read. */
export function integritySummary(attempt) {
  const record = integrityRecord(attempt);
  const leaves = Object.fromEntries(Object.keys(LEAVE_REASONS).map((key) => [key, Number(record.leaves?.[key]) || 0]));
  const flags = Object.fromEntries(Object.keys(FLAG_REASONS).map((key) => [key, Number(record.flags?.[key]) || 0]));
  return {
    leaveCount: record.leaveCount,
    awayMs: record.awayMs,
    longestAwayMs: record.longestAwayMs,
    lockCount: record.lockCount,
    leaves,
    flags,
    // Blocked actions only: a moment away while typing is a note, not a blocked action.
    flagCount: Object.entries(flags).reduce((total, [key, value]) => total + (NOT_BLOCKED.has(key) ? 0 : value), 0),
    // Offline periods, never counted as leaving; older papers' offline "leaves" are included.
    offline: {
      count: (Number(record.offlineCount) || 0) + leaves.offline,
      ms: Number(record.offlineMs) || 0,
      longestMs: Number(record.longestOfflineMs) || 0
    },
    lateAnswers: Number(record.lateAnswers) || 0,
    isAway: Boolean(attempt?.awaySince)
  };
}

const duration = (ms) => {
  const total = Math.round((Number(ms) || 0) / 1000);
  return total >= 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${total}s`;
};

const eventLabel = (event) => {
  if (event.type === 'fullscreen_exit') return LEAVE_REASONS[leaveReason(event.detail)];
  if (event.type === 'fullscreen_return') return 'Came back';
  if (event.type === 'integrity_flag') return FLAG_REASONS[event.detail] || 'Flagged';
  if (event.type === 'attempt_locked') return 'Attempt locked';
  if (event.type === 'attempt_warned') return 'Went past the limit';
  if (event.type === 'attempt_resumed') return event.detail === 'automatic' ? 'Unlocked automatically' : 'Revived by the administrator';
  if (event.type === 'attempt_restarted') return 'Restarted by the administrator';
  if (event.type === 'device_changed') return 'Continued in another browser or device';
  if (event.type === 'device_kind_changed') {
    const [opened, began] = String(event.detail || '').split(':');
    return `Opened the paper on a ${kindWord(opened)}${began && began !== opened ? ` (began on a ${kindWord(began)})` : ''}`;
  }
  if (event.type === 'venue_left') return 'Left the test venue';
  if (event.type === 'venue_returned') return 'Back at the test venue';
  if (event.type === 'teacher_paused') return 'Paused by the administrator (time stopped)';
  if (event.type === 'teacher_continued') return 'Continued by the administrator';
  if (event.type === 'teacher_submitted') return 'Handed in by the administrator';
  if (event.type === 'teacher_reopened') return event.durationMs ? `Paper reopened by the administrator, with ${Math.round(event.durationMs / 60_000)} more minutes` : 'Paper reopened by the administrator';
  if (event.type === 'connection_lost') return `Offline for about ${duration(event.durationMs)} (not counted as leaving)`;
  if (event.type === 'late_answer') return 'An answer arrived late, after the connection came back';
  return event.type;
};

/** One line of the timeline, readable without knowing the stored event names. */
export const describeEvent = (event) => ({
  type: event.type,
  label: eventLabel(event),
  detail: event.type === 'attempt_locked' || event.type === 'attempt_warned' ? event.detail : event.note || null,
  createdAt: event.createdAt,
  durationMs: event.durationMs ?? null
});

/** The integrity columns shared by the CSV and the Excel export. */
export const integrityHeaders = [
  'Times left the test (total)', 'Time away in total (seconds)', 'Longest time away (seconds)',
  'Left fullscreen', 'Switched app or tab', 'Window lost focus', 'Reloaded the page', 'Not in fullscreen', 'Went offline',
  'Copy / cut / paste / drag attempts', 'Times locked', 'Print attempts', 'Used split screen',
  'Time offline in total (seconds, not counted as leaving)', 'Answers that arrived late'
];

export const integrityCells = (summary) => (summary
  ? [
    summary.leaveCount, Math.round(summary.awayMs / 1000), Math.round(summary.longestAwayMs / 1000),
    summary.leaves.fullscreen, summary.leaves.tab_switch, summary.leaves.focus_lost, summary.leaves.reload,
    summary.leaves.not_fullscreen, summary.offline?.count ?? summary.leaves.offline, summary.flags.copy + summary.flags.cut + summary.flags.paste + summary.flags.drop, summary.lockCount,
    summary.flags.print, summary.leaves.split_screen,
    Math.round((summary.offline?.ms || 0) / 1000), summary.lateAnswers || 0
  ]
  : integrityHeaders.map(() => ''));
