import { useEffect, useRef } from 'react';

/**
 * The paper as a row of numbered circles: filled once answered, ringed for
 * the one on screen. Any question can be opened at any time. The row keeps
 * the current question in view as the student moves through a long paper.
 */
export function QuestionPalette({ questions, currentIndex, onSelect }) {
  const row = useRef(null);

  useEffect(() => {
    const strip = row.current;
    const button = strip?.querySelector('[aria-current="true"]');
    if (!strip || !button) return;
    const left = button.offsetLeft - strip.clientWidth / 2 + button.clientWidth / 2;
    strip.scrollTo({ left, behavior: 'smooth' });
  }, [currentIndex]);

  return (
    <nav className="q-dots" aria-label="Questions" ref={row}>
      {questions.map((question) => {
        const current = question.index === currentIndex;
        const classes = ['q-dot', question.answered ? 'is-done' : '', question.locked ? 'is-final' : '', current ? 'is-current' : '']
          .filter(Boolean).join(' ');
        const state = question.locked ? 'final' : question.answered ? 'answered' : 'not answered';
        return (
          <button
            key={question.id}
            type="button"
            className={classes}
            aria-current={current ? 'true' : undefined}
            aria-label={`Question ${question.number}, ${state}`}
            onClick={() => onSelect(question.index)}
          >
            {question.number}
          </button>
        );
      })}
    </nav>
  );
}
