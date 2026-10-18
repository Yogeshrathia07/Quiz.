import { useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Check, RotateCw, SlidersHorizontal, X } from 'lucide-react';
import { api } from '../../../lib/api.js';
import { useAutoHideScrollbar } from '../../../lib/useAutoHideScrollbar.js';
import { Modal } from '../../../components/Modal.jsx';
import { RichText } from '../../../components/RichText.jsx';
import { questionStatisticsOf } from '../question-statistics.js';

const percentText = (value) => value === null ? '—' : `${value}%`;
const TYPES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
const optionLetter = (index) => (index < 26 ? '' : String.fromCharCode(64 + Math.floor(index / 26))) + String.fromCharCode(65 + index % 26);

/** One question's outcomes and option selections, for the current filters. */
export function QuestionStatisticsModal({ code, question, studentIds, revision, onClose, onRank, onFilterOption, onFilterOutcome }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const heading = useRef(null);
  const scrollActivity = useAutoHideScrollbar();
  useEffect(() => {
    let alive = true;
    setData(null);
    setError('');
    api(`/api/admin/tests/${encodeURIComponent(code)}/questions/${encodeURIComponent(question.id)}/statistics`)
      .then((reply) => {
        if (!reply?.question || !Array.isArray(reply.question.options) || !Array.isArray(reply.responses)) throw new Error('Question statistics are not available. Please try again.');
        if (alive) setData(reply);
      }).catch((problem) => { if (alive) setError(problem.message); });
    return () => { alive = false; };
  }, [code, question.id, revision, attempt]);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = heading.current?.closest('[role="dialog"]');
    dialog?.querySelector('.modal-close')?.focus({ preventScroll: true });
    const onKey = (event) => {
      if (event.key !== 'Tab' || !dialog) return;
      const controls = [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
        .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
      const first = controls[0]; const last = controls.at(-1);
      if ((event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first)?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const shown = data?.question || question;
  const stats = useMemo(() => data ? questionStatisticsOf(data.question, data.responses, studentIds) : null, [data, studentIds]);
  const otherOutcomes = stats?.outcomes.filter((outcome) => !['O', 'W'].includes(outcome.id) && outcome.count > 0) || [];
  return (
    <Modal label={`Question ${question.number} statistics`} onClose={onClose} className="question-stats-sheet">
      <header className="question-stats-head" ref={heading}>
        <h1>Q{question.number} · Results</h1>
        <p>{stats ? `${stats.total} student${stats.total === 1 ? '' : 's'} · ` : ''}{TYPES[shown.type]}</p>
      </header>
      {stats && <section className="question-stats-summary" aria-label="Student results">
        <dl className="question-stats-outcomes">
          {stats.outcomes.filter((outcome) => ['O', 'W'].includes(outcome.id)).map((outcome) => (
            <div key={outcome.id} className={`question-stats-outcome is-${outcome.tone}`}>
              <dt>{outcome.id === 'O' ? <Check size={16} aria-hidden="true"/> : <X size={16} aria-hidden="true"/>}{outcome.label}</dt>
              <dd><strong>{outcome.count}</strong><span className="sr-only"> students, </span><span>{percentText(outcome.percent)}</span></dd>
              {onFilterOutcome && <button className="question-stats-outcome-filter" type="button" disabled={!outcome.count}
                aria-label={`Filter students with ${outcome.id === 'O' ? 'a correct' : 'an incorrect'} answer`} title={`Filter ${outcome.label.toLowerCase()} answers`}
                onClick={() => onFilterOutcome(outcome.id)}><SlidersHorizontal size={15} aria-hidden="true"/></button>}
            </div>
          ))}
        </dl>
        {otherOutcomes.length > 0 && <dl className="question-stats-other-outcomes">
          {otherOutcomes.map((outcome) => <div key={outcome.id}>
            <dt>{outcome.label}</dt><dd>{outcome.count} <span>({percentText(outcome.percent)})</span></dd>
          </div>)}
        </dl>}
      </section>}
      <div className="question-stats-body auto-hide-scrollbar" role="region" aria-label="Question statistics" tabIndex={0} {...scrollActivity}>
        <RichText className="question-stats-prompt" text={shown.prompt || 'Picture question'}/>
        {shown.image && <img className="question-stats-image" src={shown.image.url} alt="Picture for this question" width={shown.image.width} height={shown.image.height}/>}
        {error && <div className="question-stats-error" role="alert"><p>{error}</p>
          <button className="button button-secondary button-small" type="button" onClick={() => setAttempt((value) => value + 1)}><RotateCw size={15} aria-hidden="true"/>Try again</button>
        </div>}
        {!stats ? !error && <p className="help" role="status">Loading responses…</p> : <>
          {!stats.total && <p className="notice">No submitted responses in the current filters.</p>}
          {shown.type !== 'short' && <section className="question-stats-options" aria-labelledby="question-stats-options-title">
            <div className="question-stats-options-head">
              <h2 id="question-stats-options-title">Options</h2>
              <span className="question-stats-key"><Check size={14} aria-hidden="true"/>Correct option</span>
            </div>
            <ol role="list">
              {stats.options.map((option) => (
                <li key={option.index} role="listitem" className={`question-stats-option${option.correct ? ' is-correct' : ''}${onFilterOption ? ' has-filter' : ''}`}>
                  <span className="question-stats-letter" aria-hidden="true">{optionLetter(option.index)}{option.correct && <Check size={12}/>}</span>
                  <div className="question-stats-option-text"><RichText text={option.text}/>{option.correct && <span className="sr-only">Correct option</span>}</div>
                  <span className="question-stats-option-count"><span><strong>{option.count}</strong> selected</span><span className="sr-only">, </span><span>{percentText(option.percent)}</span></span>
                  {onFilterOption && <button className="question-stats-option-filter" type="button" disabled={!option.count}
                    aria-label={`Filter students who selected option ${optionLetter(option.index)}`} title="Filter by this option"
                    onClick={() => onFilterOption(option.index)}><SlidersHorizontal size={15} aria-hidden="true"/></button>}
                  <span className="question-stats-track" aria-hidden="true"><span style={{ width: `${option.percent || 0}%` }}/></span>
                </li>
              ))}
            </ol>
          </section>}
        </>}
      </div>
      <footer className="question-stats-foot">
        <button className="button button-secondary" type="button" onClick={onClose}>Close</button>
        <button className="button button-primary" type="button" onClick={onRank}><BarChart3 size={16} aria-hidden="true"/>View ranking</button>
      </footer>
    </Modal>
  );
}
