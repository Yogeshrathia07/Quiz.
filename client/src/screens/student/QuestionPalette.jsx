import { useEffect, useRef } from 'react';

/**
 * Keep the active number in the middle of the strip, whichever way it scrolls:
 * along a single row (phone), down the desktop rail, or down a few wrapped rows (tablet).
 */
export function centerCurrentQuestion(strip) {
  const button = strip?.querySelector('.q-dot.is-current');
  if (!strip || !button) return;
  const box = strip.getBoundingClientRect();
  const at = button.getBoundingClientRect();
  strip.scrollTo({
    top: strip.scrollTop + at.top - box.top - (strip.clientHeight - at.height) / 2,
    left: strip.scrollLeft + at.left - box.left - (strip.clientWidth - at.width) / 2,
    behavior: 'smooth'
  });
}

/** The paper's numbered strip (a vertical rail on desktop). */
export function QuestionPalette({ questions, currentIndex, onSelect }) {
  const row = useRef(null);

  useEffect(() => {
    centerCurrentQuestion(row.current);
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
