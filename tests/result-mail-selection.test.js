import test from 'node:test';
import assert from 'node:assert/strict';
import { allShownSelected, canChooseRecipient } from '../client/src/screens/admin/modals/result-mail-selection.js';

const row = (id, status = null, canEmail = true) => ({ id, canEmail, mail: status ? { status } : null });
test('select-all highlight follows every eligible visible checkbox', () => {
  const visible = [row('a'), row('b', 'sent'), row('c', 'failed')];
  const selected = new Set(['a', 'b', 'c']);
  assert.equal(allShownSelected(visible, selected), true);
  selected.delete('b');
  assert.equal(allShownSelected(visible, selected), false);
  selected.add('b');
  assert.equal(allShownSelected(visible, selected), true);
});
test('filter changes derive the highlight from shown rows only', () => {
  const selected = new Set(['a']);
  assert.equal(allShownSelected([row('a')], selected), true);
  assert.equal(allShownSelected([row('a'), row('b')], selected), false);
  assert.equal(allShownSelected([row('b')], selected), false);
});
test('unavailable recipients do not prevent selecting all, and no eligible rows is never selected', () => {
  const excluded = [row('q', 'queued'), row('s', 'sending'), row('g', null, false)];
  assert.ok(excluded.every((item) => !canChooseRecipient(item)));
  assert.equal(allShownSelected([row('a'), ...excluded], new Set(['a'])), true);
  assert.equal(allShownSelected(excluded, new Set(['q', 's', 'g'])), false);
  assert.equal(allShownSelected([], new Set()), false);
  assert.equal(allShownSelected([row('a')], null), false);
});
