import { DEFAULT_TYPE_MARKS, QUESTION_TYPES } from '../lib/quiz.js';
import { InfoTip } from './InfoTip.jsx';
import { Stepper } from './FormControls.jsx';

const TYPE_NAMES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };

/**
 * What each question type is worth on this test. A question can be worth
 * something else - set in the editor below - and one that is shows a small
 * sign in its heading. Changing a type's marks here moves every question of
 * that type that had not been given its own (see followTypeDefault).
 */
export function QuestionMarksFields({ values, onChange, idPrefix }) {
  const typeMarks = { ...DEFAULT_TYPE_MARKS, ...(values.typeMarks || {}) };
  return (
    <div className="form-wide">
      <span className="field-label-row">
        <span className="field-label">Marks for each question</span>
        <InfoTip label="About marks">
          What a right answer earns. A choice question earns all of its marks or none; a short answer can be given part of
          them when you mark it. A single question can be worth something else - set it in its editor below.
        </InfoTip>
      </span>
      <div className="compact-numbers">
        {QUESTION_TYPES.map((type) => (
          <Stepper
            key={type}
            id={`${idPrefix}-marks-${type}`}
            label={TYPE_NAMES[type]}
            value={typeMarks[type]}
            min={1}
            max={100}
            unit="marks"
            onChange={(value) => onChange('typeMarks', { ...typeMarks, [type]: value })}
          />
        ))}
      </div>
    </div>
  );
}
