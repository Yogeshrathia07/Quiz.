import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardPath, wholeClassPath } from '../client/src/lib/dashboard-paths.js';
import { routeData } from '../client/src/lib/prefetch.js';
import { encodeAnswerFilters } from '../client/src/screens/admin/answer-filters.js';

const af = encodeAnswerFilters({ mode: 'all', questions: [{ id: 'q / + & 漢字', optionMatch: 'all', options: { 0: 'selected', 1: 'not-selected' }, states: [] }] });

test('answer-filtered dashboard paths are unique cache keys and preserve the exact serialized rules', () => {
  const plain = wholeClassPath('TEST-A');
  const matching = wholeClassPath('TEST-A', af);
  assert.notEqual(matching, plain);
  const url = new URL(matching, 'https://quiz.example');
  assert.equal(url.searchParams.get('af'), af, 'no double encoding or damaged Unicode/question IDs');
  assert.equal(url.searchParams.get('section'), 'students');
  assert.equal(url.searchParams.get('pageSize'), '200');
  assert.equal(url.searchParams.get('page'), '1');
  assert.equal(new URL(plain, url).searchParams.has('af'), false);
  assert.equal(wholeClassPath('TEST-A', ''), plain);
});

test('server-paged dashboard paths combine answer rules with page, search, ordinary filters and sort', () => {
  const path = dashboardPath('TEST / A', { section: 'responses', page: 3, pageSize: 50, search: 'Asha + Dev', filters: 'marking:awaiting,finish:student', sort: 'score-desc', af });
  const url = new URL(path, 'https://quiz.example');
  assert.equal(url.pathname, '/api/admin/tests/TEST%20%2F%20A');
  assert.deepEqual(Object.fromEntries(url.searchParams), { section: 'responses', page: '3', pageSize: '50', search: 'Asha + Dev', filters: 'marking:awaiting,finish:student', sort: 'score-desc', af });
  assert.notEqual(path, dashboardPath('TEST / A', { section: 'responses', page: 2, af }));
});

test('prefetch and matching student/result dashboards use the same answer-filtered whole-class key', () => {
  const origin = 'https://quiz.example';
  for (const tab of ['students', 'responses']) {
    const url = new URL('/', origin); url.searchParams.set('admin', 'test-a'); url.searchParams.set('tab', tab); url.searchParams.set('af', af);
    assert.deepEqual(routeData(url.href, 'admin', origin), [wholeClassPath('TEST-A', af)]);
  }
});

test('Analysis and Overview prefetch keep the full class baseline instead of computing an unused filtered cohort', () => {
  const origin = 'https://quiz.example';
  for (const extra of [{ tab: 'analysis' }, { tab: 'test' }, {}, { tab: 'responses', rview: 'analysis' }]) {
    const url = new URL('/', origin); url.searchParams.set('admin', 'test-a'); url.searchParams.set('af', af);
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    assert.deepEqual(routeData(url.href, 'admin', origin), [wholeClassPath('TEST-A')]);
  }
});
