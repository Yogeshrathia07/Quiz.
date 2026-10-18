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

test('the marks chart along whole marks: one bar per mark on a short paper, never a bar no score can land in', () => {
  // Out of 10: 10, 8, 6 and 0 marks.
  const papers = ['OOO', 'OWO', 'WWO', 'WWW'].map((st, index) => student(`S${index}`, st));
  const perMark = compute(matrixOf(papers), { selected: all, bins: null, byMarks: true }).histogram;
  assert.equal(perMark.unit, 'marks');
  assert.equal(perMark.bins.length, 11, 'asked for nothing: one bar for each of 0..10');
  assert.deepEqual(perMark.bins.filter((bin) => bin.count).map((bin) => [bin.from, bin.count]), [[0, 1], [6, 1], [8, 1], [10, 1]]);
  assert.ok(perMark.bins.every((bin) => bin.weight === 1));
  const many = compute(matrixOf(papers), { selected: all, bins: 20, byMarks: true }).histogram;
  assert.equal(many.bins.length, 11, 'twenty asked for, but there are only eleven possible scores');
  const five = compute(matrixOf(papers), { selected: all, bins: 5, byMarks: true }).histogram;
  assert.deepEqual(five.bins.map((bin) => [bin.from, bin.to, bin.last, bin.weight, bin.count]),
    [[0, 2, false, 2, 1], [2, 4, false, 2, 0], [4, 6, false, 2, 0], [6, 8, false, 2, 1], [8, 10, true, 3, 2]], 'two marks a bar; 10 alone joins 8-9');
  const big = compute({ questions: [{ id: 1, number: 1, type: 'short', worth: 100 }], students: [student('A', 'O')] }, { selected: new Set([0]), bins: null, byMarks: true }).histogram;
  assert.deepEqual([big.bins.length, big.step, big.bins.at(-1).from, big.bins.at(-1).to], [10, 10, 90, 100], 'out of 100: ten bars, 90-100 the last');
  // Papers out of different marks (a question not on one of them): equal slices of % as before.
  const mixed = compute(matrixOf([student('A', 'OOO'), student('B', 'O.O')]), { selected: all, bins: null, byMarks: true }).histogram;
  assert.deepEqual([mixed.unit, mixed.bins.length], ['percent', 10]);
  assert.equal(compute(matrixOf(papers), { selected: all, bins: 5 }).histogram.unit, 'percent', 'and by default');
});

test('never more bars than the chart has room to press: more marks to a bar instead', () => {
  const papers = ['OOO', 'OWO', 'WWO', 'WWW'].map((st, index) => student(`S${index}`, st));
  const narrow = compute(matrixOf(papers), { selected: all, bins: null, byMarks: true, maxBars: 8 }).histogram;
  assert.ok(narrow.bins.length <= 8 && narrow.step === 2 && narrow.capped, `${narrow.bins.length} bars of ${narrow.step}`);
  assert.equal(narrow.bins.reduce((total, bin) => total + bin.count, 0), 4, 'every paper still in a bar');
  const roomy = compute(matrixOf(papers), { selected: all, bins: null, byMarks: true, maxBars: 40 }).histogram;
  assert.deepEqual([roomy.bins.length, roomy.capped], [11, false]);
  const slices = compute(matrixOf([student('A', 'OOO'), student('B', 'O.O')]), { selected: all, bins: 20, byMarks: true, maxBars: 12 }).histogram;
  assert.deepEqual([slices.unit, slices.bins.length, slices.capped], ['percent', 12, true]);
});

test('picking a score band or a bar lists those students; each chart still shows the rest, its pick among them', () => {
  const papers = [student('Asha', 'OOO'), student('Ben', 'OWO'), student('Cara', 'WWO'), student('Dev', 'WWW'), student('Esha', 'OOQ')];
  const banded = compute(matrixOf(papers), { selected: all, bins: null, byMarks: true, filters: { bands: ['80'] } });
  assert.deepEqual(banded.shown.map((row) => row.student.name), ['Ben'], '80% is in 80-90%');
  assert.deepEqual(banded.bands.map((band) => band.count), [1, 1, 0, 1, 0, 1, 1], 'the bands are all still there');
  assert.equal(banded.histogram.bins.reduce((total, bin) => total + bin.count, 0), 1, 'the bars show the band picked');
  const pending = compute(matrixOf(papers), { selected: all, filters: { bands: ['pending'] } });
  assert.deepEqual(pending.shown.map((row) => row.student.name), ['Esha']);
  const bar = { unit: 'marks', from: 6, to: 8, last: false };
  const barred = compute(matrixOf(papers), { selected: all, bins: 5, byMarks: true, filters: { bar } });
  assert.deepEqual(barred.shown.map((row) => row.student.name), ['Cara'], '6 marks: in 6-7, not 8');
  assert.equal(barred.histogram.bins.reduce((total, bin) => total + bin.count, 0), 4, 'the bars all still there');
  assert.deepEqual(barred.bands.filter((band) => band.count).map((band) => band.id), ['50'], 'the bands show the bar picked');
  assert.equal(barred.stats.average, 60, 'and every figure is the group\'s');
});

test('part marks are told apart, so a one-mark bar can say it holds them', () => {
  const half = compute(matrixOf([student('A', 'OOP', { pm: { 2: 2.5 } }), student('B', 'OOO')]), { selected: all, bins: null, byMarks: true }).histogram;
  assert.equal(half.fractions, true);
  assert.equal(half.bins[6].count, 1, '6.5 marks sits in the bar from 6');
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

test('answer cohorts narrow figures but preserve the full class ranks and comparison baseline', () => {
  const papers = [student('Top', 'OOO'), student('Middle', 'WWO'), student('Zero', 'WWW'), student('Pending', 'OOQ')];
  const matrix = matrixOf(papers);
  const baseline = compute(matrix, { selected: all, bins: 5, byMarks: true });
  const cohort = compute(matrix, { selected: all, bins: 5, byMarks: true, filters: { studentIds: new Set(['Middle', 'Pending']) } });
  assert.deepEqual(cohort.shown.map((row) => [row.student.id, row.rank]), [['Middle', 2], ['Pending', null]]);
  assert.deepEqual(cohort.classFigures, baseline.classFigures, 'class average, median, max and last rank stay the class baseline');
  assert.deepEqual([cohort.stats.inGroup, cohort.stats.counted, cohort.stats.pendingPapers, cohort.stats.average, cohort.stats.averageMarks], [2, 1, 1, 60, 6]);
  assert.equal(cohort.stats.papers, 4, 'the full submitted class remains known');
  assert.equal(cohort.bands.reduce((sum, band) => sum + band.count, 0), 2);
  assert.equal(cohort.histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 1);
  assert.deepEqual(cohort.questions.map((question) => [question.marked, question.pending, question.right]), [[2, 0, 1], [2, 0, 1], [1, 1, 1]]);
  assert.deepEqual(cohort.rows.map((row) => row.student.id), baseline.rows.map((row) => row.student.id), 'filter menus can still describe the class');
});

test('an empty answer cohort stays genuinely empty, while null/undefined impose no restriction', () => {
  const matrix = matrixOf([student('Top', 'OOO'), student('Middle', 'WWO'), student('Pending', 'OOQ')]);
  const baseline = compute(matrix, { selected: all });
  for (const studentIds of [[], new Set(), ['not-a-student']]) {
    const cohort = compute(matrix, { selected: all, filters: { studentIds } });
    assert.deepEqual(cohort.shown, []);
    assert.deepEqual([cohort.stats.inGroup, cohort.stats.counted, cohort.stats.pendingPapers, cohort.stats.average], [0, 0, 0, null]);
    assert.equal(cohort.bands.reduce((sum, band) => sum + band.count, 0), 0);
    assert.equal(cohort.histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 0);
    assert.ok(cohort.questions.every((question) => question.marked === 0 && question.pending === 0));
    assert.deepEqual(cohort.classFigures, baseline.classFigures);
  }
  for (const studentIds of [null, undefined]) {
    assert.deepEqual(compute(matrix, { selected: all, filters: { studentIds } }).shown, baseline.shown);
  }
});

test('answer cohorts intersect search, outcome and class comparisons without reranking the group', () => {
  const matrix = matrixOf([student('Top', 'OOO'), student('Middle', 'WWO'), student('Zero', 'WWW'), student('Pending', 'OOQ')]);
  const students = ['Middle', 'Zero', 'Pending'];
  const names = (extra) => compute(matrix, { selected: all, filters: { studentIds: students, ...extra } }).shown.map((row) => row.student.id);
  assert.deepEqual(names({ search: 'mid' }), ['Middle']);
  assert.deepEqual(names({ marking: ['pending'] }), ['Pending']);
  assert.deepEqual(names({ average: ['above'] }), ['Middle'], 'compared with full-class 53.3%, not subgroup 30%');
  assert.deepEqual(names({ median: ['above'] }), ['Middle']);
  assert.deepEqual(names({ rankRange: { from: 2, to: 2 } }), ['Middle']);
  assert.deepEqual(names({ marksRange: { from: 0, to: 0 } }), ['Zero']);
  assert.deepEqual(names({ bands: ['pending'] }), ['Pending']);
});

test('the answer cohort constrains both charts even when a band or bar has its own selected group', () => {
  const matrix = matrixOf([student('Top', 'OOO'), student('Middle', 'WWO'), student('Zero', 'WWW'), student('Pending', 'OOQ')]);
  const options = { selected: all, bins: 5, byMarks: true };
  const banded = compute(matrix, { ...options, filters: { studentIds: ['Middle', 'Pending'], bands: ['50'] } });
  assert.deepEqual(banded.shown.map((row) => row.student.id), ['Middle']);
  assert.equal(banded.bands.reduce((sum, band) => sum + band.count, 0), 2, 'band pick is relaxed, but never the answer cohort');
  assert.equal(banded.histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 1);
  const barred = compute(matrix, { ...options, filters: { studentIds: ['Middle', 'Zero'], bar: { unit: 'marks', from: 6, to: 8, last: false } } });
  assert.deepEqual(barred.shown.map((row) => row.student.id), ['Middle']);
  assert.equal(barred.bands.reduce((sum, band) => sum + band.count, 0), 1);
  assert.equal(barred.histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 2, 'bar pick is relaxed, but never the answer cohort');
});

test('answer cohort IDs normalize numeric legacy IDs and do not mutate the matrix or selections', () => {
  const matrix = matrixOf([student('Top', 'OOO', { id: 1 }), student('Middle', 'WWO', { id: 2 })]);
  const studentIds = new Set(['2', 2, 'missing']);
  const before = JSON.stringify(matrix);
  const selectedBefore = [...all];
  const view = compute(matrix, { selected: all, filters: { studentIds } });
  assert.deepEqual(view.shown.map((row) => [row.student.id, row.rank]), [[2, 2]]);
  assert.equal(JSON.stringify(matrix), before);
  assert.deepEqual([...studentIds], ['2', 2, 'missing']);
  assert.deepEqual([...all], selectedBefore);
});
