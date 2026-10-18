import test from 'node:test';
import assert from 'node:assert/strict';
import { firstInvalidField } from '../client/src/lib/form-validation.js';

test('form validation finds the first native constraint failure in document order', () => {
  const valid = { willValidate: true, validity: { valid: true } };
  const first = { willValidate: true, validity: { valid: false }, hidden: true };
  const later = { willValidate: true, validity: { valid: false } };
  assert.equal(firstInvalidField({ elements: [valid, first, later] }), first);
});

test('form validation skips barred controls and returns null when every eligible field is valid', () => {
  const disabled = { willValidate: false, validity: { valid: false } };
  const button = { willValidate: false };
  const valid = { willValidate: true, validity: { valid: true } };
  assert.equal(firstInvalidField({ elements: [disabled, button, valid] }), null);
  assert.equal(firstInvalidField({ elements: [] }), null);
  assert.equal(firstInvalidField(null), null);
});

test('inspecting hidden fields never dispatches validation or focuses them before reveal', () => {
  const field = { willValidate: true, validity: { valid: false },
    checkValidity: () => assert.fail('must not dispatch invalid events'),
    reportValidity: () => assert.fail('must reveal the field before reporting it'),
    focus: () => assert.fail('must reveal the field before focusing it') };
  assert.equal(firstInvalidField({ elements: [field] }), field);
  assert.equal(firstInvalidField({ elements: [field] }), field);
});
