import { localDateTime } from '../lib/format.js';

/** "Now", rounded down to the minute, as the datetime-local input wants it. */
export function nowValue(offsetMinutes = 0) {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  at.setSeconds(0, 0);
  return localDateTime(at);
}

/**
 * Today's date with the time already chosen - or, with nothing chosen yet, a
 * few minutes from now. Picking a date on a phone takes several taps; this is one.
 */
export function todayValue(current) {
  const chosen = current ? new Date(current) : null;
  if (!chosen || Number.isNaN(chosen.getTime())) return nowValue(5);
  const today = new Date();
  today.setHours(chosen.getHours(), chosen.getMinutes(), 0, 0);
  return localDateTime(today);
}

/**
 * A date and time with one-tap "Now" and "Today" beside it, plus optional
 * extra quick picks. `extras` is a list of [label, () => value].
 */
export function DateTimeField({ id, label, value, onChange, extras = [] }) {
  const ms = new Date(value).getTime();
  const past = Number.isFinite(ms) && ms < Date.now() - 60_000;
  return (
    <div className="datetime-field">
      <div className="datetime-row">
        <input id={id} aria-label={label} className="text-input" type="datetime-local" required value={value} onChange={(event) => onChange(event.target.value)}/>
        <div className="quick-picks" role="group" aria-label={`${label} shortcuts`}>
          <button type="button" onClick={() => onChange(nowValue())}>Now</button>
          <button type="button" onClick={() => onChange(todayValue(value))}>Today</button>
          {extras.map(([text, pick]) => <button key={text} type="button" onClick={() => onChange(pick())}>{text}</button>)}
        </div>
      </div>
      {past && <p className="help is-warning">{label} is in the past.</p>}
    </div>
  );
}
