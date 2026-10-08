import assert from 'node:assert/strict';
import test from 'node:test';
import { bandOf, compute, rangeOf, scorePaper } from '../client/src/screens/admin/analysis-compute.js';

// Two MCQs (2 marks each) and one short answer (6 marks).
const questions = [
  { id: 1, number: 1, type: 'mcq', worth: 2 },
  { id: 2, number: 2, type: 'mcq', worth: 2 },
  { id: 3, number: 3, type: 'short', worth: 6 }
];
const student = (name, st, extra = {}) => ({ id: name, name, sapId: null, seconds: 600, flags: { left: 0, locked: 0, copyPaste: 0 }, st, pm: {}, ...extra });
const all = new Set([0, 1, 2]);
const matrixOf = (students) => ({ questions, students, people: { began: students.length + 1, absent: 2, writing: 0 } });

test('a paper: marks secured, the most its unmarked answers could add, out of what', () => {
  assert.deepEqual(scorePaper(student('A', 'OPQ', { pm: { 1: 1 } }), questions, all), { secured: 3, pendingMax: 6, max: 10, pending: true, percent: 30 });
  assert.deepEqual(scorePaper(student('B', 'OBW'), questions, all), { secured: 2, pendingMax: 0, max: 10, pending: false, percent: 20 });
  // A question not on the paper counts for nothing either way.
  assert.equal(scorePaper(student('C', 'O.O'), questions, all).max, 8);
});

test('bands: the lower edge is in the band', () => {
  assert.deepEqual([bandOf(90), bandOf(89.9), bandOf(80), bandOf(50), bandOf(29.9), bandOf(100)], ['90', '80', '80', '50', '0', '90']);
});

test('a paper still to mark is not ranked, not counted, and sits in Pending', () => {
  const view = compute(matrixOf([student('A', 'OOO'), student('B', 'OOQ'), student('C', 'WWO')]), { selected: all });
  assert.deepEqual(view.shown.map((row) => [row.student.name, row.rank]), [['A', 1], ['C', 2], ['B', null]]);
  assert.equal(view.stats.counted, 2);
  assert.equal(view.stats.pendingPapers, 1);
  assert.equal(view.stats.average, 80, 'B is left out: (100 + 60) / 2');
  assert.equal(view.bands.find((band) => band.id === 'pending').count, 1);
  assert.equal(view.histogram.bins.reduce((total, bin) => total + bin.count, 0), 2, 'nor is it in the bars');
});

test('competition ranking: level marks share a rank, the faster first; the next rank skips', () => {
  const view = compute(matrixOf([
    student('Slow', 'OOW', { seconds: 900 }), student('Fast', 'OOW', { seconds: 300 }),
    student('Top', 'OOO'), student('Last', 'WOW')
  ]), { selected: all });
  assert.deepEqual(view.shown.map((row) => `${row.rank} ${row.student.name}`), ['1 Top', '2 Fast', '2 Slow', '4 Last']);
});

test('a paper on 0 marks is listed, never ranked: a blank paper is not 1st while the rest wait to be marked', () => {
  const view = compute(matrixOf([student('Blank', 'BBB'), student('Waiting', 'BBQ'), student('Also waiting', 'WBQ')]), { selected: all });
  assert.deepEqual(view.shown.map((row) => [row.student.name, row.rank]), [['Blank', null], ['Waiting', null], ['Also waiting', null]]);
  assert.deepEqual([view.stats.counted, view.stats.ranked, view.stats.onZero], [1, 0, 1], 'counted in the figures, but no rank');
  assert.equal(view.stats.average, 0, 'its 0 is a real score');
  const marked = compute(matrixOf([student('Blank', 'BBB'), student('Some', 'OBW'), student('More', 'OOW')]), { selected: all });
  assert.deepEqual(marked.shown.map((row) => `${row.rank} ${row.student.name}`), ['1 More', '2 Some', 'null Blank'], 'listed last, after the ranked');
  assert.equal(marked.classFigures.lastRank, 2);
});

test('ticking questions recomputes everything on just those', () => {
  const students = [student('A', 'OWQ'), student('B', 'WOO')];
  const mcqs = compute(matrixOf(students), { selected: new Set([0, 1]) });
  assert.deepEqual(mcqs.shown.map((row) => [row.student.name, row.percent, row.rank]), [['A', 50, 1], ['B', 50, 1]], 'A is no longer pending: its short answer is not ticked');
  assert.equal(mcqs.stats.pendingPapers, 0);
  const short = compute(matrixOf(students), { selected: new Set([2]) });
  assert.deepEqual(short.shown.map((row) => [row.student.name, row.rank, row.band]), [['B', 1, '90'], ['A', null, 'pending']]);
});

test('a question average: over marked answers only, a blank as 0 and told apart, the unmarked counted separately', () => {
  const view = compute(matrixOf([student('A', 'OBQ'), student('B', 'WOP', { pm: { 2: 3 } }), student('C', 'OOQ')]), { selected: all });
  const [first, second, third] = view.questions;
  assert.deepEqual([first.average, first.marked, first.blank, first.pending], [1.33, 3, 0, 0]);
  assert.deepEqual([second.average, second.marked, second.blank], [1.33, 3, 1], 'the blank is 0 in the average, and counted');
  assert.deepEqual([third.average, third.marked, third.pending], [3, 1, 2], '3 of 6 from the one marked answer; two still to mark');
});

test('how well a question separates: only once fully marked, from six ranked papers', () => {
  const papers = ['OOO', 'OOO', 'OWW', 'OWW', 'WWW', 'WWW'].map((st, index) => student(`S${index}`, st));
  const view = compute(matrixOf(papers), { selected: all });
  assert.equal(view.questions[0].separation, 1, 'top two right, bottom two wrong');
  assert.equal(view.questions[1].separation, 1);
  const marking = compute(matrixOf([...papers.slice(0, 5), student('S5', 'WWQ')]), { selected: all });
  assert.equal(marking.questions[2].separation, null, 'a question still to mark is not rated');
  assert.equal(compute(matrixOf(papers.slice(0, 5)), { selected: all }).questions[0].separation, null, 'five papers are too few');
});

test('the marks chart: its bars over the chosen range, the rest counted outside', () => {
  const papers = ['OOO', 'OWO', 'WWO', 'WWW'].map((st, index) => student(`S${index}`, st));
  const view = compute(matrixOf(papers), { selected: all, bins: 5, lo: 40, hi: 100 });
  assert.deepEqual(view.histogram.bins.map((bin) => [bin.from, bin.to, bin.count]), [[40, 52, 0], [52, 64, 1], [64, 76, 0], [76, 88, 1], [88, 100, 1]]);
  assert.equal(view.histogram.outside, 1, '0% is below the range');
});

test('a marks range: both ends included, fully marked papers only; the whole 0-100 is no filter', () => {
  assert.equal(rangeOf({ from: 0, to: 100 }), null);
  assert.equal(rangeOf({ from: 70, to: 40 }), null, 'backwards makes no sense');
  assert.equal(rangeOf({ from: -5, to: 50 }), null);
  assert.deepEqual(rangeOf({ from: 40, to: 60 }), { from: 40, to: 60 });
  const papers = [student('Asha', 'OOO'), student('Ben', 'WWO'), student('Cara', 'WWW'), student('Dev', 'OOQ')];
  const names = (range) => compute(matrixOf(papers), { selected: all, filters: { range } }).shown.map((row) => row.student.name);
  assert.deepEqual(names({ from: 60, to: 100 }), ['Asha', 'Ben'], '60% itself is in');
  assert.deepEqual(names({ from: 0, to: 60 }), ['Ben', 'Cara']);
  assert.deepEqual(names({ from: 30, to: 50 }), [], 'Dev has 40% so far, but is still to mark');
});

test('raw marks, ranks, and the class average and median: any values, both ends included', () => {
  // Out of 10 each: 10, 6, 4 (still to mark - 4 so far), 0; the class (fully marked) average 53.3%, median 60%.
  const papers = [student('Asha', 'OOO'), student('Ben', 'WWO'), student('Dev', 'OOQ'), student('Cara', 'WWW')];
  const view = (filters) => compute(matrixOf(papers), { selected: all, filters });
  const names = (filters) => view(filters).shown.map((row) => row.student.name);
  assert.equal(Math.round(view({}).classFigures.average * 10) / 10, 53.3);
  assert.equal(view({}).classFigures.median, 60);
  assert.equal(view({}).classFigures.lastRank, 2, 'Cara, on 0, has no rank');
  assert.equal(view({}).classFigures.maxMarks, 10);
  assert.deepEqual(names({ marksRange: { from: 5, to: 10 } }), ['Asha', 'Ben'], 'raw marks, 10 itself in; Dev still to mark');
  assert.deepEqual(names({ marksRange: { from: 0, to: 0 } }), ['Cara']);
  assert.deepEqual(names({ marksRange: { from: 7, to: 3 } }), ['Asha', 'Ben', 'Cara', 'Dev'], 'a backwards span is no filter');
  assert.deepEqual(names({ rankRange: { from: 2, to: 3 } }), ['Ben'], 'Cara, on 0, has no rank to fall in a range');
  assert.deepEqual(names({ average: ['above'] }), ['Asha', 'Ben']);
  assert.deepEqual(names({ average: ['below'] }), ['Cara']);
  assert.deepEqual(names({ median: ['above'] }), ['Asha', 'Ben'], 'the median itself counts as at or above');
  assert.deepEqual(names({ median: ['below'] }), ['Cara']);
  assert.deepEqual(names({ average: ['above'], rankRange: { from: 2, to: 2 } }), ['Ben'], 'together they narrow');
  const narrowed = view({ rankRange: { from: 3, to: 3 } });
  assert.equal(Math.round(narrowed.classFigures.average * 10) / 10, 53.3, 'the class figures do not move with the filters');
});

test('filters pick a group - search, range, marking, flags, a bar - and every figure follows it; ranks stay the class\'s', () => {
  const papers = [
    student('Asha Rao', 'OOO', { sapId: '500000001' }),
    student('Ben', 'WWO', { flags: { left: 2, locked: 0, copyPaste: 0 } }),
    student('Cara', 'WWW'),
    student('Dev', 'OOQ')
  ];
  const matrix = matrixOf(papers);
  const names = (view) => view.shown.map((row) => row.student.name);
  assert.deepEqual(names(compute(matrix, { selected: all, filters: { search: 'asha' } })), ['Asha Rao']);
  assert.deepEqual(names(compute(matrix, { selected: all, filters: { search: '500000001' } })), ['Asha Rao']);
  assert.deepEqual(names(compute(matrix, { selected: all, filters: { marking: ['pending'] } })), ['Dev'], 'still to mark');
  assert.deepEqual(names(compute(matrix, { selected: all, filters: { marking: ['done'] } })), ['Asha Rao', 'Ben', 'Cara'], 'fully marked');
  assert.deepEqual(names(compute(matrix, { selected: all, filters: { marking: ['done', 'pending'] } })), ['Asha Rao', 'Ben', 'Cara', 'Dev'], 'either');
  assert.deepEqual(names(compute(matrix, { selected: all, filters: { flags: ['left'] } })), ['Ben']);
  assert.deepEqual(names(compute(matrix, { selected: all, filters: { flags: ['none'], range: { from: 0, to: 70 } } })), ['Cara'], 'filters narrow each other');
  const binned = compute(matrix, { selected: all, bins: 10, filters: { bin: 9 } });
  assert.deepEqual(names(binned), ['Asha Rao'], 'the last bar takes 100%');
  const lowGroup = compute(matrix, { selected: all, filters: { range: { from: 0, to: 70 } } });
  assert.equal(lowGroup.stats.average, 30, 'the figures are the group\'s: (60 + 0) / 2');
  assert.deepEqual(lowGroup.shown.map((row) => row.rank), [2, null], 'the ranks are the class\'s (Cara, on 0, has none)');
  assert.equal(lowGroup.questions[2].right, 1, 'and so are the question figures: one of the two got Q3');
  assert.equal(lowGroup.stats.papers, 4, 'the whole class is still known');
});

test('sorting: by a question, unmarked always last', () => {
  const view = compute(matrixOf([student('A', 'WOQ'), student('B', 'OWO'), student('C', 'OWB')]), { selected: all, sort: { key: 2, dir: 'desc' } });
  assert.deepEqual(view.shown.map((row) => row.student.name), ['B', 'C', 'A']);
});

function round(value) { return Math.round(value * 10) / 10; }
