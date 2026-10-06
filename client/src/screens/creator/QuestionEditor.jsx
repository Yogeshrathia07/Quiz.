import { useRef, useState } from 'react';
import { Clock, ImagePlus, Star } from 'lucide-react';
import { ChoiceCards } from '../../components/FormControls.jsx';
import { PromptField } from './PromptField.jsx';
import { QUESTION_TYPES, marksLabel, questionMarksFor, questionSecondsFor, secondsLabel } from '../../lib/quiz.js';
import { uploadFile } from '../../lib/api.js';
import { compressImage, sizeLabel } from '../../lib/image-compress.js';
import { QuestionImage } from '../../components/QuestionImage.jsx';

const TYPE_TITLES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
const TYPE_ABOUT = {
  mcq: 'One correct option; marked automatically.',
  msq: 'One or more correct options; right only when exactly those are picked. Marked automatically.',
  short: 'Students write their answer; you mark it yourself.'
};
const TIME_CHOICES = [0, 15, 20, 30, 45, 60, 90, 120, 180, 300];
const MARK_CHOICES = [0.5, 1, 2, 3, 4, 5, 10];
const hasOwn = (value) => value !== undefined && value !== null && value !== '';

/**
 * Strict timing: this question's own time. "Default" follows the test's time
 * for its type, so changing that default later still reaches this question -
 * and so does picking the default's own value: that is following it too.
 */
function QuestionTime({ question, typeSeconds, onChange }) {
  const own = question.timeSeconds;
  const fallback = questionSecondsFor({ type: question.type }, typeSeconds);
  const [custom, setCustom] = useState(hasOwn(own) && !TIME_CHOICES.includes(Number(own)));
  const choice = !hasOwn(own) ? 'default' : custom ? 'custom' : String(own);
  const pick = (value) => {
    if (value === 'default') { setCustom(false); onChange(null); }
    else if (value === 'custom') { setCustom(true); onChange(hasOwn(own) ? Number(own) : 60); }
    else { setCustom(false); onChange(Number(value) === fallback ? null : Number(value)); }
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

/**
 * What this question is worth. "Default" follows the test's marks for its
 * type, so changing that default later still reaches this question - and so
 * does picking the default's own value.
 */
function QuestionMarks({ question, typeMarks, onChange }) {
  const own = question.marks;
  const fallback = questionMarksFor({ type: question.type }, typeMarks);
  const [custom, setCustom] = useState(hasOwn(own) && !MARK_CHOICES.includes(Number(own)));
  const choice = !hasOwn(own) ? 'default' : custom ? 'custom' : String(Number(own));
  const pick = (value) => {
    if (value === 'default') { setCustom(false); onChange(null); }
    else if (value === 'custom') { setCustom(true); onChange(hasOwn(own) ? Number(own) : fallback); }
    else { setCustom(false); onChange(Number(value) === fallback ? null : Number(value)); }
  };
  return (
    <div className="question-time">
      <label className="field-label">Marks for this question</label>
      <div className="question-time-row">
        <select className="select" value={choice} onChange={(event) => pick(event.target.value)}>
          <option value="default">Default for {TYPE_TITLES[question.type]} ({marksLabel(fallback)})</option>
          {MARK_CHOICES.map((marks) => <option key={marks} value={String(marks)}>{marksLabel(marks)}</option>)}
          <option value="custom">Custom…</option>
        </select>
        {choice === 'custom' && (
          <label className="question-time-custom">
            <input className="text-input" type="number" min="0.01" max="100" step="any" value={own ?? ''}
              onChange={(event) => onChange(event.target.value === '' ? '' : Math.min(100, Math.max(0, Number(event.target.value))))}/>
            <span>marks</span>
          </label>
        )}
      </div>
    </div>
  );
}

/**
 * A picture for the question - added here, by hand: a JSON import carries
 * text only. Shrunk on this device before it is sent (lib/image-compress.js),
 * so it loads quickly on a student's phone; students tap it to see it big.
 */
function QuestionPicture({ image, onChange }) {
  const input = useRef(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const choose = async (file) => {
    if (!file) return;
    setProblem('');
    setBusy('Shrinking the picture…');
    try {
      const { blob, width, height } = await compressImage(file);
      setBusy('Uploading…');
      const { image: saved } = await uploadFile(`/api/admin/question-images?width=${width}&height=${height}`, blob);
      onChange(saved);
    } catch (error) { setProblem(error.message); }
    setBusy('');
    if (input.current) input.current.value = '';
  };
  return (
    <div className="question-picture">
      <span className="field-label">Picture <span className="field-optional">optional</span></span>
      {image ? (
        <div className="question-picture-row">
          <QuestionImage image={image} label="Picture for this question" compact/>
          <div className="question-picture-side">
            <small>{image.width} × {image.height}{image.bytes ? ` · ${sizeLabel(image.bytes)}` : ''}</small>
            <div className="question-picture-actions">
              <button className="button button-secondary button-small" type="button" disabled={Boolean(busy)} onClick={() => input.current?.click()}>{busy || 'Replace'}</button>
              <button className="button button-danger button-small" type="button" disabled={Boolean(busy)} onClick={() => onChange(null)}>Remove</button>
            </div>
          </div>
        </div>
      ) : (
        <button className="button button-secondary question-picture-add" type="button" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
          <ImagePlus size={17} aria-hidden="true"/>{busy || 'Add a picture'}
        </button>
      )}
      {problem && <p className="help is-bad" role="alert">{problem}</p>}
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden onChange={(event) => choose(event.target.files?.[0])}/>
    </div>
  );
}

export function QuestionEditor({ question, index, canRemove, onChange, onRemove, strict = false, typeSeconds, typeMarks, onPapers = 0 }) {
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
          {/* Set apart from its type's default: a small sign, so it is seen without opening anything. */}
          {hasOwn(question.marks) && (
            <span className="pill own-value" title={`Its own marks - the default for ${TYPE_TITLES[question.type]} is ${marksLabel(questionMarksFor({ type: question.type }, typeMarks))}`}>
              <Star size={12} aria-hidden="true"/>{marksLabel(question.marks)}
            </span>
          )}
          {strict && hasOwn(question.timeSeconds) && (
            <span className="pill own-value" title={`Its own time - the default for ${TYPE_TITLES[question.type]} is ${secondsLabel(questionSecondsFor({ type: question.type }, typeSeconds))}`}>
              <Clock size={12} aria-hidden="true"/>{secondsLabel(question.timeSeconds)}
            </span>
          )}
        </strong>
        {canRemove && (
          <button className="button button-danger button-small" type="button" onClick={() => onRemove(index)}>
            Remove question
          </button>
        )}
      </div>

      <PromptField value={question.prompt} onChange={(prompt) => update({ prompt })}/>
      <QuestionPicture image={question.image || null} onChange={(image) => update({ image })}/>

      <ChoiceCards
        label="Answer type"
        idPrefix={`question-${index}-type`}
        value={question.type}
        onChange={changeType}
        options={QUESTION_TYPES.map((type) => ({ value: type, title: TYPE_TITLES[type], description: TYPE_ABOUT[type] }))}
      />

      <div className="question-settings">
        <QuestionMarks question={question} typeMarks={typeMarks} onChange={(marks) => update({ marks })}/>
        {strict && <QuestionTime question={question} typeSeconds={typeSeconds} onChange={(timeSeconds) => update({ timeSeconds })}/>}
      </div>

      {question.type === 'short' ? null : (
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
