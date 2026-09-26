import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSapId } from '../src/domain/test-builder.js';
import { PublicTestError } from '../src/lib/errors.js';

test('SAP IDs are exactly nine numeric digits', () => {
  assert.equal(normalizeSapId('500123456'), '500123456');
  assert.equal(normalizeSapId('000012345'), '000012345');
  for (const invalid of ['', '40004711', '5001234567', '5001A3456', '5001 3456']) {
    assert.throws(() => normalizeSapId(invalid), PublicTestError);
  }
});
