import { localDateKey } from './session-dates.js';

const MODES = [
  { id: 'all', label: 'All dates' }, { id: 'month', label: 'Month' },
  { id: 'day', label: 'Day' }, { id: 'range', label: 'Date range' }
];

/** Native calendar pickers work with touch, keyboards and each device's date UI. */
export function SessionDateFilter({ value, onChange, error }) {
  const update = (key, next) => onChange({ ...value, [key]: next });
  const changeMode = (mode) => {
    const today = localDateKey(new Date());
    onChange({ ...value, mode,
      ...(mode === 'month' && !value.month ? { month: today.slice(0, 7) } : {}),
      ...(mode === 'day' && !value.day ? { day: today } : {})
    });
  };
  const field = (key, label, type, attributes = {}) => (
    <label className="att-calendar-field">
      <span>{label}</span>
      <input className="text-input" type={type} value={value[key]} onChange={(event) => update(key, event.target.value)}
        aria-invalid={Boolean(error)} aria-describedby={error ? 'attendance-date-error' : undefined} {...attributes}/>
    </label>
  );
  return (
    <div className="att-calendar">
      <div className="att-calendar-modes" role="group" aria-label="Date filter mode">
        {MODES.map((mode) => (
          <button key={mode.id} type="button" aria-pressed={value.mode === mode.id} onClick={() => changeMode(mode.id)}>
            {mode.label}
          </button>
        ))}
      </div>
      {value.mode === 'all' && <p className="att-calendar-hint">Sessions from every month.</p>}
      {value.mode === 'month' && <>
        {field('month', 'Month', 'month')}
        {field('throughMonth', 'Through month (optional)', 'month', { min: value.month || undefined })}
        <p className="att-calendar-hint">One month, or every month up to the end month.</p>
      </>}
      {value.mode === 'day' && field('day', 'Day', 'date')}
      {value.mode === 'range' && <>
        {field('from', 'From date', 'date', { max: value.to || undefined })}
        {field('to', 'To date', 'date', { min: value.from || undefined })}
        <p className="att-calendar-hint">Both days included. Leave one end empty for an open range.</p>
      </>}
      {error && <p className="att-calendar-error" id="attendance-date-error" role="alert">{error}</p>}
    </div>
  );
}
