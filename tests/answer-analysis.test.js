import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_ANALYSIS_OUTCOMES, answerAnalysisOf, answerConditionOf, answerOutcomePatch, updateAnswerCondition
} from '../client/src/screens/admin/answer-analysis.js';

const question = { id: 'q1', type: 'msq', options: ['First', 'Second', 'Third'], correctOptions: ['0', '2'] };
const students = [
  { id: 1, name: 'Ada Lovelace', sapId: '10001', email: 'ada@example.test' },
  { id: '2', name: 'Grace Hopper', sapId: '10002' },
  { id: '3', name: 'Alan Turing', sapId: '10003' },
  { id: '4', name: 'Edsger Dijkstra', sapId: '10004' },
  { id: '5', name: 'Katherine Johnson', sapId: '10005' },
  { id: '6', name: 'Margaret Hamilton', sapId: '10006' }
];
const response = (id, state, picks = []) => ({ id, state, picks });
const detail = { question, responses: [response(1, 'O', [0, 2]), response('2', 'W', [0, 1]),
  response('3', 'P', [2]), response('4', 'B', [0]), response('5', 'Q', [0])] };
const clause = (id = 'q1', options = {}, states = [], optionMatch = 'all') => ({ id, options, states, optionMatch });
const filters = (questions = [], mode = 'all') => ({ mode, questions });
const analyze = (patch = {}) => answerAnalysisOf({ question, detail, students, ...patch });
const outcome = (result, id) => result.outcomes.find((entry) => entry.id === id);

test('Correct, Incorrect and All replace contradictory outcome and option constraints', () => {
  const source = filters([clause('q1', { 1: 'selected' }, ['W']), clause('q2', {}, ['P'])]);
  const correct = updateAnswerCondition(source, 'q1', answerOutcomePatch(question, 'correct'));
  assert.deepEqual(correct.questions[0], clause('q1', { 0: 'selected', 1: 'not-selected', 2: 'selected' }));
  assert.deepEqual(correct.questions[1], source.questions[1]);
  const wrong = updateAnswerCondition(correct, 'q1', answerOutcomePatch(question, 'incorrect'));
  assert.deepEqual(wrong.questions[0], clause('q1', {}, ['W']));
  const all = updateAnswerCondition(wrong, 'q1', answerOutcomePatch(question, 'all'));
  assert.deepEqual(all, filters([source.questions[1]]));
});

test('written Correct uses recorded outcomes without inventing selectable options', () => {
  assert.deepEqual(answerOutcomePatch({ type: 'short', options: [] }, 'correct'), { options: {}, optionMatch: 'all', states: ['O'] });
  assert.deepEqual(answerOutcomePatch({ type: 'short', options: [] }, 'incorrect'), { options: {}, optionMatch: 'all', states: ['W'] });
  assert.deepEqual(answerOutcomePatch({ type: 'short', options: [] }, 'all'), { options: {}, optionMatch: 'all', states: [] });
});

test('Correct accepts numeric answer keys and unavailable keys fall back to recorded outcomes', () => {
  assert.deepEqual(answerOutcomePatch({ type: 'mcq', options: ['A', 'B'], correctOptions: [1] }, 'correct'), {
    options: { 0: 'not-selected', 1: 'selected' }, optionMatch: 'all', states: []
  });
  assert.deepEqual(answerOutcomePatch({ type: 'mcq', options: ['A'], correctOptions: ['9'] }, 'correct'), {
    options: {}, optionMatch: 'all', states: ['O']
  });
});

test('condition access normalizes numeric IDs and returns independent default fields', () => {
  const source = filters([clause('0', { 0: 'selected' }, ['O'])], 'any');
  const found = answerConditionOf(source, 0);
  assert.deepEqual(found, clause('0', { 0: 'selected' }, ['O']));
  found.options[0] = 'not-selected'; found.states.push('W');
  assert.deepEqual(source.questions[0], clause('0', { 0: 'selected' }, ['O']));
  const missing = answerConditionOf(source, 2);
  assert.deepEqual(missing, clause('2'));
  missing.states.push('O');
  assert.deepEqual(answerConditionOf(source, 2).states, []);
});

test('editing a question replaces only its supplied fields and preserves other conditions and mode', () => {
  const source = filters([clause('q1', { 0: 'selected' }, ['O']), clause('q2', { 1: 'not-selected' }, ['W'])], 'any');
  const before = JSON.stringify(source);
  const next = updateAnswerCondition(source, 'q1', { states: ['P', 'W'] });
  assert.deepEqual(next, filters([clause('q1', { 0: 'selected' }, ['W', 'P']), source.questions[1]], 'any'));
  assert.equal(JSON.stringify(source), before);
  next.questions[1].states.push('O');
  assert.equal(JSON.stringify(source), before);
});

test('Ignore removes inactive rules without removing another question or changing option match mode', () => {
  const source = filters([clause('q1', { 0: 'selected' }, ['O'], 'any'), clause('q2', {}, ['B'])]);
  const next = updateAnswerCondition(source, 'q1', { options: { 0: 'ignore' }, states: [] });
  assert.deepEqual(next, filters([clause('q2', {}, ['B'])]));
  const replaced = updateAnswerCondition(source, 'q1', { options: { 2: 'not-selected' } });
  assert.deepEqual(replaced.questions[0], clause('q1', { 2: 'not-selected' }, ['O'], 'any'));
});

test('new question conditions append, empty patches stay inactive and authoritative banks remove stale rules', () => {
  const source = filters([clause('q2', {}, ['B'])], 'any');
  assert.deepEqual(updateAnswerCondition(source, 'q1', { states: ['O'] }), filters([source.questions[0], clause('q1', {}, ['O'])], 'any'));
  assert.deepEqual(updateAnswerCondition(source, 'q1', {}), source);
  assert.deepEqual(updateAnswerCondition(source, '', { states: ['O'] }), source);
  assert.deepEqual(updateAnswerCondition(source, 'q1', { states: ['O'], options: { 99: 'selected' } }, [question]), filters([clause('q1', {}, ['O'])], 'any'));
});

test('whole-class baseline separates every recorded outcome, with explicit denominator for each', () => {
  const result = analyze();
  assert.equal(result.status, 'ready');
  assert.equal(result.totalSubmitted, 6); assert.equal(result.total, 6);
  assert.equal(result.received, 5); assert.equal(result.notOnPaper, 1); assert.equal(result.optionDenominator, 5);
  assert.deepEqual(result.outcomes.map(({ id, count, percent, denominator }) => [id, count, percent, denominator]),
    [['O', 1, 20, 5], ['W', 1, 20, 5], ['P', 1, 20, 5], ['B', 1, 20, 5], ['Q', 1, 20, 5], ['N', 1, 16.7, 6]]);
  assert.deepEqual(result.rows.map(({ student, state }) => [student.id, state]), [[1, 'O'], ['2', 'W'], ['3', 'P'], ['4', 'B'], ['5', 'Q'], ['6', 'N']]);
  assert.deepEqual(result.rows[5].picks, []);
  assert.equal(Object.isFrozen(ANSWER_ANALYSIS_OUTCOMES), true);
});

test('multiple selections count each student once per option and blank picks do not count', () => {
  const result = analyze();
  assert.deepEqual(result.options.map(({ count, percent, correct }) => [count, percent, correct]), [[3, 60, true], [1, 20, false], [2, 40, true]]);
  assert.deepEqual(result.rows.find(({ state }) => state === 'B').picks, []);
  assert.deepEqual(result.rows.find(({ state }) => state === 'Q').picks, [0]);
});

test('live matching IDs and search narrow only the requested result, never the baseline input', () => {
  const filtered = { active: true, status: 'ready', ids: [1, '2', '6'] };
  const current = analyze({ filterResult: filtered, search: '  GRACE  ' });
  assert.equal(current.totalSubmitted, 6); assert.equal(current.cohortTotal, 3); assert.equal(current.shown, 1);
  assert.deepEqual(current.rows.map(({ student }) => student.id), ['2']);
  assert.equal(outcome(current, 'W').percent, 100);
  const baseline = analyze();
  assert.equal(baseline.total, 6); assert.equal(outcome(baseline, 'W').percent, 20);
});

test('search matches name, SAP ID, email, fullName and collegeEmail without converting missing fields to text', () => {
  assert.deepEqual(analyze({ search: '10005' }).rows.map(({ student }) => student.id), ['5']);
  assert.deepEqual(analyze({ search: '@EXAMPLE' }).rows.map(({ student }) => student.id), [1]);
  assert.equal(analyze({ search: 'undefined' }).shown, 0);
  const alternative = [{ id: 1, fullName: 'Alternative Name', collegeEmail: 'alternative@example.test' }];
  assert.equal(analyze({ students: alternative, search: 'alternative' }).shown, 1);
});

test('inactive filter IDs are ignored, while active empty IDs are a valid empty matching group', () => {
  assert.equal(analyze({ filterResult: { active: false, status: 'idle', ids: null } }).shown, 6);
  const empty = analyze({ filterResult: { active: true, status: 'ready', ids: [] } });
  assert.equal(empty.status, 'ready'); assert.equal(empty.cohortTotal, 0); assert.deepEqual(empty.rows, []);
  assert.ok(empty.outcomes.every(({ count, percent, denominator }) => count === 0 && percent === null && denominator === 0));
  assert.ok(empty.options.every(({ count, percent }) => count === 0 && percent === null));
});

test('active filter failures never display unfiltered rows or a fabricated zero-student result', () => {
  for (const filterResult of [
    { active: true, status: 'loading', ids: null },
    { active: true, status: 'error', ids: null, errors: [{ id: 'q2', message: 'Offline' }] },
    { active: true, status: 'ready', ids: null }
  ]) {
    const result = analyze({ filterResult });
    assert.ok(['loading', 'error'].includes(result.status));
    assert.equal(result.rows, null); assert.equal(result.total, null); assert.equal(result.outcomes, null);
  }
  assert.equal(analyze({ filterResult: { active: true, status: 'error', errors: [{ message: 'Offline' }] } }).errors[0].message, 'Offline');
});

test('unknown or loading detail never treats every student as not-on-paper', () => {
  for (const held of [undefined, null, { loading: true }, { status: 'loading' }, { data: null }]) {
    const result = analyze({ detail: held });
    assert.equal(result.status, 'loading'); assert.equal(result.rows, null); assert.equal(result.notOnPaper, null);
  }
  const complete = analyze({ detail: { question, responses: [] } });
  assert.equal(complete.status, 'ready'); assert.equal(complete.notOnPaper, 6);
  assert.equal(outcome(complete, 'N').percent, 100);
  assert.equal(outcome(complete, 'O').percent, null);
});

test('malformed or mismatched question responses fail closed with readable errors', () => {
  for (const held of [
    {}, { question: { ...question, id: 'other' }, responses: [] }, { question: { id: 'q1' }, responses: [] },
    { question, responses: null }, { question, responses: [null] }, { question, responses: [{ state: 'O' }] },
    { question, responses: [{ id: 1, state: 'unknown', picks: [] }] }, { question, responses: [{ id: 1, state: 'Q' }] }
  ]) {
    const result = analyze({ detail: held });
    assert.equal(result.status, 'error'); assert.equal(result.rows, null); assert.ok(result.errors[0].message);
  }
  assert.equal(analyze({ detail: { error: new Error('Offline') } }).errors[0].message, 'Offline');
  assert.equal(analyze({ detail: { status: 'error', error: 'Offline' } }).errors[0].message, 'Offline');
});

test('ready wrappers, numerical IDs, duplicate rows, canonical string picks and invalid picks are normalized', () => {
  const numeric = { ...question, id: 0 };
  const result = answerAnalysisOf({ question: numeric, students: [{ id: 0, name: 'First' }, { id: '0', name: 'Duplicate' }],
    detail: { status: 'ready', data: { question: numeric, responses: [response('0', 'W', [1]), response(0, 'O', [0, '0', '2', '02', -1, 99, 1.5])] } },
    filterResult: { active: true, status: 'ready', ids: new Set(['0', 'unknown']) } });
  assert.equal(result.totalSubmitted, 1); assert.equal(result.total, 1); assert.equal(result.rows[0].student.name, 'First');
  assert.deepEqual(result.rows[0].picks, [0, 2]);
  assert.deepEqual(result.options.map(({ count }) => count), [1, 0, 1]);
});

test('short/manual answers need no option selections and saved outcomes are not recomputed from the answer key', () => {
  for (const short of [{ ...question, type: 'short', options: [] }, { ...question, manualGrading: true }]) {
    const result = analyze({ question: short, students: [students[0]], detail: { question: short, responses: [{ id: 1, state: 'P' }] } });
    assert.equal(result.status, 'ready'); assert.equal(outcome(result, 'P').count, 1);
    assert.deepEqual(result.rows[0].picks, []);
    assert.ok(result.options.every(({ count }) => count === 0));
  }
  const teacherMarked = analyze({ students: [students[0]], detail: { question, responses: [response(1, 'O', [1])] } });
  assert.equal(outcome(teacherMarked, 'O').count, 1);
  assert.equal(teacherMarked.options[1].correct, false);
});

test('empty submitted class, zero received papers, and empty search results use no fabricated percentages', () => {
  for (const result of [analyze({ students: [] }), analyze({ search: 'not-a-student' })]) {
    assert.equal(result.status, 'ready'); assert.equal(result.total, 0); assert.deepEqual(result.rows, []);
    assert.ok(result.outcomes.every(({ percent }) => percent === null));
    assert.ok(result.options.every(({ percent }) => percent === null));
  }
});

test('complete snapshots alone infer absence and explicit legacy absence stays separate from blank', () => {
  const result = analyze({ students: students.slice(0, 2), detail: { question, responses: [response(1, '.', [0]), response('2', 'B', [1])] } });
  assert.equal(result.notOnPaper, 1); assert.equal(result.received, 1);
  assert.equal(outcome(result, 'N').percent, 50); assert.equal(outcome(result, 'B').percent, 100);
  assert.deepEqual(result.options.map(({ count }) => count), [0, 0, 0]);
});

test('analysis and condition updates never mutate saved rules, students or question responses', () => {
  const source = { question, detail, students, filterResult: { active: true, status: 'ready', ids: ['1', '3', '5'] } };
  const before = JSON.stringify(source);
  const result = answerAnalysisOf(source);
  result.rows[0].picks.push(1);
  assert.equal(JSON.stringify(source), before);
});
