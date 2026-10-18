import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeUserRows, sortUsers, USUAL_USER_SORT } from '../client/src/screens/admin/user-list.js';
import { USER_FILTERS } from '../client/src/screens/admin/user-filters.js';
import { allOptionIds, applyFilters } from '../client/src/lib/filters.js';

const student = { email: 'student@example.test', name: 'Student', role: 'student', sapId: '590000001', hasPassword: true, createdAt: '2026-10-01T12:00:00Z', lastSignInAt: '2026-10-15T12:00:00Z' };
const faculty = { email: 'faculty@example.test', name: 'Faculty', role: 'faculty', hasPassword: false, createdAt: '2026-09-01T12:00:00Z', lastSignInAt: null };
const studentBlock = { email: student.email, reason: 'Sample reason', blockedAt: '2026-10-10T12:00:00Z', blockedBy: faculty.email };
const emailBlock = { email: 'email-only@example.test', reason: 'Not registered', blockedAt: '2026-10-16T12:00:00Z', blockedBy: faculty.email };

test('users: accounts and blocks join by canonical email without duplicating the account', () => {
  const rows = mergeUserRows([student, faculty], [{ ...studentBlock, email: '  STUDENT@EXAMPLE.TEST ' }, emailBlock]);
  assert.equal(rows.length, 3);
  const row = rows.find((entry) => entry.email === student.email);
  assert.equal(row.hasAccount, true);
  assert.equal(row.blocked, true);
  assert.equal(row.name, student.name);
  assert.equal(row.sapId, student.sapId);
  assert.deepEqual(row.block, studentBlock);
});

test('users: a blocked address with no account is retained without inventing a role or sign-in', () => {
  const [row] = mergeUserRows([], [emailBlock]);
  assert.equal(row.email, emailBlock.email);
  assert.equal(row.name, emailBlock.email);
  assert.equal(row.blocked, true);
  assert.equal(row.hasAccount, false);
  assert.equal(row.role, null);
  assert.equal(row.hasPassword, false);
  assert.equal(row.createdAt, null);
});

test('users: deleting a blocked account never removes the block from the combined list', () => {
  const [before] = mergeUserRows([student], [studentBlock]);
  const [after] = mergeUserRows([], [studentBlock]);
  assert.equal(before.email, after.email);
  assert.equal(before.hasAccount, true);
  assert.equal(after.hasAccount, false);
  assert.equal(after.blocked, true);
  assert.deepEqual(after.block, before.block);
});

test('users: unblocking keeps a registered account, and removes a standalone blocked email', () => {
  const [row] = mergeUserRows([student], []);
  assert.equal(row.hasAccount, true);
  assert.equal(row.blocked, false);
  assert.equal(row.block, null);
  assert.deepEqual(mergeUserRows([], []), []);
});

test('users: an API blocked flag still marks the row when block metadata is unavailable', () => {
  const [row] = mergeUserRows([{ ...student, blocked: true }]);
  assert.equal(row.blocked, true);
  assert.equal(row.block, null);
});

test('users: blank emails are skipped, duplicate accounts are one row, and latest block wins', () => {
  const latest = { ...studentBlock, blockedAt: '2026-10-15T12:00:00Z', reason: 'Latest reason' };
  const rows = mergeUserRows([{ email: '' }, student, { ...student, email: 'STUDENT@EXAMPLE.TEST' }], [studentBlock, latest, { ...studentBlock, blockedAt: null }, { email: '  ' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].block.reason, latest.reason);
});

test('users: merging and sorting never mutate API objects or arrays', () => {
  const account = Object.freeze({ ...student });
  const block = Object.freeze({ ...studentBlock });
  const accounts = Object.freeze([account]);
  const blocks = Object.freeze([block]);
  const rows = mergeUserRows(accounts, blocks);
  assert.notEqual(rows[0], account);
  assert.notEqual(rows[0].block, block);
  sortUsers(Object.freeze(rows), 'name-desc');
  assert.equal(account.blocked, undefined);
});

test('users: role, sign-in and access are independent, and Select all retains every entry', () => {
  const rows = mergeUserRows([student, faculty], [studentBlock, emailBlock]);
  assert.equal(applyFilters(rows, USER_FILTERS, ['blocked']).length, 2);
  assert.deepEqual(applyFilters(rows, USER_FILTERS, ['blocked', 'student']).map((row) => row.email), [student.email]);
  assert.deepEqual(applyFilters(rows, USER_FILTERS, ['allowed']).map((row) => row.email), [faculty.email]);
  assert.deepEqual(applyFilters(rows, USER_FILTERS, ['microsoft']).map((row) => row.email), [faculty.email]);
  assert.deepEqual(applyFilters(rows, USER_FILTERS, ['no-account', 'no-signin']).map((row) => row.email), [emailBlock.email]);
  assert.equal(applyFilters(rows, USER_FILTERS, allOptionIds(USER_FILTERS)).length, rows.length);
  for (const group of USER_FILTERS) {
    for (const row of rows) assert.equal(group.options.filter((option) => option.test(row)).length, 1, group.id);
  }
});

test('users: newest/oldest include email-only block dates; missing login dates stay last both ways', () => {
  const rows = mergeUserRows([student, faculty], [studentBlock, emailBlock]);
  assert.equal(USUAL_USER_SORT, 'created-desc');
  assert.deepEqual(sortUsers(rows).map((row) => row.email), [emailBlock.email, student.email, faculty.email]);
  assert.deepEqual(sortUsers(rows, 'created-asc').map((row) => row.email), [faculty.email, student.email, emailBlock.email]);
  for (const sort of ['login-asc', 'login-desc']) assert.equal(sortUsers(rows, sort)[0].email, student.email);
});

test('users: date sorting handles invalid and epoch dates, and name sorting reverses', () => {
  const rows = mergeUserRows([{ ...student, createdAt: 0 }, { ...faculty, createdAt: 'not-a-date' }]);
  assert.equal(sortUsers(rows, 'created-asc')[0].email, student.email);
  assert.equal(sortUsers(rows, 'created-desc')[0].email, student.email);
  assert.deepEqual(sortUsers(rows, 'name-asc').map((row) => row.name), ['Faculty', 'Student']);
  assert.deepEqual(sortUsers(rows, 'name-desc').map((row) => row.name), ['Student', 'Faculty']);
});
