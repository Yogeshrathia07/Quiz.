import { useRef, useState } from 'react';
import { ImagePlus, Plus, Star, X } from 'lucide-react';
import { ChoiceCards } from '../../components/FormControls.jsx';
import { PromptField } from './PromptField.jsx';
import {
  MAX_OPTIONS, MIN_OPTIONS, QUESTION_TYPES, marksLabel, questionMarksFor, withOptionAdded, withOptionRemoved
} from '../../lib/quiz.js';
import { uploadFile } from '../../lib/api.js';
import { compressImage, sizeLabel } from '../../lib/image-compress.js';
import { QuestionImage } from '../../components/QuestionImage.jsx';

const TYPE_TITLES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
const TYPE_ABOUT = {
  mcq: 'One correct option; marked automatically.',
  msq: 'One or more correct options; right only when exactly those are picked. Marked automatically.',
  short: 'Students write their answer; you mark it yourself.'
};
const MARK_CHOICES = [0.5, 1, 2, 3, 4, 5, 10];
const hasOwn = (value) => value !== undefined && value !== null && value !== '';

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
        <select className="select" name="question-marks" aria-label="Marks for this question" value={choice} onChange={(event) => pick(event.target.value)}>
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

/**
 * A choice question's options: 2 to 10, each with its tick for "correct" and
 * a ✕ to take it away, and Add option under them. With none ticked, the form
 * is not sent - the browser points at the ticks and says why.
 */
function OptionsEditor({ question, index, onToggleCorrect, update }) {
  const single = question.type === 'mcq';
  const count = question.options.length;
  const noneCorrect = !question.correctOptions.length;
  return (
    <div className="option-editor" role="group" aria-labelledby={`question-${index}-options-label`}>
      <div className="option-editor-head">
        <span className="field-label" id={`question-${index}-options-label`}>Options</span>
        <span className="option-count">{count} of {MAX_OPTIONS}</span>
      </div>
      <p className={`help${noneCorrect ? ' is-warning' : ''}`}>
        {noneCorrect ? 'Tick the correct answer before you save.' : single ? 'Tick the one correct answer.' : 'Tick every correct answer.'}
      </p>
      {question.options.map((option, optionIndex) => (
        <div key={optionIndex} className="option-edit-row">
          <input
            type={single ? 'radio' : 'checkbox'}
            name={`correct-${index}`}
            aria-label={`Option ${optionIndex + 1} is correct`}
            checked={question.correctOptions.includes(String(optionIndex))}
            onChange={() => onToggleCorrect(optionIndex)}
            // A single answer: the browser's own "choose one". Several: the first tick says it for the group -
            // and clears it again for a single answer, as the same box may have been a tick before.
            required={single}
            ref={optionIndex > 0 ? undefined : (input) => input?.setCustomValidity(!single && noneCorrect ? 'Tick at least one correct answer.' : '')}
          />
          <input
            className="text-input"
            required
            aria-label={`Option ${optionIndex + 1}`}
            placeholder={`Option ${optionIndex + 1}`}
            value={option}
            onChange={(event) => update({
              options: question.options.map((item, itemIndex) => (itemIndex === optionIndex ? event.target.value : item))
            })}
          />
          <button type="button" className="option-remove" disabled={count <= MIN_OPTIONS} onClick={() => update(withOptionRemoved(question, optionIndex))}
            aria-label={`Remove option ${optionIndex + 1}`} title={count <= MIN_OPTIONS ? `A question needs at least ${MIN_OPTIONS} options` : 'Remove this option'}>
            <X size={16} aria-hidden="true"/>
          </button>
        </div>
      ))}
      <button type="button" className="button button-secondary button-small option-add" disabled={count >= MAX_OPTIONS} onClick={() => update(withOptionAdded(question))}>
        <Plus size={15} aria-hidden="true"/>{count >= MAX_OPTIONS ? `${MAX_OPTIONS} options at most` : 'Add option'}
      </button>
    </div>
  );
}

/**
 * One question, opened from its row in the question list (QuestionTable): its
 * words, picture, answer type, marks and options - 2 to 10 of them, the
 * correct ones ticked. Its time is the test's - set in Question settings,
 * never per question.
 */
export function QuestionEditor({ question, index, canRemove, onChange, onRemove, typeMarks, onPapers = 0 }) {
  const update = (patch) => onChange(index, { ...question, ...patch });

  const changeType = (type) => update(type === 'short'
    ? { type, options: [], correctOptions: [] }
    : {
      type,
      options: question.options.length >= MIN_OPTIONS ? question.options : ['', '', '', ''],
      // One correct answer for a single choice: the first of those ticked.
      correctOptions: question.correctOptions.length ? (type === 'mcq' ? question.correctOptions.slice(0, 1) : question.correctOptions) : ['0']
    });

  const toggleCorrect = (optionIndex) => {
    const value = String(optionIndex);
    if (question.type === 'mcq') return update({ correctOptions: [value] });
    const choices = question.correctOptions.includes(value)
      ? question.correctOptions.filter((item) => item !== value)
      : [...question.correctOptions, value];
    return update({ correctOptions: choices });
  };

  // Its own marks or a place on papers: a small sign each, seen without reading the whole editor.
  const signs = (onPapers > 0 || hasOwn(question.marks)) && (
    <span className="question-editor-signs">
      {onPapers > 0 && <span className="pill warn on-papers" title="Students already have this question on their paper">On {onPapers} paper{onPapers === 1 ? '' : 's'}</span>}
      {hasOwn(question.marks) && (
        <span className="pill own-value" title={`Its own marks - the default for ${TYPE_TITLES[question.type]} is ${marksLabel(questionMarksFor({ type: question.type }, typeMarks))}`}>
          <Star size={12} aria-hidden="true"/>{marksLabel(question.marks)}
        </span>
      )}
    </span>
  );
  return (
    <article className="question-editor">
      {signs}
      <PromptField value={question.prompt} onChange={(prompt) => update({ prompt })}/>
      <QuestionPicture image={question.image || null} onChange={(image) => update({ image })}/>

      <ChoiceCards
        label="Answer type"
        idPrefix={`question-${index}-type`}
        value={question.type}
        onChange={changeType}
        options={QUESTION_TYPES.map((type) => ({ value: type, title: TYPE_TITLES[type], description: TYPE_ABOUT[type] }))}
        hint
      />

      <div className="question-settings">
        <QuestionMarks question={question} typeMarks={typeMarks} onChange={(marks) => update({ marks })}/>
      </div>

      {question.type === 'short' ? null : (
        <OptionsEditor question={question} index={index} onToggleCorrect={toggleCorrect} update={update}/>
      )}
      {canRemove && (
        <div className="question-editor-foot">
          <button className="button button-danger button-small" type="button" onClick={() => onRemove(index)}>Remove question</button>
        </div>
      )}
    </article>
  );
}
