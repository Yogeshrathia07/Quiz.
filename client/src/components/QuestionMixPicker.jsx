import { QUESTION_TYPES, availableOfType } from '../lib/quiz.js';
import { numberInRange } from '../lib/format.js';
import { Stepper } from './FormControls.jsx';

const TYPE_NAMES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };

/**
 * "Questions per student": how many of each type to draw from the bank for one
 * student's paper. Shared by the create form and the admin's edit-setup modal so
 * both offer exactly the same control.
 */
export function QuestionMixPicker({ pool, mix, onChange, disabled = false, idPrefix = 'mix' }) {
  const setType = (type, value) => onChange({
    ...mix,
    [type]: numberInRange(value, 0, availableOfType(pool, type), 0)
  });

  return (
    <div className={`pool-picker compact-numbers${disabled ? ' is-empty' : ''}`}>
      {QUESTION_TYPES.map((type) => {
        const available = availableOfType(pool, type);
        return (
          <div key={type} className="pool-type">
            <Stepper
              id={`${idPrefix}-${type}`}
              label={TYPE_NAMES[type]}
              value={mix[type] ?? 0}
              min={0}
              max={available}
              disabled={disabled || available === 0}
              // "of 4": how many of this type the bank holds.
              unit={available === 0 ? 'none' : `of ${available}`}
              onChange={(value) => setType(type, value)}
            />
          </div>
        );
      })}
    </div>
  );
}
