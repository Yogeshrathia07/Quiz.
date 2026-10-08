/**
 * What My results (and a teacher's Taken, under Tests) can be searched,
 * filtered and sorted by (see client/src/lib/filters.js). Each group sorts
 * every test into exactly one of its options, so ticking a whole group - or
 * everything - still shows every test (tests/filters.test.js).
 */
import { sortBy } from '../../lib/filters.js';

/** `rare`: left out of the menu while nothing matches it. */
const option = (id, label, test, { rare = false } = {}) => ({ id, label, test, rare });

/**
 * Where one test stands for this student: `now` when it waits on them
 * (sitting it, about to, or waiting to be let in), `done` once handed in,
 * `past` when it ended without them - and which of those, in a word.
 */
export function placeOf(result) {
  if (result.registrationStatus === 'rejected') return { group: 'past', id: 'declined' };
  if (result.registrationStatus === 'pending') return { group: 'now', id: 'waiting' };
  if (result.attemptStatus === 'in_progress') return { group: 'now', id: 'continue' };
  if (result.attemptStatus === 'submitted') return { group: 'done', id: 'submitted' };
  if (result.testClosed) return { group: 'past', id: 'missed' };
  return { group: 'now', id: 'open' };
}

/** Marks earned out of the paper's full marks. */
export const outOf = (result) => result.totalMarks ?? result.totalQuestions;
export const percentOf = (result) => (outOf(result) ? (result.score / outOf(result)) * 100 : 0);
/** How a score reads at a glance, as it shows (rounded): good, middling, low. */
export const band = (value) => {
  const shown = Math.round(value);
  return shown >= 60 ? 'good' : shown >= 35 ? 'mid' : 'low';
};

/** Handed in, its marks out and every answer marked: a score that will not change. */
export const finalScore = (result) => placeOf(result).group === 'done' && Boolean(result.released) && !(result.pendingManual > 0) && outOf(result) > 0;

/** A handed-in paper's marks: out, still being marked (shown so far or held for it), or not out yet. */
function marksOf(result) {
  if (result.released) return result.pendingManual > 0 ? 'marking' : 'out';
  return result.waitingFor === 'manual' ? 'marking' : 'held';
}

/** One status for each test: open now, its marks' state once handed in, missed or declined. */
const isState = (id) => (result) => {
  const place = placeOf(result);
  if (place.group === 'now') return id === 'open';
  if (place.group === 'done') return marksOf(result) === id;
  return place.id === id;
};
const isBand = (id) => (result) => (finalScore(result) ? band(percentOf(result)) === id : id === 'none');

export const MY_RESULT_FILTERS = [
  { id: 'state', title: 'Status', options: [
    option('state:open', 'Open now', isState('open')),
    option('state:out', 'Marks out', isState('out')),
    option('state:marking', 'Being marked', isState('marking')),
    option('state:held', 'Marks not out yet', isState('held')),
    option('state:missed', 'Missed', isState('missed')),
    option('state:declined', 'Declined', isState('declined'), { rare: true })
  ] },
  { id: 'score', title: 'Score', options: [
    option('score:good', '60% or more', isBand('good')),
    option('score:mid', '35% to 59%', isBand('mid')),
    option('score:low', 'Below 35%', isBand('low')),
    option('score:none', 'No final score yet', isBand('none'))
  ] }
];

/** The tests whose name or code holds what was typed, in any case. */
export function searchResults(results, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return needle ? results.filter((result) => `${result.title || ''} ${result.code || ''}`.toLocaleLowerCase().includes(needle)) : results;
}

const RESULT_FIELDS = {
  // When it was handed in, or else begun; neither (missed, waiting) goes last either way round.
  date: (result) => Date.parse(result.submittedAt || result.startedAt || '') || null,
  title: (result) => String(result.title || '').toLocaleLowerCase(),
  // Only a final score counts: the rest go last either way round.
  score: (result) => (finalScore(result) ? percentOf(result) : null)
};

export const USUAL_RESULT_SORT = 'date-desc';
export const sortResults = (results, sort) => sortBy(results, sort, RESULT_FIELDS);

const URGENCY = { continue: 0, open: 1, waiting: 2 };
/** The tests open now, most pressing first: one to continue, then one to begin, then one waiting to be let in. */
export const byUrgency = (results) => sortBy(results, 'urgency-asc', { urgency: (result) => URGENCY[placeOf(result).id] ?? 3 });
