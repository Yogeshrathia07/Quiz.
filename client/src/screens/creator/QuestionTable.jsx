import { useLayoutEffect, useRef } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { marksLabel, questionMarksFor } from '../../lib/quiz.js';
import { promptPreview } from '../../lib/text-format.js';
import { QuestionEditor } from './QuestionEditor.jsx';

const TYPE_TITLES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
/** On a narrow phone, as the test's overview names them: the row's details then fit one line. */
const TYPE_SHORT = { mcq: 'MCQ', msq: 'MSQ', short: 'Short answer' };

/**
 * The question bank as a list, one row a question: its number, its words, and
 * its type, options and marks. A row opens its editor under it (one at a
 * time). Folded editors stay in the page, so the form still checks every
 * question when the test is saved - CreatorScreen opens the one that needs it.
 */
export function QuestionTable({ questions, active = true, openIndex, onOpen, onChange, onRemove, onAdd, typeMarks }) {
  const list = useRef(null);
  useLayoutEffect(() => {
    if (!active || openIndex === null) return;
    const row = list.current?.children[openIndex];
    if (!row) return;
    // Measure after the previous editor has folded. Scrolling before that
    // layout change leaves the selected question displaced by its height.
    const form = row.closest('.creator-form');
    if (form && window.matchMedia('(min-width:701px)').matches) {
      form.scrollTo({ top: Math.max(0, form.scrollTop + row.getBoundingClientRect().top - form.getBoundingClientRect().top - 12), behavior: 'auto' });
    } else {
      const nav = document.querySelector('.creator-bar');
      const headerBottom = document.querySelector('.site-header')?.getBoundingClientRect().bottom ?? 0;
      // Use where the sticky strip will settle, not its current position
      // before scrolling. Its initial page inset otherwise adds an extra gap.
      const under = nav ? Math.max(headerBottom, parseFloat(getComputedStyle(nav).top) || 0) + nav.offsetHeight : headerBottom;
      window.scrollTo({ top: Math.max(0, window.scrollY + row.getBoundingClientRect().top - under - 12), behavior: 'auto' });
    }
  }, [active, openIndex]);
  return (
    <div className="question-table">
      <ol className="question-rows" ref={list}>
        {questions.map((question, index) => {
          const open = openIndex === index;
          const words = promptPreview(question.prompt);
          return (
            <li key={index} className={`question-row${open ? ' is-open' : ''}`} data-question-index={index}>
              <button type="button" className="question-row-head" aria-expanded={open} aria-controls={`question-editor-${index}`}
                onClick={() => onOpen(open ? null : index)}>
                <span className="question-row-number">{index + 1}</span>
                <span className={`question-row-words${words ? '' : ' is-empty'}`}>{words || 'Not written yet - tap to write it'}</span>
                <span className="question-row-meta">
                  <span className="question-chip">
                    <span className="question-chip-long">{TYPE_TITLES[question.type]}</span>
                    <span className="question-chip-short">{TYPE_SHORT[question.type]}</span>
                  </span>
                  {question.type !== 'short' && <span className="question-chip">{question.options.length} options</span>}
                  <span className="question-chip">{marksLabel(questionMarksFor(question, typeMarks))}</span>
                </span>
                <ChevronDown size={18} className="question-row-caret" aria-hidden="true"/>
              </button>
              <div id={`question-editor-${index}`} className="question-row-editor" hidden={!open}>
                <QuestionEditor question={question} index={index} canRemove={questions.length > 1} onChange={onChange} onRemove={onRemove}
                  typeMarks={typeMarks} onPapers={question.onPapers || 0}/>
              </div>
            </li>
          );
        })}
      </ol>
      <button type="button" className="button button-secondary question-add" onClick={onAdd}>
        <Plus size={16} aria-hidden="true"/>Add question
      </button>
    </div>
  );
}
