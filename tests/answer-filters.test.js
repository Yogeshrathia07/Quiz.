import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANSWER_FILTER_LIMITS, ANSWER_FILTER_STATES, decodeAnswerFilters, encodeAnswerFilters,
  evaluateAnswerFilters, matchesAnswerFilters, parseAnswerFilters, sanitizeAnswerFilters
} from '../client/src/screens/admin/answer-filters.js';
import { matchesAnswerFilters as serverMatch } from '../src/domain/answer-filters.js';

const questions = [
  { id: 'q1', type: 'msq', options: ['First', 'Second', 'Third'] },
  { id: 'q2', type: 'mcq', options: ['Yes', 'No'] },
  { id: 'q3', type: 'short', options: [] }
];
const cohort = ['a', 'b', 'c', 'd', 'e', 'f'];
const response = (id, state, picks = []) => ({ id, state, picks });
const details = {
  q1: { question: questions[0], responses: [response('a', 'O', [0, 2]), response('b', 'W', [0, 1]), response('c', 'P', [2]), response('d', 'B', [0]), response('e', 'Q', [0])] },
  q2: { question: questions[1], responses: [response('a', 'W', [1]), response('b', 'O', [0]), response('c', 'B'), response('e', 'Q', [0]), response('f', 'O', [0])] },
  q3: { question: questions[2], responses: [response('a', 'Q'), response('b', 'O'), response('c', 'P'), response('d', 'B'), response('e', 'W')] }
};
const clause = (id = 'q1', options = {}, states = [], optionMatch = 'all') => ({ id, optionMatch, options, states });
const filter = (entries, mode = 'all') => ({ mode, questions: entries });
const ids = (raw, students = cohort, loaded = details) => evaluateAnswerFilters(raw, students, loaded).ids;
const invalid = (run) => assert.throws(run, (error) => error instanceof TypeError && error.code === 'ANSWER_FILTER_INVALID');

test('one shared implementation serves the browser and server', () => {
  assert.equal(matchesAnswerFilters, serverMatch);
  assert.deepEqual(ANSWER_FILTER_STATES.map(({ id }) => id), ['O', 'W', 'P', 'B', 'Q', 'N']);
  assert.ok(Object.isFrozen(ANSWER_FILTER_STATES));
});

test('no conditions and ignored option rules do not filter students or request details', () => {
  for (const raw of [undefined, null, {}, filter([]), filter([clause()]), filter([clause('q1', { 0: 'ignore' })])]) {
    const result = evaluateAnswerFilters(raw, cohort, {});
    assert.equal(result.status, 'idle'); assert.equal(result.active, 0); assert.deepEqual(result.ids, cohort);
    assert.equal(encodeAnswerFilters(raw), '');
  }
});

test('received blank papers count as Not selected, absent questions do not', () => {
  assert.deepEqual(ids(filter([clause('q1', { 0: 'not-selected' })])), ['c', 'd']);
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected' })])), ['a', 'b', 'e']);
});

test('all option rules AND the actual MSQ selections, not an exact choice set', () => {
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected', 1: 'not-selected' })])), ['a', 'e']);
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected', 2: 'selected' })])), ['a']);
  assert.deepEqual(ids(filter([clause('q1', { 0: 'not-selected', 1: 'not-selected', 2: 'not-selected' })])), ['d']);
});

test('any option rules allow option A OR B without changing global question semantics', () => {
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected', 2: 'selected' }, [], 'any')])), ['a', 'b', 'c', 'e']);
  assert.deepEqual(ids(filter([clause('q1', { 0: 'not-selected', 2: 'not-selected' }, [], 'any')])), ['b', 'c', 'd', 'e']);
  assert.deepEqual(ids(filter([clause('q2', { 0: 'selected', 1: 'selected' }, [], 'all')])), [], 'MCQ cannot select both');
  assert.deepEqual(ids(filter([clause('q2', { 0: 'selected', 1: 'selected' }, [], 'any')])), ['a', 'b', 'e', 'f']);
});

test('global all/any combines whole question clauses', () => {
  const clauses = [clause('q1', { 0: 'selected' }), clause('q2', {}, ['O'])];
  assert.deepEqual(ids(filter(clauses)), ['b']);
  assert.deepEqual(ids(filter(clauses, 'any')), ['a', 'b', 'e', 'f']);
});

test('each recorded outcome is distinct; pending selections still match', () => {
  for (const [state, expected] of [['O', 'a'], ['W', 'b'], ['P', 'c'], ['B', 'd'], ['Q', 'e'], ['N', 'f']]) {
    assert.deepEqual(ids(filter([clause('q1', {}, [state])])), [expected]);
  }
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected' }, ['Q'])])), ['e']);
  assert.deepEqual(ids(filter([clause('q1', {}, ['W', 'Q'])])), ['b', 'e'], 'outcomes are an OR set');
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected' }, ['W', 'Q'])])), ['b', 'e'], 'outcome and option expression are ANDed');
});

test('Not on paper requires known complete response data and never matches option rules', () => {
  assert.deepEqual(ids(filter([clause('q1', {}, ['N'])])), ['f']);
  for (const rule of ['selected', 'not-selected']) {
    for (const optionMatch of ['all', 'any']) assert.deepEqual(ids(filter([clause('q1', { 0: rule }, ['N'], optionMatch)])), []);
  }
  assert.deepEqual(ids(filter([clause('q1', {}, ['N'])]), cohort, { q1: { question: questions[0], responses: [] } }), cohort);
});

test('short answer outcomes work without selectable option conditions', () => {
  assert.deepEqual(ids(filter([clause('q3', {}, ['Q'])])), ['a']);
  const result = evaluateAnswerFilters(filter([clause('q3', { 0: 'selected' })]), cohort, details);
  assert.equal(result.status, 'error'); assert.equal(result.ids, null); assert.equal(result.ignored.length, 1);
});

test('duplicate final responses and duplicate picks are resolved deterministically', () => {
  const loaded = { q1: { question: questions[0], responses: [response('a', 'W', [1]), response('a', 'Q', [0, 0, '0', 99, -1, null])] } };
  const result = evaluateAnswerFilters(filter([clause('q1', { 0: 'selected' }, ['Q'])]), ['a', 'a', 'b'], loaded);
  assert.deepEqual(result.ids, ['a']);
});

test('only the current submitted cohort is considered and its stable order is kept', () => {
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected' })]), [{ id: 'e' }, { id: 'b' }, { id: 'e' }, { id: null }]), ['e', 'b']);
  assert.deepEqual(ids(filter([clause('q1', { 0: 'selected' })]), new Set(['b', 'd'])), ['b']);
  assert.deepEqual(ids(filter([clause('q1', {}, ['N'])]), []), []);
});

test('missing, loading, and errored details never masquerade as an empty matching group', () => {
  const raw = filter([clause('q1', { 0: 'selected' })]);
  for (const loaded of [{}, { q1: { loading: true } }, { q1: { status: 'loading' } }, { q1: { data: null } }]) {
    const result = evaluateAnswerFilters(raw, cohort, loaded);
    assert.equal(result.status, 'loading'); assert.equal(result.ids, null); assert.deepEqual(result.pending, ['q1']);
  }
  for (const problem of [new Error('Offline'), 'Offline']) {
    const result = evaluateAnswerFilters(raw, cohort, { q1: { error: problem } });
    assert.equal(result.status, 'error'); assert.equal(result.ids, null); assert.equal(result.errors[0].message, 'Offline');
  }
});

test('global any still waits for all requested data, even when a loaded clause already matches', () => {
  const raw = filter([clause('q1', { 0: 'selected' }), clause('q2', {}, ['O'])], 'any');
  const result = evaluateAnswerFilters(raw, ['a'], { q1: details.q1 });
  assert.equal(result.status, 'loading'); assert.equal(result.ids, null); assert.deepEqual(result.pending, ['q2']);
  const failed = evaluateAnswerFilters(raw, ['a'], { q1: { error: 'Offline' } });
  assert.equal(failed.status, 'error'); assert.deepEqual(failed.pending, ['q2']);
});

test('malformed and mismatched replies are explicit data errors', () => {
  const raw = filter([clause('q1', { 0: 'selected' })]);
  const broken = [
    {}, { question: questions[1], responses: [] }, { question: { id: 'q1' }, responses: [] },
    { question: questions[0], responses: null }, { question: questions[0], responses: [null] },
    { question: questions[0], responses: [response('a', 'unknown')] },
    { question: questions[0], responses: [{ id: 'a', state: 'Q' }] }
  ];
  for (const data of broken) {
    const result = evaluateAnswerFilters(raw, ['a'], { q1: data });
    assert.equal(result.status, 'error'); assert.equal(result.ids, null); assert.ok(result.errors[0].message);
  }
});

test('ready data wrappers and maps are supported, inherited entries are not trusted', () => {
  const raw = filter([clause('q1', { 0: 'selected' })]);
  assert.deepEqual(ids(raw, cohort, new Map([['q1', details.q1]])), ['a', 'b', 'e']);
  assert.deepEqual(ids(raw, cohort, { q1: { status: 'ready', data: details.q1 } }), ['a', 'b', 'e']);
  assert.equal(evaluateAnswerFilters(raw, cohort, Object.create({ q1: details.q1 })).status, 'loading');
});

test('option bounds survive matrix-only metadata until the real question loads', () => {
  const raw = filter([clause('q1', { 99: 'selected' })]);
  assert.equal(sanitizeAnswerFilters(raw).questions[0].options[99], 'selected');
  assert.equal(sanitizeAnswerFilters(raw, [{ id: 'q1' }]).questions[0].options[99], 'selected');
  assert.equal(evaluateAnswerFilters(raw, cohort, {}).status, 'loading');
  const result = evaluateAnswerFilters(raw, cohort, details);
  assert.equal(result.status, 'error'); assert.equal(result.ids, null); assert.equal(result.active, 1); assert.ok(result.ignored.length);
  invalid(() => parseAnswerFilters(raw, { questions, strict: true }));
});

test('invalid and stale evaluated rules fail closed instead of silently broadening the cohort', () => {
  for (const raw of [filter([clause('q1', { 0: 'typo' })]), filter([clause('q1', {}, ['unknown'])]), { mode: 'all', question: [] },
    filter([clause('q1', { 0: 'selected', 99: 'not-selected' })])]) {
    const result = evaluateAnswerFilters(raw, cohort, details);
    assert.equal(result.status, 'error'); assert.equal(result.ids, null); assert.ok(result.active); assert.ok(result.errors.length);
  }
});

test('sanitization drops stale questions, invalid rules, and inactive clauses without mutating source', () => {
  const raw = filter([
    clause('q1', { 0: 'selected', 1: 'ignore', '-1': 'selected', '01': 'selected', x: 'selected', 2: 'invalid' }, ['Q', 'O', 'Q', 'bad']),
    clause('missing', { 0: 'selected' }), clause('q2')
  ], 'any');
  const snapshot = JSON.stringify(raw);
  assert.deepEqual(sanitizeAnswerFilters(raw, questions), filter([clause('q1', { 0: 'selected' }, ['O', 'Q'])], 'any'));
  assert.equal(JSON.stringify(raw), snapshot);
});

test('Any outcomes and all outcome choices are equivalent to no outcome constraint', () => {
  const rules = { 0: 'selected' };
  for (const states of [[], ['any'], ANSWER_FILTER_STATES.map(({ id }) => id)]) {
    assert.deepEqual(ids(filter([clause('q1', rules, states)])), ['a', 'b', 'e']);
  }
  assert.deepEqual(sanitizeAnswerFilters(filter([clause('q1', {}, ['.'])])), filter([clause('q1', {}, ['N'])]));
});

test('strict URL parsing rejects malformed data instead of silently clearing filters', () => {
  for (const raw of ['{bad', 'null', '[]', 'false', filter([clause('missing', {}, ['O'])]), filter([clause('q1', {}, ['no'])]),
    { mode: 'wrong', questions: [] }, { mode: 'all', questions: {} }, { mode: 'all', question: [] },
    filter([{ id: 'q1', state: 'O' }]), filter([clause('q1', {}, ['any', 'bad'])]), filter([clause('q1', { 0: 'bad' })])]) {
    invalid(() => decodeAnswerFilters(typeof raw === 'string' ? raw : JSON.stringify(raw), questions));
  }
  assert.deepEqual(decodeAnswerFilters('', questions), filter([]));
  assert.deepEqual(decodeAnswerFilters(undefined, questions), filter([]));
});

test('URL serialization round trips through URLSearchParams without double escaping', () => {
  const bank = [{ id: 'q / & + % 漢字', type: 'mcq', options: ['A', 'B'] }];
  const raw = filter([clause(bank[0].id, { 0: 'not-selected' }, ['Q', 'B'], 'any')], 'any');
  const url = new URL('https://quiz.example/?admin=TEST-A&tab=analysis');
  url.searchParams.set('af', encodeAnswerFilters(raw, bank));
  assert.deepEqual(decodeAnswerFilters(new URL(url).searchParams.get('af'), bank), sanitizeAnswerFilters(raw, bank));
});

test('limits fail strict parsing and do not leave oversized rules in the sanitized client value', () => {
  invalid(() => decodeAnswerFilters(' '.repeat(ANSWER_FILTER_LIMITS.urlLength + 1) + '{}'));
  const many = filter(Array.from({ length: ANSWER_FILTER_LIMITS.questions + 1 }, (_, index) => clause(`q${index}`, {}, ['O'])));
  invalid(() => parseAnswerFilters(many, { strict: true }));
  assert.equal(sanitizeAnswerFilters(many).questions.length, ANSWER_FILTER_LIMITS.questions);
  invalid(() => parseAnswerFilters(filter([clause('x'.repeat(ANSWER_FILTER_LIMITS.idLength + 1), {}, ['O'])]), { strict: true }));
  invalid(() => parseAnswerFilters(filter([clause('q1', Object.fromEntries(Array.from({ length: 33 }, (_, index) => [index, 'selected'])))]), { strict: true }));
  invalid(() => parseAnswerFilters(filter([clause('q1', {}, Array(33).fill('O'))]), { strict: true }));
});

test('duplicate question conditions sanitize to the final entry but strict links reject ambiguity', () => {
  const raw = filter([clause('q1', { 0: 'selected' }), clause('q1', { 0: 'not-selected' })]);
  assert.deepEqual(sanitizeAnswerFilters(raw), filter([clause('q1', { 0: 'not-selected' })]));
  invalid(() => parseAnswerFilters(raw, { questions, strict: true }));
});

test('short/manual legacy banks reject option rules even when their options array is missing', () => {
  for (const question of [{ id: 'q1', type: 'short' }, { id: 'q1', manualGrading: true }]) {
    invalid(() => parseAnswerFilters(filter([clause('q1', { 0: 'selected' })]), { questions: [question], strict: true }));
  }
});

test('JSON prototype-like IDs and option keys cannot pollute objects or access inherited details', () => {
  const raw = JSON.parse('{"mode":"all","questions":[{"id":"__proto__","options":{"0":"selected","__proto__":"selected"},"states":[]}]}');
  const bank = [{ id: '__proto__', type: 'mcq', options: ['A'] }];
  const clean = sanitizeAnswerFilters(raw, bank);
  assert.equal({}.selected, undefined);
  assert.deepEqual(clean.questions[0].options, { 0: 'selected' });
  assert.equal(evaluateAnswerFilters(clean, ['a'], {}).status, 'loading');
  assert.deepEqual(ids(clean, ['a'], new Map([['__proto__', { question: bank[0], responses: [response('a', 'O', [0])] }]])), ['a']);
});

test('all three-option choice combinations agree with a direct boolean truth table', () => {
  const rows = Array.from({ length: 8 }, (_, mask) => response(String(mask), 'Q', [0, 1, 2].filter((index) => mask & (1 << index))));
  const loaded = { q1: { question: questions[0], responses: rows } };
  for (const rule0 of ['ignore', 'selected', 'not-selected']) for (const rule1 of ['ignore', 'selected', 'not-selected']) {
    for (const optionMatch of ['all', 'any']) {
      const options = { 0: rule0, 1: rule1 };
      const active = Object.entries(options).filter(([, rule]) => rule !== 'ignore');
      const expected = rows.filter((row) => !active.length || (optionMatch === 'any'
        ? active.some(([index, rule]) => row.picks.includes(Number(index)) === (rule === 'selected'))
        : active.every(([index, rule]) => row.picks.includes(Number(index)) === (rule === 'selected')))).map(({ id }) => id);
      assert.deepEqual(ids(filter([clause('q1', options, [], optionMatch)]), rows, loaded), expected);
    }
  }
});

test('evaluation and serialization never mutate nested filters, cohort or response data', () => {
  const raw = filter([clause('q1', { 0: 'selected', 1: 'not-selected' }, ['Q', 'O'])]);
  const snapshot = JSON.stringify({ raw, cohort, details });
  evaluateAnswerFilters(raw, cohort, details); encodeAnswerFilters(raw, questions);
  assert.equal(JSON.stringify({ raw, cohort, details }), snapshot);
});
