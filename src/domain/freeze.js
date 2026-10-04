import { PublicTestError } from '../lib/errors.js';

/**
 * A test's results frozen (`resultsFrozenAt`): its marks are final. Nothing
 * that would change a mark or a handed-in paper runs until they are unfrozen -
 * marking by hand or from Excel, editing the questions or what they are worth,
 * restarting, resetting or resuming the test, reopening or restarting one
 * paper, deleting the test. Releasing or holding the marks, viewing and
 * exporting them still work.
 */
export const resultsFrozen = (test) => Boolean(test?.resultsFrozenAt);

export function refuseIfFrozen(test, doing) {
  if (!resultsFrozen(test)) return;
  throw new PublicTestError(409, `This test's results are frozen, so you cannot ${doing}. Unfreeze them first (More → Unfreeze results).`, 'RESULTS_FROZEN');
}
