// What leaving the test costs, in the student's words. One place, so the
// start page, the paper and the warning badge never disagree.

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** The rule, as a sentence (with a leading space, to follow other text). */
export function leavingRules(test) {
  // Neither Warn nor Lock: there are no limits, only the record.
  if (test.violationAction === 'record') return '';
  const exits = Number(test.fullscreenExitLimit) || 0;
  const away = Number(test.fullscreenAbsenceLimitSeconds) || 0;
  const limits = [exits > 0 && `leave ${plural(exits, 'time')}`, away > 0 && `be away ${away} seconds in total`].filter(Boolean);
  if (!limits.length) return test.warnsOnViolation ? ' You get a warning each time you leave.' : '';
  const allowed = ` You may ${limits.join(' and ')}.`;
  if (test.locksOnViolation) {
    const warnings = Number(test.warningsBeforeLock) || 0;
    return allowed + (warnings > 0
      ? ` Going past that gives you ${plural(warnings, 'warning')}; the next time locks your attempt until your administrator approves it.`
      : ' Going past that locks your attempt until your administrator approves it.');
  }
  return allowed + (test.warnsOnViolation
    ? ' After that you get a warning each time, and your administrator is told.'
    : ' Going past that is reported to your administrator.');
}

/** Where the student stands right now, for the warning badge. */
export function leavingStatus(attempt) {
  const limited = attempt.fullscreenExitLimit > 0 || attempt.fullscreenAbsenceLimitSeconds > 0;
  if (!attempt.locksOnViolation || !limited) return 'Every exit is recorded and shown to your administrator.';
  const warnings = Number(attempt.warningsBeforeLock) || 0;
  const used = Number(attempt.violationCount) || 0;
  if (warnings === 0) return 'Going past the limit locks your attempt.';
  return used >= warnings
    ? 'No warnings left: going past the limit again locks your attempt.'
    : `${used} of ${plural(warnings, 'warning')} used. After the last one, going past the limit locks your attempt.`;
}

/**
 * Warn before either refreshed allowance is exhausted. Exit limits are
 * discrete, so using the last permitted exit is the last chance. Away time is
 * continuous, so warn during its final 20% (never later than the final 10s,
 * and never with less than 2s notice).
 */
export function leavingWarningState(attempt) {
  const exits = Number(attempt.fullscreenExitCount) || 0;
  const exitLimit = Number(attempt.fullscreenExitLimit) || 0;
  const awayMs = Number(attempt.fullscreenTotalAbsenceMs) || 0;
  const awayLimitMs = (Number(attempt.fullscreenAbsenceLimitSeconds) || 0) * 1000;
  const remainingAwayMs = awayLimitMs > 0 ? Math.max(0, awayLimitMs - awayMs) : null;
  const awayWarningMs = awayLimitMs > 0
    ? Math.min(10_000, Math.max(2_000, Math.ceil(awayLimitMs * 0.2)))
    : 0;
  const over = (exitLimit > 0 && exits > exitLimit) || (awayLimitMs > 0 && awayMs > awayLimitMs);
  const exitsLow = exitLimit > 0 && exits === exitLimit;
  const awayLow = awayLimitMs > 0 && awayMs > 0 && remainingAwayMs <= awayWarningMs;
  return { exits, exitLimit, awayMs, awayLimitMs, remainingAwayMs, over, exitsLow, awayLow, low: exitsLow || awayLow };
}
