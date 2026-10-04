import { QUESTION_TYPES, secondsLabel } from '../lib/quiz.js';
import { durationLabel } from '../lib/format.js';
import { SwitchRow, TimeStepper } from './FormControls.jsx';

const TYPE_NAMES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };

/** What the times add up to: `timers` is whether all, some or none of the questions a paper can draw have one. */
function timesNote(timers, seconds, strictNext) {
  if (timers === 'none') return 'Every time is 0, so no question has a timer: students move on with Next whenever they are ready. ';
  const length = seconds > 0 ? durationLabel(seconds) : '';
  return [
    length && (timers === 'all' ? `Each paper takes up to ${length}.` : `Each paper takes about ${length} - a question with no timer counted at its usual time.`),
    strictNext === false ? (timers === 'all' ? 'Each question stays for its full time.' : 'A timed question stays for its full time; one with no timer has Next.') : ''
  ].filter(Boolean).join(' ') + ' ';
}

/**
 * How a one-at-a-time paper moves: a Previous button (free movement), or one
 * way only - strict timing (domain/strict-timing.js). One way, the questions
 * may have timers: a time for each type (0 = none; single questions can set
 * their own in the editor), and a Next button the test may take away. With no
 * timers students simply move on with Next. Once the test has started these
 * are fixed, so they are shown, not offered.
 */
export function QuestionTimingFields({ values, onChange, idPrefix, perQuestionNote, estimatedSeconds, timers = 'all', locked = false }) {
  const typeSeconds = values.typeSeconds || {};
  const timed = values.strictTiming && values.questionTimers !== false;
  if (locked) {
    if (!values.strictTiming) return null;
    return (
      <div className="form-wide strict-fields">
        <span className="field-label">One way only: no Previous button</span>
        <p className="help">
          {timed
            ? `Next button ${values.strictNext === false ? 'off' : 'on'} · ${QUESTION_TYPES.map((type) => `${TYPE_NAMES[type]} ${secondsLabel(typeSeconds[type]).toLowerCase()}`).join(' · ')}.`
            : 'No timer on any question: students move on with Next.'}
          {' '}Fixed once the test started.
        </p>
      </div>
    );
  }
  return (
    <div className="form-wide strict-fields">
      <div className="pill-switches">
        <SwitchRow
          checked={!values.strictTiming}
          onChange={(value) => onChange('strictTiming', !value)}
          title="Previous button"
          description="On: students move back and forth freely. Off: one way only - no going back."
        />
        {values.strictTiming && (
          <SwitchRow
            checked={timed}
            onChange={(value) => onChange('questionTimers', value)}
            title="Timer on each question"
            description="Off: students move on with Next whenever they are ready - the test's own end time is the only limit. On: each question gets a time; when it runs out, the next question opens by itself."
          />
        )}
        {timed && (
          <SwitchRow
            checked={values.strictNext !== false}
            onChange={(value) => onChange('strictNext', value)}
            title="Next button"
            description="On: students may move on before a question's time runs out. Off: a timed question stays on screen for its full time (a question with no timer still has Next)."
          />
        )}
      </div>
      {timed && (
        <>
          <span className="field-label">Time for each question</span>
          <div className="compact-numbers">
            {QUESTION_TYPES.map((type) => (
              <TimeStepper
                key={type}
                id={`${idPrefix}-time-${type}`}
                label={TYPE_NAMES[type]}
                seconds={typeSeconds[type] ?? ''}
                onChange={(value) => onChange('typeSeconds', { ...typeSeconds, [type]: value })}
              />
            ))}
          </div>
          <p className="help">
            {timesNote(timers, estimatedSeconds, values.strictNext)}
            0 = no timer. {perQuestionNote || 'A question can have its own time in the editor below.'}
          </p>
        </>
      )}
    </div>
  );
}
