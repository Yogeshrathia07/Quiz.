import { dateTime, durationLabel, localDateTime } from '../lib/format.js';
import { extendedEndMs } from '../lib/quiz.js';

const QUICK_MINUTES = [5, 10, 15, 30, 60];

/**
 * The single editor for a test's end time, used both when setting a test up and
 * when extending one that is already running. One component means the quick
 * "+15 min" chips and the exact time picker can never disagree about what the
 * new end time is.
 *
 * The chips add to whichever is later - the value in the field or now - so
 * extending a test whose time has already run out grants real minutes rather
 * than minutes measured from a deadline in the past.
 */
export function EndTimeField({ opensAt, endsAt, onChange, idPrefix, savedEndsAt }) {
  const opensAtMs = new Date(opensAt).getTime();
  const endsAtMs = new Date(endsAt).getTime();
  const windowSeconds = (endsAtMs - opensAtMs) / 1000;
  const valid = Number.isFinite(windowSeconds) && windowSeconds > 0;

  const savedMs = savedEndsAt ? new Date(savedEndsAt).getTime() : null;
  const changeMs = savedMs !== null && Number.isFinite(endsAtMs) ? endsAtMs - Math.max(savedMs, Date.now()) : null;

  return (
    <>
      <div className="quick-picks" role="group" aria-label="Add time to the end time">
        {QUICK_MINUTES.map((value) => (
          <button key={value} type="button" onClick={() => onChange(localDateTime(extendedEndMs(endsAtMs, value)))}>
            +{value} min
          </button>
        ))}
      </div>

      <label className="field-label" htmlFor={`${idPrefix}-ends`}>Test end time</label>
      <input
        id={`${idPrefix}-ends`}
        className="text-input"
        type="datetime-local"
        required
        value={endsAt}
        onChange={(event) => onChange(event.target.value)}
      />

      <p className="help">
        {valid
          ? `Everyone stops at this time — ${durationLabel(windowSeconds)} from the start.`
          : `The end time must be after the start, ${dateTime(opensAt)}.`}
        {changeMs !== null && changeMs > 1_000 && ` Adds ${durationLabel(changeMs / 1000)}.`}
        {changeMs !== null && changeMs < -1_000 && ' This pulls the end time in.'}
      </p>
    </>
  );
}
