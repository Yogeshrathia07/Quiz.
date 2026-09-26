import { dateTime, durationLabel, localDateTime } from '../lib/format.js';
import { ChoiceCards, Stepper } from './FormControls.jsx';
import { DateTimeField, nowValue } from './DateTimeField.jsx';

/**
 * How a test starts and ends. Two independent choices, so every combination
 * works:
 *   start  manual     - when the admin presses Start
 *          scheduled  - by itself at a set time (a countdown for students)
 *   end    manual     - when the admin presses Close (no clock)
 *          at         - at a set time; every paper is submitted automatically
 *          duration   - so many minutes after it actually starts
 * Not setting a time leaves that moment to the admin.
 */

const START_OPTIONS = [
  { value: 'manual', title: 'When I press Start', description: 'Students wait until you start it from the dashboard.' },
  { value: 'scheduled', title: 'At a set time', description: 'Starts by itself. Students see a countdown.' }
];

const END_OPTIONS = [
  { value: 'manual', title: 'When I press Close', description: 'No clock for students.' },
  { value: 'at', title: 'At a set time', description: 'Every paper is submitted automatically at this time.' },
  { value: 'duration', title: 'After a duration', description: 'Counted from the actual start, so a late start costs no time.' }
];


const later = (value, minutes) => localDateTime(new Date(new Date(value).getTime() + minutes * 60_000));

/** Whole minutes the questions are expected to take, never less than one. */
export const estimateMinutes = (estimatedSeconds) => Math.max(1, Math.ceil(estimatedSeconds / 60));

/** The end time that follows the estimate, from the start (or from now for a manual start). */
export function suggestedEndsAt(values, estimatedSeconds) {
  const base = values.startMode === 'scheduled' && values.opensAt ? new Date(values.opensAt).getTime() : Date.now() + 5 * 60_000;
  if (!Number.isFinite(base)) return '';
  const end = new Date(base + Math.max(estimatedSeconds, 60) * 1000);
  end.setSeconds(0, 0);
  return localDateTime(end);
}

/** The whole plan in one sentence, so the admin can check it at a glance. */
export function scheduleSummary(values) {
  const start = values.startMode === 'scheduled' ? `Starts ${dateTime(values.opensAt)}` : 'Starts when you press Start';
  const end = values.endMode === 'manual' ? 'ends when you press Close'
    : values.endMode === 'duration' ? `runs ${durationLabel((Number(values.durationMinutes) || 0) * 60)}, then auto-submits`
      : `auto-submits at ${dateTime(values.endsAt)}`;
  return `${start} · ${end}.`;
}

/** Problems the server would refuse, said before the admin presses Save. */
export function scheduleProblem(values) {
  const startMs = new Date(values.opensAt).getTime();
  const endMs = new Date(values.endsAt).getTime();
  if (values.startMode === 'scheduled' && !Number.isFinite(startMs)) return 'Choose the start time, or let the test start when you press Start.';
  if (values.endMode === 'at') {
    if (!Number.isFinite(endMs)) return 'Choose the end time.';
    if (endMs <= Date.now()) return 'The end time has already passed.';
    if (values.startMode === 'scheduled' && endMs <= startMs) return 'The end time must be after the start time.';
  }
  if (values.endMode === 'duration' && !(Number(values.durationMinutes) >= 1)) return 'Choose how long the test lasts.';
  return null;
}

/** The end choice alone - also used while a test is running, where only these apply. */
export function EndChoice({ value, onChange, idPrefix, options = END_OPTIONS }) {
  return <ChoiceCards label="Ends" idPrefix={`${idPrefix}-end`} value={value} onChange={onChange} options={options}/>;
}

export const LIVE_END_OPTIONS = END_OPTIONS.filter((option) => option.value !== 'duration');

export function TestWindowFields({ values, estimatedSeconds, onChange, idPrefix }) {
  const windowSeconds = values.endMode === 'duration'
    ? (Number(values.durationMinutes) || 0) * 60
    : values.endMode === 'at' && values.startMode === 'scheduled'
      ? (new Date(values.endsAt).getTime() - new Date(values.opensAt).getTime()) / 1000
      : null;
  const short = Number.isFinite(windowSeconds) && windowSeconds > 0 && windowSeconds < estimatedSeconds;
  const problem = scheduleProblem(values);
  const fit = estimateMinutes(estimatedSeconds);

  const chooseStart = (mode) => {
    onChange('startMode', mode);
    if (mode === 'scheduled' && !values.opensAt) onChange('opensAt', nowValue(5));
  };
  const chooseEnd = (mode) => {
    onChange('endMode', mode);
    if (mode === 'at' && !values.endsAt) onChange('endsAt', suggestedEndsAt(values, estimatedSeconds));
    if (mode === 'duration' && !values.durationMinutes) onChange('durationMinutes', fit);
  };

  return (
    <div className="form-wide schedule-fields">
      <div className="schedule-row">
        <ChoiceCards label="Starts" idPrefix={`${idPrefix}-start`} value={values.startMode} onChange={chooseStart} options={START_OPTIONS}/>
        {values.startMode === 'scheduled' && (
          <DateTimeField
            id={`${idPrefix}-opens`}
            label="Start time"
            value={values.opensAt}
            onChange={(value) => onChange('opensAt', value)}
            extras={[['+15 min', () => nowValue(15)], ['+1 h', () => nowValue(60)]]}
          />
        )}
      </div>

      <div className="schedule-row">
        <EndChoice value={values.endMode} onChange={chooseEnd} idPrefix={idPrefix}/>
        {values.endMode === 'at' && (
          <DateTimeField
            id={`${idPrefix}-ends`}
            label="End time"
            value={values.endsAt}
            onChange={(value) => onChange('endsAt', value)}
            extras={[['+30 min', () => later(values.endsAt || nowValue(), 30)]]}
          />
        )}
        {values.endMode === 'duration' && (
          <Stepper
            id={`${idPrefix}-duration`}
            label="Duration"
            value={values.durationMinutes ?? ''}
            min={1}
            max={24 * 60}
            step={5}
            unit="min"
            onChange={(value) => onChange('durationMinutes', value)}
            presets={[[fit, `Fit questions (${fit} min)`]]}
          />
        )}
      </div>

      <p className={`schedule-summary${problem ? ' is-problem' : ''}`}>
        {problem || scheduleSummary(values)}
        {!problem && (short
          ? ` Shorter than the ${durationLabel(estimatedSeconds)} the questions need.`
          : ` Questions take about ${durationLabel(estimatedSeconds)}.`)}
      </p>
    </div>
  );
}
