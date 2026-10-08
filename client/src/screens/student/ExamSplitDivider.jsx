import { useEffect, useRef, useState } from 'react';
import { clampExamSplit, DEFAULT_EXAM_SPLIT, examSplitAtPointer, examSplitLimits } from './exam-split.js';

function measureDivider(divider) {
  const screen = divider?.closest('.exam-screen');
  const question = screen?.querySelector('.q-ask');
  const answer = screen?.querySelector('.q-answer');
  if (!screen || !question || !answer || getComputedStyle(divider).display === 'none') return null;

  const left = question.getBoundingClientRect().left;
  const right = answer.getBoundingClientRect().right;
  const dividerWidth = divider.getBoundingClientRect().width;
  const availableWidth = Math.max(0, right - left - dividerWidth);
  return { left, dividerWidth, availableWidth, limits: examSplitLimits(availableWidth) };
}

/** Only visible while the paper has question and answer panes side by side. */
export function ExamSplitDivider({ value, onChange }) {
  const handle = useRef(null);
  const drag = useRef(null);
  const frame = useRef(null);
  const pendingValue = useRef(null);
  const [limits, setLimits] = useState({ min: 20, max: 80 });
  const [dragging, setDragging] = useState(false);

  useEffect(() => () => {
    if (frame.current !== null) window.cancelAnimationFrame(frame.current);
  }, []);

  // A long drag need not re-render the whole paper for every raw pointer event.
  const scheduleChange = (next) => {
    pendingValue.current = next;
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      onChange(pendingValue.current);
    });
  };

  useEffect(() => {
    const screen = handle.current?.closest('.exam-screen');
    if (!screen) return undefined;
    const update = () => {
      const measured = measureDivider(handle.current);
      // A rotation/window resize changes the pointer geometry mid-drag.
      // Discard a queued move from the old width before using the new bounds.
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
        frame.current = null;
      }
      if (!measured) { drag.current = null; setDragging(false); return; }
      if (drag.current) drag.current = { ...measured, pointerId: drag.current.pointerId };
      setLimits((previous) => previous.min === measured.limits.min && previous.max === measured.limits.max ? previous : measured.limits);
      onChange((current) => clampExamSplit(current, measured.limits));
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(screen);
    window.addEventListener('resize', update);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [onChange]);

  const startDrag = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (drag.current) return;
    const measured = measureDivider(event.currentTarget);
    if (!measured) return;
    drag.current = { ...measured, pointerId: event.pointerId };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    onChange(examSplitAtPointer(event.clientX, measured.left, measured.availableWidth, measured.dividerWidth, measured.limits));
    event.preventDefault();
  };
  const moveDrag = (event) => {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    const { left, availableWidth, dividerWidth, limits: dragLimits } = drag.current;
    scheduleChange(examSplitAtPointer(event.clientX, left, availableWidth, dividerWidth, dragLimits));
  };
  const endDrag = (event) => {
    if (!drag.current || event.pointerId !== drag.current.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
      onChange(pendingValue.current);
    }
  };
  const moveByKey = (event) => {
    const measured = measureDivider(event.currentTarget);
    if (!measured) return;
    const step = event.shiftKey ? 10 : 5;
    const next = event.key === 'ArrowLeft' ? value - step
      : event.key === 'ArrowRight' ? value + step
        : event.key === 'Home' ? measured.limits.min
          : event.key === 'End' ? measured.limits.max : null;
    if (next === null || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onChange(clampExamSplit(next, measured.limits));
  };
  const reset = () => {
    const measured = measureDivider(handle.current);
    if (measured) onChange(clampExamSplit(DEFAULT_EXAM_SPLIT, measured.limits));
  };

  return (
    <div
      ref={handle}
      className={`exam-splitter${dragging ? ' is-dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label="Resize question and answer panels"
      aria-orientation="vertical"
      aria-controls="exam-question-pane exam-answer-pane"
      aria-valuemin={Number(limits.min.toFixed(1))}
      aria-valuemax={Number(limits.max.toFixed(1))}
      aria-valuenow={Number(value.toFixed(1))}
      aria-valuetext={`${Math.round(value)}% question, ${Math.round(100 - value)}% answers`}
      title="Drag to resize · double-click to reset"
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={moveByKey}
      onDoubleClick={reset}
    >
      {/* One small bar to take hold of: shown, then faded until wanted (theme.css). */}
      <span className="exam-splitter-handle" aria-hidden="true"/>
    </div>
  );
}
