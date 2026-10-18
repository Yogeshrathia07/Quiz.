import assert from 'node:assert/strict';
import test from 'node:test';
import { adminAreaOf, hasQuizResults, primaryLinkOf } from '../client/src/lib/admin-navigation.js';

test('canonical admin lists and the legacy list retain their navigation area', () => {
  assert.equal(adminAreaOf({ admin: 'quizzes' }), 'quizzes');
  assert.equal(adminAreaOf({ admin: 'results' }), 'results');
  assert.equal(adminAreaOf({ admin: 'tests' }), 'quizzes');
  assert.equal(adminAreaOf({ admin: 'tests', view: 'taken' }), 'results');
  assert.equal(adminAreaOf({ admin: 'quizzes', tab: 'analysis' }), 'quizzes', 'a stale tab does not change a list route');
  assert.equal(adminAreaOf({ admin: 'results', tab: 'test' }), 'results');
});

test('dashboard links are grouped without invalidating saved tab and analysis addresses', () => {
  const route = { admin: 'TEST-ABC' };
  for (const tab of [undefined, 'test', 'students', 'unknown']) assert.equal(adminAreaOf({ ...route, tab }), 'quizzes');
  for (const tab of ['responses', 'analysis']) assert.equal(adminAreaOf({ ...route, tab }), 'results');
  assert.equal(adminAreaOf({ ...route, rview: 'analysis' }), 'results');
  assert.equal(adminAreaOf({ ...route, tab: 'students', rview: 'analysis' }), 'results', 'the old analysis view takes precedence as on the dashboard');
  for (const admin of ['create', 'edit']) assert.equal(adminAreaOf({ admin, tab: 'responses' }), 'quizzes');
});

test('the same primary link is selected for admin results, own attempts and shared links', () => {
  assert.equal(primaryLinkOf({}, true), 'home');
  assert.equal(primaryLinkOf({ admin: 'portal' }, true), 'home');
  assert.equal(primaryLinkOf({ admin: 'attendance' }, true), 'attendance');
  assert.equal(primaryLinkOf({ admin: 'users' }, true), 'users');
  assert.equal(primaryLinkOf({ admin: 'quizzes' }, true), 'quizzes');
  assert.equal(primaryLinkOf({ admin: 'TEST-ABC', tab: 'responses' }, true), 'results');
  assert.equal(primaryLinkOf({ admin: 'TEST-ABC', tab: 'students' }, true), 'quizzes');
  assert.equal(primaryLinkOf({ admin: 'tests', view: 'taken' }, true), 'results');
  assert.equal(primaryLinkOf({ page: 'results' }, true), 'results');
  assert.equal(primaryLinkOf({ result: 'TEST-ABC' }, true), 'results');
  assert.equal(primaryLinkOf({ page: 'results' }, false), 'home');
  assert.equal(primaryLinkOf({ result: 'TEST-ABC' }, false), 'home');
  assert.equal(primaryLinkOf({ test: 'TEST-ABC', admin: 'results' }, true), null);
  assert.equal(primaryLinkOf({ attend: 'ATT-ABC', admin: 'attendance' }, true), null);
});

test('result eligibility includes submitted or awaiting papers and closed empty quizzes', () => {
  for (const quiz of [null, {}, { isStarted: true }, { submittedCount: 0, toMarkCount: 0 }, { submittedCount: -1 }]) {
    assert.equal(hasQuizResults(quiz), false);
  }
  for (const quiz of [{ isClosed: true }, { submittedCount: 1 }, { toMarkCount: 2 }, { archivedAt: '2026-10-01', isClosed: true }]) {
    assert.equal(hasQuizResults(quiz), true);
  }
});
