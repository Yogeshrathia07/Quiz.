/**
 * What the My quizzes list can be filtered and sorted by (see
 * client/src/lib/filters.js). Each group sorts every quiz into exactly one of
 * its options, so ticking a whole group - or everything - still shows every
 * quiz (tests/filters.test.js). Archived quizzes are put away: the list leaves
 * them out until Archived is ticked.
 */
import { sortBy, whenOf } from '../../lib/filters.js';

/** `rare`: left out of the menu while nothing matches it. */
const option = (id, label, test, { rare = false } = {}) => ({ id, label, test, rare });

/** Where a quiz stands, in the words and colours of its badge. */
export function statusOf(test) {
  if (test.archivedAt) return { id: 'archived', label: 'Archived', tone: 'neutral' };
  if (test.isClosed) return { id: 'completed', label: 'Completed', tone: 'success' };
  if (test.isStarted) return { id: 'live', label: 'Live', tone: 'live' };
  if (test.startMode === 'scheduled') return { id: 'scheduled', label: 'Scheduled', tone: 'info' };
  return { id: 'waiting', label: 'Not started', tone: 'neutral' };
}

/** Whether students see their marks: at once, once the test is closed, or once you release them (as the server decides). */
export function marksReleased(test) {
  if (test.resultReleaseMode === 'instant') return true;
  if (test.resultReleaseMode === 'after_quiz') return Boolean(test.isClosed);
  return Boolean(test.resultsReleasedAt);
}

/**
 * Papers still waiting on the teacher's marking. Marks released anyway
 * (releaseUnmarked) take them off the list, Hold marks puts them back; frozen
 * results (final, nothing can be marked) take them off too.
 */
export const papersToMark = (test) => (test.releaseUnmarked || test.resultsFrozenAt ? 0 : test.toMarkCount || 0);

/**
 * Where a quiz's marks stand for its students, in a few words and a tone:
 * before it ends, the policy; after, whether they are out - and, where short
 * answers are still unmarked, whether those papers wait or show what is marked.
 */
export function marksState(test) {
  if (!test.isClosed) {
    return { text: { instant: 'Marks on submission', after_quiz: 'Marks when it ends' }[test.resultReleaseMode] || 'Marks when you release', tone: 'muted' };
  }
  if (!marksReleased(test)) return { text: 'Marks not released', tone: 'warn' };
  if (test.toMarkCount > 0) return test.releaseUnmarked ? { text: `Marks out, ${test.toMarkCount} unmarked`, tone: 'info' } : { text: 'Marks held for marking', tone: 'warn' };
  return { text: 'Marks released', tone: 'ok' };
}

const plural = (count, word, words = `${word}s`) => `${count} ${count === 1 ? word : words}`;

/**
 * What a quiz's card says beyond its status: when it ran (or will), who has
 * not taken it, what waits on the teacher, how it went and where its marks
 * stand. Each: { id, text, tone, more } - tone 'warn' when it waits on the
 * teacher. The card is minimal: when, and what waits on the teacher, always;
 * the rest (`more`) only on hover - placed last, so it appears without moving
 * anything. `when` formats a date.
 */
export function quizFacts(test, when) {
  const facts = allFacts(test, when).map((fact) => ({ ...fact, more: !(fact.id === 'when' || fact.id === 'frozen' || fact.tone === 'warn') }));
  return [...facts.filter((fact) => !fact.more), ...facts.filter((fact) => fact.more)];
}

function allFacts(test, when) {
  const facts = [];
  const run = statusOf({ ...test, archivedAt: null }).id;
  if (run === 'completed') facts.push({ id: 'when', text: `Ended ${when(test.closedAt)}`, tone: 'muted' });
  else if (run === 'live') {
    const text = test.endMode === 'each' ? `${test.durationMinutes} min each, open until closed`
      : test.endsAt && !test.untimed ? `Ends ${when(test.endsAt)}` : 'No end time';
    facts.push({ id: 'when', text, tone: 'muted' });
  }
  else if (run === 'scheduled' && test.opensAt) facts.push({ id: 'when', text: `Starts ${when(test.opensAt)}`, tone: 'muted' });
  else facts.push({ id: 'when', text: `Created ${when(test.createdAt)}`, tone: 'muted' });

  if (test.notStartedCount > 0 && (run === 'live' || run === 'completed')) {
    facts.push({ id: 'absent', text: run === 'completed' ? `${plural(test.notStartedCount, 'student')} missed it` : `${test.notStartedCount} not started yet`, tone: 'muted' });
  }
  if (test.pendingCount > 0) facts.push({ id: 'requests', text: plural(test.pendingCount, 'request') + ' waiting', tone: 'warn' });
  // Released anyway: no longer asked for here; the marks fact says how many are unmarked.
  if (papersToMark(test) > 0) facts.push({ id: 'marking', text: `${plural(papersToMark(test), 'paper')} to mark`, tone: 'warn' });
  else if ((test.questionMix?.short || 0) > 0 && test.submittedCount > 0 && !(test.toMarkCount > 0)) facts.push({ id: 'marking', text: 'All marked', tone: 'ok' });
  // Unmarked answers count nothing yet, so while papers wait the average is only so far.
  if (typeof test.averageScore === 'number') facts.push({ id: 'average', text: `Average ${test.averageScore}%${test.toMarkCount > 0 ? ' so far' : ''}`, tone: 'muted' });
  if (run === 'live' || run === 'completed') facts.push({ id: 'marks', ...marksState(test) });
  // Final marks: always said, like what waits on the teacher.
  if (test.resultsFrozenAt) facts.push({ id: 'frozen', text: 'Results frozen', tone: 'info' });
  return facts;
}

export const ARCHIVED = 'status:archived';
const isStatus = (id) => (test) => statusOf(test).id === id;

export const TEST_FILTERS = [
  { id: 'status', title: 'Status', options: [
    option('status:live', 'Live', isStatus('live')),
    option('status:scheduled', 'Scheduled', isStatus('scheduled')),
    option('status:waiting', 'Not started', isStatus('waiting')),
    option('status:completed', 'Completed', isStatus('completed')),
    option(ARCHIVED, 'Archived', isStatus('archived'))
  ] },
  { id: 'requests', title: 'Registrations', options: [
    option('requests:waiting', 'Requests waiting', (test) => test.pendingCount > 0),
    option('requests:none', 'None waiting', (test) => !(test.pendingCount > 0))
  ] },
  { id: 'marking', title: 'Marking', options: [
    option('marking:due', 'Papers to mark', (test) => papersToMark(test) > 0),
    option('marking:done', 'Nothing to mark', (test) => !(papersToMark(test) > 0))
  ] },
  { id: 'marks', title: 'Marks for students', options: [
    option('marks:released', 'Released', marksReleased),
    option('marks:held', 'Not released yet', (test) => !marksReleased(test))
  ] },
  { id: 'created', title: 'Created', options: [
    option('created:today', 'Today', (test) => whenOf(test) === 'today', { rare: true }),
    option('created:week', 'Earlier this week', (test) => whenOf(test) === 'week', { rare: true }),
    option('created:month', 'Earlier this month', (test) => whenOf(test) === 'month', { rare: true }),
    option('created:older', 'Before this month', (test) => whenOf(test) === 'older', { rare: true })
  ] }
];

const KNOWN = new Set(TEST_FILTERS.flatMap((group) => group.options.map((option) => option.id)));

/** The ticked options an address names (?admin=tests&filter=marking:due), unknown ones dropped. */
export const testFiltersFrom = (value) => [...new Set(String(value || '').split(',').filter((id) => KNOWN.has(id)))];

/**
 * The quizzes the list shows: archived ones only once Archived is ticked,
 * then the ticked filters (lib/filters.js does the ticking).
 */
export const unlessArchivedTicked = (tests, selected) => (selected.includes(ARCHIVED) ? tests : tests.filter((test) => !test.archivedAt));

const TEST_FIELDS = {
  created: (test) => Date.parse(test.createdAt) || 0,
  title: (test) => String(test.title || '').toLocaleLowerCase(),
  // No paper handed in yet: no average, so last either way round.
  score: (test) => (typeof test.averageScore === 'number' ? test.averageScore : null),
  registered: (test) => test.registrationCount || 0
};

export const USUAL_TEST_SORT = 'created-desc';
export const sortTests = (tests, sort) => sortBy(tests, sort, TEST_FIELDS);
