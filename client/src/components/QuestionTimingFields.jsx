import { QUESTION_TYPES } from '../lib/quiz.js';
import { durationLabel } from '../lib/format.js';
import { SwitchRow, TimeStepper } from './FormControls.jsx';

const TYPE_NAMES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };

/**
 * Strict timing for the whole test: the switch, and the default time for
 * each question type. Single questions can set their own time in the editor.
 */
export function QuestionTimingFields({ values, onChange, idPrefix, perQuestionNote, estimatedSeconds, locked = false }) {
  const typeSeconds = values.typeSeconds || {};
  // Once a test has started, whether it has per-question timers is fixed.
  if (locked && !values.strictTiming) return null;
  return (
    <div className="form-wide strict-fields">
      {locked ? <p className="field-label">Timer on every question</p> : <SwitchRow
        checked={values.strictTiming}
        onChange={(value) => onChange('strictTiming', value)}
        title="Timer on every question"
        description="One question at a time, no going back."
      />}
      {values.strictTiming && (
        <>
          <div className="compact-numbers">
            {QUESTION_TYPES.map((type) => (
              <TimeStepper
                key={type}
                id={`${idPrefix}-time-${type}`}
                label={TYPE_NAMES[type]}
                seconds={typeSeconds[type] ?? ''}
                onChange={(value) => onChange('typeSeconds', { ...typeSeconds, [type]: value })}
              />
            ))}
          </div>
          <div className="pill-switches">
            <SwitchRow checked={values.strictNext !== false} onChange={(value) => onChange('strictNext', value)} title="Next button"/>
          </div>
          <p className="help">
            {estimatedSeconds > 0 && <>Each paper takes up to <strong>{durationLabel(estimatedSeconds)}</strong>. </>}
            {values.strictNext === false ? 'Each question stays for its full time. ' : 'Students may move on early. '}
            0 = no timer. {perQuestionNote || 'A question can have its own time in the editor below.'}
          </p>
        </>
      )}
    </div>
  );
}
