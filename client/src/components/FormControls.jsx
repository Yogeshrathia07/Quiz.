import { useState } from 'react';
import { QUESTION_LAYOUTS } from '../lib/quiz.js';
import { InfoTip } from './InfoTip.jsx';

/**
 * The clickable controls the test forms are built from, so the create form,
 * "Edit test setup" and "Edit running test" all look and behave alike.
 */

/** A titled group inside a form grid: "Timing", "Questions", ... */
export function FormGroupTitle({ title, hint }) {
  return (
    <div className="form-wide form-group-title">
      <h2>{title}</h2>
      {hint && <p>{hint}</p>}
    </div>
  );
}

/**
 * One choice out of a few, as a segmented control. What each option does is
 * an (i) away - beside the label, or after the options when there is none -
 * so the form stays short.
 */
export function ChoiceCards({ label, value, options, onChange, idPrefix, more = null }) {
  const labelId = `${idPrefix}-label`;
  // `more`: a last line for the (i), after the options.
  const about = (more || options.some((option) => option.description)) && (
    <InfoTip label={label ? `About ${label.toLowerCase()}` : 'About these options'}>
      <span className="info-tip-list">
        {options.filter((option) => option.description).map((option) => (
          <span key={String(option.value)} className={option.value === value ? 'is-on' : undefined}>
            <strong>{option.title}</strong>{option.description}
          </span>
        ))}
        {more && <span>{more}</span>}
      </span>
    </InfoTip>
  );
  const segments = (
    <div className="segmented choice-segments" role="radiogroup" aria-labelledby={label ? labelId : undefined}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'is-on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.title}
        </button>
      ))}
    </div>
  );
  return (
    <div className="choice-field">
      {label && (about
        ? <span className="field-label-row"><span className="field-label" id={labelId}>{label}</span>{about}</span>
        : <span className="field-label" id={labelId}>{label}</span>)}
      {!label && about ? <div className="choice-line">{segments}{about}</div> : segments}
    </div>
  );
}

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th, 21st. */
const ordinal = (n) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suffix}`;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * A number with − and + buttons, plus one-tap presets. The field still accepts
 * typing, so an unusual value is one edit away.
 */
export function Stepper({ id, label, value, min = 0, max = 100, step = 1, onChange, unit, presets = [], hint, disabled = false }) {
  const number = Number(value) || 0;
  const set = (next) => onChange(clamp(Math.round(Number(next) || 0), min, max));
  return (
    <div className="stepper-field">
      {label && <label className="field-label" htmlFor={id}>{label}</label>}
      <div className={`stepper${disabled ? ' is-disabled' : ''}`}>
        <button type="button" aria-label={`Decrease ${label || ''}`} disabled={disabled || number <= min} onClick={() => set(number - step)}>−</button>
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          disabled={disabled}
          value={value}
          onChange={(event) => onChange(event.target.value === '' ? '' : clamp(Number(event.target.value), min, max))}
          onBlur={() => set(value)}
        />
        {unit && <span className="stepper-unit">{unit}</span>}
        <button type="button" aria-label={`Increase ${label || ''}`} disabled={disabled || number >= max} onClick={() => set(number + step)}>+</button>
      </div>
      {presets.length > 0 && (
        <div className="quick-picks stepper-presets" role="group" aria-label={`${label || 'Value'} presets`}>
          {presets.map(([preset, text]) => (
            <button key={preset} type="button" disabled={disabled} className={Number(preset) === number ? 'is-on' : ''} onClick={() => set(preset)}>
              {text ?? preset}
            </button>
          ))}
        </div>
      )}
      {hint && <p className="help">{hint}</p>}
    </div>
  );
}

/* ------------------------------------------------ choices shared by forms */

export const LAYOUT_OPTIONS = QUESTION_LAYOUTS.map(([value, title, description]) => ({ value, title, description }));

/** Which devices may sit a test (src/domain/device.js decides what a device is). */
export const DEVICE_OPTIONS = [
  { value: 'any', title: 'Phone or laptop', description: 'Any device. Each student’s device is still shown to you.' },
  { value: 'phone', title: 'Phones only', description: 'Phones and tablets. A laptop or desktop cannot begin - unless you allow that student’s device.' },
  { value: 'laptop', title: 'Laptops only', description: 'Laptops and desktop computers. A phone or tablet cannot begin - unless you allow that student’s device.' }
];

export const MARKS_OPTIONS = [
  { value: 'instant', title: 'On submit', description: 'Each student sees their marks as soon as they submit.' },
  { value: 'after_quiz', title: 'When the test closes', description: 'Everyone sees marks together once the test is closed.' },
  { value: 'admin', title: 'When I release them', description: 'Hidden until you press Release marks on the dashboard.' }
];

/** The two switches, and the stored value each combination makes. */
const MODE_OF = { 'false,false': 'record', 'true,false': 'warn', 'false,true': 'lock', 'true,true': 'warn_lock' };

/** One plain sentence: what is allowed, and what happens after. */
function leavingSummary(mode, exits, away, warnings) {
  if (mode === 'record') return 'No warning and no lock: every exit and the time away are only recorded for you.';
  const limits = [exits > 0 && `${exits} exit${exits === 1 ? '' : 's'}`, away > 0 && `${away >= 60 && away % 60 === 0 ? `${away / 60} min` : `${away} s`} away in total`].filter(Boolean);
  if (!limits.length) return 'No limits: every exit is only recorded.';
  const after = {
    record: 'after that it is only recorded.',
    warn: 'every exit shows a warning, and going past is flagged.',
    lock: 'going past locks the paper at once, with no warning.',
    warn_lock: `going past gives ${warnings} warning${warnings === 1 ? '' : 's'}, then the next time locks the paper.`
  }[mode];
  return `Allowed: ${limits.join(' and ')}; ${after}`;
}

/**
 * What leaving the test does. Two switches, Warn and Lock, so all four
 * combinations are there, and three numbers: exits allowed, total time away
 * allowed, and - with Lock on - warnings before the lock (0 locks straight
 * away). Every exit is recorded whatever is chosen; 0 exits or 0 seconds
 * means that limit is off.
 */
export function IntegrityFields({ values, onChange, idPrefix, live = false }) {
  const exits = Number(values.fullscreenExitLimit) || 0;
  const away = Number(values.fullscreenAbsenceLimitSeconds) || 0;
  const mode = ['record', 'warn', 'lock', 'warn_lock'].includes(values.violationAction) ? values.violationAction : 'lock';
  const warns = mode === 'warn' || mode === 'warn_lock';
  const locks = mode === 'lock' || mode === 'warn_lock';
  const warnings = mode === 'warn_lock' ? Math.max(1, Number(values.warningsBeforeLock) || 0) : 0;
  const setMode = (nextWarns, nextLocks) => {
    onChange('violationAction', MODE_OF[`${nextWarns},${nextLocks}`]);
    // Warn and Lock together need at least one warning to give.
    if (nextWarns && nextLocks) onChange('warningsBeforeLock', Math.max(1, Number(values.warningsBeforeLock) || 0) || 1);
  };
  // With Lock on, the number decides: 0 is "lock with no warning".
  const setWarnings = (value) => {
    const count = Number(value) || 0;
    onChange('warningsBeforeLock', value);
    if (value !== '') onChange('violationAction', count > 0 ? 'warn_lock' : 'lock');
  };
  return (
    <div className="form-wide leave-settings" role="group" aria-labelledby={`${idPrefix}-violation-label`}>
      <p className="field-label" id={`${idPrefix}-violation-label`}>When a student leaves the test</p>
      <div className="leave-switch-pair pill-switches">
        <SwitchRow checked={warns} onChange={(on) => setMode(on, locks)} title="Warn"/>
        <SwitchRow checked={locks} onChange={(on) => setMode(warns, on)} title="Lock"/>
      </div>
      {/* Both switches off: nothing happens on screen, so there are no limits to set. */}
      {mode !== 'record' && <div className="leave-limits">
        <Stepper id={`${idPrefix}-exits`} label="Exits allowed" unit={exits === 0 ? 'no limit' : 'exits'} value={values.fullscreenExitLimit} min={0} max={20}
          onChange={(value) => onChange('fullscreenExitLimit', value)}/>
        <TimeStepper id={`${idPrefix}-away`} label="Total time away" seconds={values.fullscreenAbsenceLimitSeconds} secondStep={10}
          onChange={(value) => onChange('fullscreenAbsenceLimitSeconds', value)}/>
        {locks && (
          <Stepper id={`${idPrefix}-warnings`} label="Warnings before lock" unit={warnings === 0 ? 'lock at once' : 'warnings'} value={mode === 'warn_lock' ? values.warningsBeforeLock : 0} min={0} max={20}
            onChange={setWarnings}/>
        )}
      </div>}
      <p className="help">{leavingSummary(mode, exits, away, warnings)}{live ? ' Applies at once.' : ''}</p>
    </div>
  );
}

/**
 * A length of time, counted in seconds or minutes - the admin picks which in
 * the box itself. It is always stored in seconds.
 */
export function TimeStepper({ id, label, seconds, onChange, maxSeconds = 3600, secondStep = 15 }) {
  const raw = seconds === '' || seconds === undefined || seconds === null ? '' : Number(seconds) || 0;
  const [unit, setUnit] = useState(() => (raw >= 60 && raw % 60 === 0 ? 'min' : 'sec'));
  const perUnit = unit === 'min' ? 60 : 1;
  const switchUnit = (next) => {
    setUnit(next);
    // Minutes are whole: 90 s becomes 2 min, 15 s becomes 1 min.
    if (next === 'min' && raw > 0 && raw % 60) onChange(Math.min(maxSeconds, Math.max(60, Math.round(raw / 60) * 60)));
  };
  return (
    <Stepper
      id={id}
      label={label}
      value={raw === '' ? '' : unit === 'min' ? Math.round(raw / 60) : raw}
      min={0}
      max={Math.floor(maxSeconds / perUnit)}
      step={unit === 'min' ? 1 : secondStep}
      onChange={(value) => onChange(value === '' ? '' : value * perUnit)}
      unit={(
        <select className="stepper-unit-select" value={unit} onChange={(event) => switchUnit(event.target.value)} aria-label={`${label} in seconds or minutes`}>
          <option value="sec">sec</option>
          <option value="min">min</option>
        </select>
      )}
    />
  );
}

/** A checkbox drawn as a switch on a clickable row. */
/** An on/off setting. What it does is an (i) beside its title; tapping the (i) does not flip it. */
export function SwitchRow({ checked, onChange, title, description }) {
  return (
    <label className={`toggle-option switch-row${checked ? ' is-on' : ''}`}>
      <input type="checkbox" role="switch" checked={checked} onChange={(event) => onChange(event.target.checked)}/>
      <span className="switch" aria-hidden="true"/>
      <span className="switch-row-text">
        <strong>{title}</strong>
        {description && <InfoTip label={`About ${title.toLowerCase()}`}>{description}</InfoTip>}
      </span>
    </label>
  );
}
