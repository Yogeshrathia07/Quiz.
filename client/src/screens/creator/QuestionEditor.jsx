import { useState } from 'react';
import { ChoiceCards } from '../../components/FormControls.jsx';
import { PromptField } from './PromptField.jsx';
import { QUESTION_TYPES, questionSecondsFor, secondsLabel } from '../../lib/quiz.js';

const TYPE_TITLES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
const TIME_CHOICES = [0, 15, 20, 30, 45, 60, 90, 120, 180, 300];

/**
 * Strict timing: this question's own time. "Default" follows the test's time
 * for its type, so changing that default later still reaches this question.
 */
function QuestionTime({ question, typeSeconds, onChange }) {
  const own = question.timeSeconds;
  const hasOwn = own !== undefined && own !== null && own !== '';
  const [custom, setCustom] = useState(hasOwn && !TIME_CHOICES.includes(Number(own)));
  const choice = !hasOwn ? 'default' : custom ? 'custom' : String(own);
  const pick = (value) => {
    if (value === 'default') { setCustom(false); onChange(null); }
    else if (value === 'custom') { setCustom(true); onChange(hasOwn ? Number(own) : 60); }
    else { setCustom(false); onChange(Number(value)); }
  };
  return (
    <div className="question-time">
      <label className="field-label">Time for this question</label>
      <div className="question-time-row">
        <select className="select" value={choice} onChange={(event) => pick(event.target.value)}>
          <option value="default">Default for {TYPE_TITLES[question.type]} ({secondsLabel(questionSecondsFor({ type: question.type }, typeSeconds))})</option>
          {TIME_CHOICES.map((seconds) => <option key={seconds} value={String(seconds)}>{secondsLabel(seconds)}</option>)}
          <option value="custom">Custom…</option>
        </select>
        {choice === 'custom' && (
          <label className="question-time-custom">
            <input className="text-input" type="number" min="1" max="3600" value={own ?? ''} onChange={(event) => onChange(event.target.value === '' ? '' : Math.min(3600, Math.max(0, Number(event.target.value))))}/>
            <span>seconds</span>
          </label>
        )}
      </div>
    </div>
  );
}

export function QuestionEditor({ question, index, canRemove, onChange, onRemove, strict = false, typeSeconds, onPapers = 0 }) {
  const update = (patch) => onChange(index, { ...question, ...patch });

  const changeType = (type) => update(type === 'short'
    ? { type, options: [], correctOptions: [] }
    : {
      type,
      options: question.options.length >= 2 ? question.options : ['', '', '', ''],
      correctOptions: question.correctOptions.length ? question.correctOptions : ['0']
    });

  const toggleCorrect = (optionIndex) => {
    const value = String(optionIndex);
    if (question.type === 'mcq') return update({ correctOptions: [value] });
    const choices = question.correctOptions.includes(value)
      ? question.correctOptions.filter((item) => item !== value)
      : [...question.correctOptions, value];
    return update({ correctOptions: choices });
  };

  return (
    <article className="question-editor card">
      <div className="question-editor-head">
        <strong>
          Question {index + 1}
          {onPapers > 0 && <span className="pill warn on-papers" title="Students already have this question on their paper">On {onPapers} paper{onPapers === 1 ? '' : 's'}</span>}
        </strong>
        {canRemove && (
          <button className="button button-danger button-small" type="button" onClick={() => onRemove(index)}>
            Remove question
          </button>
        )}
      </div>

      <PromptField value={question.prompt} onChange={(prompt) => update({ prompt })}/>

      <ChoiceCards
        label="Answer type"
        idPrefix={`question-${index}-type`}
        value={question.type}
        onChange={changeType}
        options={QUESTION_TYPES.map((type) => ({ value: type, title: TYPE_TITLES[type] }))}
      />

      {strict && <QuestionTime question={question} typeSeconds={typeSeconds} onChange={(timeSeconds) => update({ timeSeconds })}/>}

      {question.type === 'short' ? (
        <p className="help">Students write their answer; you mark it yourself.</p>
      ) : (
        <div className="option-editor">
          {question.options.map((option, optionIndex) => (
            <label key={optionIndex} className="option-edit-row">
              <input
                type={question.type === 'mcq' ? 'radio' : 'checkbox'}
                name={`correct-${index}`}
                checked={question.correctOptions.includes(String(optionIndex))}
                onChange={() => toggleCorrect(optionIndex)}
              />
              <input
                className="text-input"
                required
                placeholder={`Option ${optionIndex + 1}`}
                value={option}
                onChange={(event) => update({
                  options: question.options.map((item, itemIndex) => (itemIndex === optionIndex ? event.target.value : item))
                })}
              />
            </label>
          ))}
        </div>
      )}
    </article>
  );
}
