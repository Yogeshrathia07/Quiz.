/*
 * Everything the Analysis tab shows, worked out from the matrix (every
 * submitted paper against every question - overview-service matrixOf) for the
 * questions the teacher has ticked and the filters. One pure function, so
 * every tile, the donut, the bars, the question averages and the rank list
 * always agree, and change together.
 *
 * An answer is one of: O right, P part marks, W wrong, B blank, Q not marked
 * yet, . not on that paper. A paper's marks are what it has *secured*; what
 * its unmarked answers could still add is its *pendingMax* - never counted
 * as 0, never counted as earned. Only a fully marked paper is ranked and
 * counted in the figures; one still to mark waits, unranked, in Pending.
 */

import { BANDS, markBars } from '../../../../src/domain/analysis-bands.js';
export { BANDS };
export const STATE_NAMES = { O: 'right', P: 'part marks', W: 'wrong', B: 'blank', Q: 'not marked yet', '.': 'not on this paper' };

/** Pending papers stay separate from the shared percentage bands. */
export const PENDING_BAND = 'pending';
export const bandOf = (percent) => BANDS.find((band) => percent >= band.from && percent < band.to)?.id ?? BANDS.at(-1).id;

/** What a paper's record says about how it was sat: 'left', 'locked', 'copy', or 'none' for nothing. */
export const FLAGS = ['left', 'locked', 'copy', 'none'];
export const flagsOf = (student) => {
  const flags = student.flags || {};
  const found = [flags.left > 0 && 'left', flags.locked > 0 && 'locked', flags.copyPaste > 0 && 'copy'].filter(Boolean);
  return found.length ? found : ['none'];
};

const EPSILON = 1e-9;
const round1 = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);
const mean = (values) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
const median = (sorted) => {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** One answer of a paper: its state and the marks it has (null while not marked, or not on the paper). */
export function cellOf(student, column, questions) {
  const state = student.st[column] || '.';
  const worth = questions[column].worth;
  const marks = state === 'O' ? worth : state === 'P' ? Number(student.pm?.[column]) || 0 : state === 'W' || state === 'B' ? 0 : null;
  return { state, marks };
}

/** A paper over the ticked questions: marks secured, the most its unmarked answers could add, and out of what. */
export function scorePaper(student, questions, selected) {
  let secured = 0;
  let pendingMax = 0;
  let max = 0;
  let pendingAnswers = 0;
  for (const column of selected) {
    const state = student.st[column] || '.';
    if (state === '.') continue;
    const worth = questions[column].worth;
    max += worth;
    if (state === 'O') secured += worth;
    else if (state === 'P') secured += Number(student.pm?.[column]) || 0;
    else if (state === 'Q') { pendingMax += worth; pendingAnswers += 1; }
  }
  secured = Math.round(secured * 100) / 100;
  return { secured, pendingMax: Math.round(pendingMax * 100) / 100, max: Math.round(max * 100) / 100, pending: pendingAnswers > 0, percent: max ? (secured / max) * 100 : null };
}

/**
 * How well each question tells strong from weak, over the whole class
 * (`ranked`, best first): the share of its marks the top 27% earned on it
 * less the bottom 27%'s - once it is fully marked and at least 6 papers are
 * ranked. Null otherwise.
 */
function separationOf(matrix, ranked) {
  const { questions, students } = matrix;
  const group = ranked.length >= 6 ? Math.max(2, Math.round(ranked.length * 0.27)) : 0;
  const share = (rows, column) => {
    const values = rows.map((row) => cellOf(row.student, column, questions))
      .filter((cell) => cell.state !== '.' && cell.state !== 'Q')
      .map((cell) => cell.marks / questions[column].worth);
    return values.length ? mean(values) : null;
  };
  return questions.map((_question, column) => {
    if (!group || students.some((student) => student.st[column] === 'Q')) return null;
    const top = share(ranked.slice(0, group), column);
    const bottom = share(ranked.slice(-group), column);
    return top === null || bottom === null ? null : Math.round((top - bottom) * 100) / 100;
  });
}

/**
 * Each question's average over `students`' marked answers - a blank counts
 * as 0 and is told apart; an unmarked answer is left out until it is marked.
 */
function questionFigures(questions, students, separation) {
  return questions.map((question, column) => {
    let marks = 0;
    let marked = 0;
    let pending = 0;
    let blank = 0;
    let right = 0;
    for (const student of students) {
      const cell = cellOf(student, column, questions);
      if (cell.state === '.') continue;
      if (cell.state === 'Q') { pending += 1; continue; }
      marked += 1;
      marks += cell.marks;
      if (cell.state === 'B') blank += 1;
      if (cell.state === 'O') right += 1;
    }
    return {
      ...question, column, marked, pending, blank, right,
      average: marked ? Math.round((marks / marked) * 100) / 100 : null,
      separation: separation[column]
    };
  });
}

/**
 * Competition ranking (1, 2, 2, 4) by percent; papers level on marks share a
 * rank, the faster listed first. A paper on 0 marks keeps its place (last) but
 * no rank: a rank is for marks earned, so a blank paper is never "1st" while
 * the rest wait to be marked. It still counts in the average and median.
 */
function rankRows(rows) {
  const ordered = [...rows].sort((a, b) => b.percent - a.percent || (a.student.seconds ?? Infinity) - (b.student.seconds ?? Infinity) || a.student.name.localeCompare(b.student.name));
  let rank = 0;
  ordered.forEach((row, index) => {
    if (index === 0 || ordered[index - 1].percent - row.percent > EPSILON) rank = index + 1;
    row.rank = row.secured > EPSILON ? rank : null;
  });
  return ordered;
}

/**
 * A marks range { from, to } in %, both ends included - or null when it
 * covers all of 0-100 (no filter) or does not make sense.
 */
export function rangeOf(range) {
  const from = Number(range?.from);
  const to = Number(range?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > to) return null;
  return from <= 0 && to >= 100 ? null : { from, to };
}
/** Any from-to of numbers, both ends included (raw marks, ranks) - or null when there is none or it runs backwards. */
export function spanOf(span) {
  if (!span) return null;
  const from = Number(span.from);
  const to = Number(span.to);
  // An open end may be Infinity (no limit); anything not a number is no span.
  return !Number.isNaN(from) && !Number.isNaN(to) && span.from !== null && span.to !== null && from <= to ? { from, to } : null;
}
/** Whether a fully marked paper's percent is in the range: one still to mark has no final percent yet. */
export const inRange = (row, range) => row.counted && row.percent >= range.from - EPSILON && row.percent <= range.to + EPSILON;

const SORTS = {
  rank: (a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || (b.percent ?? -1) - (a.percent ?? -1) || (a.student.seconds ?? Infinity) - (b.student.seconds ?? Infinity),
  name: (a, b) => a.student.name.localeCompare(b.student.name),
  total: (a, b) => (a.percent ?? -1) - (b.percent ?? -1) || a.secured - b.secured,
  time: (a, b) => (a.student.seconds ?? Infinity) - (b.student.seconds ?? Infinity)
};

/** Whether a fully marked paper falls in a bar of the marks chart (in marks, or in %). */
const valueIn = (row, unit) => (unit === 'marks' ? row.secured : row.percent);
export const inBar = (row, bar) => {
  if (!row.counted || !bar) return false;
  const value = valueIn(row, bar.unit);
  return value >= bar.from - EPSILON && (bar.last ? value <= bar.to + EPSILON : value < bar.to - EPSILON);
};

/**
 * Everything the tab shows.
 *  selected     - the ticked question columns (a Set of indexes)
 *  bins, lo, hi - the marks chart: how many bars over which range of %
 *                 (bins null: as many as suit the paper)
 *  byMarks      - the bars along whole marks when every paper is out of the
 *                 same marks and the range is the whole 0-100 (markBars);
 *                 otherwise, and by default, equal slices of %
 *  maxBars      - no more bars than this (each wide enough to press), or null
 *  filters      - which students: { search, range: { from, to } (% of the
 *                 ticked questions' marks, both ends included, fully marked
 *                 papers only), marksRange: { from, to } (raw marks secured),
 *                 rankRange: { from, to }, average / median: ['above' |
 *                 'below'] (at or above, or below, the class's own figure),
 *                 marking: ['done' | 'pending'], flags: ['left' | 'locked' |
 *                 'copy' | 'none'], bin (a bar by its place), bar (a bar
 *                 by its range: { unit, from, to, last }), bands (score band
 *                 ids, 'pending' among them) }. Within one list any one will
 *                 do; together they narrow.
 *                 Every figure is then for that group; ranks stay the class's.
 *                 The score bands and the bars are the exception, each for its
 *                 own pick: the bands leave out only the band picked, the bars
 *                 only the bar picked - so a picked band or bar is shown among
 *                 the rest, not alone.
 *  sort         - { key: 'rank' | 'name' | 'total' | 'time' | column index, dir: 'asc' | 'desc' }
 */
export function compute(matrix, { selected, bins = 10, lo = 0, hi = 100, byMarks = false, maxBars = null, filters = {}, sort = { key: 'rank', dir: 'asc' } } = {}) {
  const { questions, students } = matrix;
  const columns = [...selected].filter((column) => column >= 0 && column < questions.length).sort((a, b) => a - b);
  const rows = students.map((student) => ({ student, ...scorePaper(student, questions, columns), rank: null }));
  for (const row of rows) {
    row.inSelection = row.max > 0;
    row.counted = row.inSelection && !row.pending;
    row.band = !row.inSelection ? null : row.counted ? bandOf(row.percent) : PENDING_BAND;
    row.flags = flagsOf(row.student);
  }
  // Ranks are the whole class's, whatever is filtered.
  const ranked = rankRows(rows.filter((row) => row.counted));
  // The class's own average and median (every fully marked paper, whatever is filtered): what "above" and "below" compare with.
  const classPercents = ranked.map((row) => row.percent).sort((a, b) => a - b);
  const classFigures = {
    average: classPercents.length ? mean(classPercents) : null,
    median: median(classPercents),
    lastRank: ranked.reduce((last, row) => Math.max(last, row.rank ?? 0), 0),
    maxMarks: ranked.reduce((most, row) => Math.max(most, row.max), 0)
  };

  // The marks chart's bars, fixed by the class's papers and the range whatever is filtered.
  const low = Math.max(0, Math.min(100, Number(lo) || 0));
  const high = Math.max(low + 1, Math.min(100, Number.isFinite(Number(hi)) ? Number(hi) : 100));
  const maxes = new Set(ranked.map((row) => row.max));
  const fullMarks = maxes.size === 1 ? [...maxes][0] : null;
  const marksScale = byMarks && fullMarks > 0 && low === 0 && high === 100 ? markBars(fullMarks, bins, maxBars) : null;
  const count = Math.min(bins ?? 10, maxBars || Infinity);
  const width = (high - low) / count;
  const histogram = marksScale ? marksScale.bars : Array.from({ length: count }, (_unused, index) => ({
    index, unit: 'percent', from: low + index * width, to: low + (index + 1) * width, last: index === count - 1, weight: 1, count: 0
  }));

  // The group every figure describes.
  const search = String(filters.search || '').trim().toLowerCase();
  const flags = new Set(filters.flags || []);
  const marking = new Set(filters.marking || []);
  const range = rangeOf(filters.range);
  const marksSpan = spanOf(filters.marksRange);
  const rankSpan = spanOf(filters.rankRange);
  const byAverage = new Set(filters.average || []);
  const byMedian = new Set(filters.median || []);
  const compared = (row, set, value) => !set.size || (row.counted && value !== null
    && ((set.has('above') && row.percent >= value - EPSILON) || (set.has('below') && row.percent < value - EPSILON)));
  const bar = filters.bar || (Number.isInteger(filters.bin) ? histogram[filters.bin] : null);
  const bands = new Set(filters.bands || []);
  const inBand = (row) => !bands.size || bands.has(row.band);
  const fitsBar = (row) => !bar || inBar(row, bar);
  // Answer filters narrow every figure without changing class ranks or the
  // class average/median used by the comparison filters. An empty Set means
  // a genuinely empty cohort; null/undefined means no answer restriction.
  const studentIds = filters.studentIds == null ? null : new Set([...filters.studentIds].map(String));
  const others = rows.filter((row) => (!studentIds || studentIds.has(String(row.student.id)))
    && (!search || row.student.name.toLowerCase().includes(search) || String(row.student.sapId || '').includes(search))
    && (!range || inRange(row, range))
    && (!marksSpan || (row.counted && row.secured >= marksSpan.from - EPSILON && row.secured <= marksSpan.to + EPSILON))
    && (!rankSpan || (row.rank !== null && row.rank >= rankSpan.from && row.rank <= rankSpan.to))
    && compared(row, byAverage, classFigures.average)
    && compared(row, byMedian, classFigures.median)
    && (!marking.size || (marking.has('done') && row.counted) || (marking.has('pending') && row.band === PENDING_BAND))
    && (!flags.size || row.flags.some((flag) => flags.has(flag))));
  const group = others.filter((row) => inBand(row) && fitsBar(row));
  // What the score bands and the bars show: everyone else picked, their own pick aside.
  const forBands = others.filter(fitsBar);
  const forBars = others.filter(inBand);

  const counted = group.filter((row) => row.counted);
  const percents = counted.map((row) => row.percent).sort((a, b) => a - b);
  const sameMax = new Set(counted.map((row) => row.max)).size === 1 ? counted[0]?.max ?? null : null;
  const marks = counted.map((row) => row.secured).sort((a, b) => a - b);
  const stats = {
    attempted: matrix.people?.began ?? students.length,
    absent: matrix.people?.absent ?? 0,
    writing: matrix.people?.writing ?? 0,
    papers: students.length,
    inGroup: group.length,
    counted: counted.length,
    ranked: counted.filter((row) => row.rank !== null).length,
    onZero: counted.filter((row) => row.rank === null).length,
    pendingPapers: group.filter((row) => row.inSelection && row.pending).length,
    fullMarks: sameMax,
    average: round1(mean(percents)), median: round1(median(percents)),
    highest: round1(percents.at(-1) ?? null), lowest: round1(percents[0] ?? null),
    averageMarks: sameMax === null ? null : round1(mean(marks)), medianMarks: sameMax === null ? null : round1(median(marks)),
    highestMarks: sameMax === null ? null : marks.at(-1) ?? null, lowestMarks: sameMax === null ? null : marks[0] ?? null
  };

  const bandRows = forBands.filter((row) => row.counted);
  const pendingCount = forBands.filter((row) => row.band === PENDING_BAND).length;
  const inBands = bandRows.length + pendingCount;
  const bandList = [...BANDS.map((band) => ({ ...band, count: bandRows.filter((row) => row.band === band.id).length })), { id: PENDING_BAND, label: 'Still to mark', count: pendingCount }]
    .map((band) => ({ ...band, share: inBands ? Math.round((band.count / inBands) * 100) : 0 }));

  let outside = 0;
  const barRows = forBars.filter((row) => row.counted);
  for (const row of barRows) {
    if (marksScale) {
      histogram[Math.min(histogram.length - 1, Math.max(0, Math.floor((row.secured + EPSILON) / marksScale.step)))].count += 1;
      continue;
    }
    if (row.percent < low - EPSILON || row.percent > high + EPSILON) { outside += 1; continue; }
    histogram[Math.min(count - 1, Math.max(0, Math.floor((row.percent - low) / width)))].count += 1;
  }

  const figures = questionFigures(questions, group.map((row) => row.student), separationOf(matrix, ranked));

  // The rank list: ranked first, in rank order; those still to mark after them.
  const members = new Set(group);
  let shown = ranked.filter((row) => members.has(row))
    .concat(group.filter((row) => !row.counted).sort((a, b) => b.secured - a.secured || (a.student.seconds ?? Infinity) - (b.student.seconds ?? Infinity)));
  const key = sort?.key ?? 'rank';
  if (key !== 'rank' || sort?.dir === 'desc') {
    const sign = sort?.dir === 'desc' ? -1 : 1;
    const compare = SORTS[key] || SORTS.rank;
    shown = [...shown].sort((a, b) => {
      if (typeof key !== 'number') return sign * compare(a, b);
      // One question's marks: not marked yet, or not on the paper, always last whichever way.
      const markA = cellOf(a.student, key, questions).marks;
      const markB = cellOf(b.student, key, questions).marks;
      if ((markA === null) !== (markB === null)) return markA === null ? 1 : -1;
      return sign * ((markA ?? 0) - (markB ?? 0));
    });
  }

  const histogramOf = {
    bins: histogram, outside, lo: low, hi: high,
    unit: marksScale ? 'marks' : 'percent', step: marksScale?.step ?? width, top: marksScale?.top ?? null, fullMarks: marksScale ? fullMarks : null,
    // Fewer bars than asked for, so each is wide enough to press.
    capped: marksScale ? marksScale.capped : count < (bins ?? 10),
    // Part marks: a bar of one mark then holds, say, 7.5 too.
    fractions: barRows.some((row) => Math.abs(row.secured - Math.round(row.secured)) > EPSILON)
  };
  return { columns, rows, shown, stats, classFigures, bands: bandList, histogram: histogramOf, questions: figures };
}
