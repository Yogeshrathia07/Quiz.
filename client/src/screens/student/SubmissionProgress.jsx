import { useEffect, useRef } from 'react';
import { CloudUpload, LoaderCircle, TriangleAlert } from 'lucide-react';

const COPY = {
  preparing: ['Preparing your submission…', 'Please keep this page open. We are getting your paper ready to submit.'],
  saving: ['Saving your answers…', 'Please keep this page open. Your test will submit as soon as your answers are saved.'],
  waiting: ['Waiting to save your answers…', 'Your answers are kept on this device. We will submit automatically when they reach the server.'],
  sending: ['Submitting your test…', 'Please keep this page open while we confirm your submission.'],
  retrying: ['Waiting for submission…', 'The connection is taking longer. We are trying again automatically. Keep this page open.']
};

/** In-page, so opening the progress window never exits the test's fullscreen. */
export function SubmissionProgress({ phase = 'sending', problem = null, unsent = 0, automatic = false, onCancel, onRetry, onContinue }) {
  const box = useRef(null);
  const [title, message] = problem ? [problem.uncertain ? 'Submission not confirmed' : 'Could not submit yet', problem.message] : COPY[phase] || COPY.sending;
  useEffect(() => {
    const previous = document.activeElement;
    // Also contain focus moved by a browser shortcut or a parent toolbar,
    // not just ordinary Tab presses inside the card.
    const keepFocus = (event) => {
      if (!box.current?.contains(event.target)) box.current?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', keepFocus);
    box.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('focusin', keepFocus);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const trapFocus = (event) => {
    if (event.key !== 'Tab') return;
    const controls = [...box.current.querySelectorAll('button:not(:disabled)')];
    const first = controls[0];
    const last = controls.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === box.current)) {
      event.preventDefault(); first.focus();
    }
  };
  return (
    <div className="submission-progress" role="dialog" aria-modal="true" aria-labelledby="submission-progress-title" aria-describedby="submission-progress-detail">
      <div className={`submission-progress-card${problem ? ' has-problem' : ''}`} ref={box} tabIndex={-1} onKeyDown={trapFocus}>
        <span className="submission-progress-icon" aria-hidden="true">
          {problem ? <TriangleAlert size={26}/> : <><CloudUpload size={26}/><LoaderCircle className="submission-progress-spinner" size={18}/></>}
        </span>
        <div className="submission-progress-copy" role={problem ? 'alert' : 'status'} aria-live="polite" aria-atomic="true">
          {automatic && <span className="submission-progress-context">Time’s up · auto-submit</span>}
          <h2 id="submission-progress-title">{title}</h2>
          <p id="submission-progress-detail">{message}</p>
          {!problem && unsent > 0 && <p className="submission-progress-count">{unsent} answer{unsent === 1 ? '' : 's'} left to save</p>}
        </div>
        {(onCancel || onRetry || onContinue) && <div className="submission-progress-actions">
          {onCancel && <button className="button button-secondary" type="button" onClick={onCancel}>Keep working</button>}
          {onContinue && <button className="button button-secondary" type="button" onClick={onContinue}>Back to test</button>}
          {onRetry && <button className="button button-primary" type="button" onClick={onRetry}>Try again</button>}
        </div>}
      </div>
    </div>
  );
}
