import { DEFAULT_TYPE_SECONDS, QUESTION_TYPES, hasQuestionTimers, sameForEveryType, secondsLabel } from '../lib/quiz.js';
import { durationLabel } from '../lib/format.js';
import { ChoiceCards, LAYOUT_OPTIONS, SwitchRow, TimeStepper } from './FormControls.jsx';

const TYPE_NAMES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
const TIME_EACH = [
  { value: 'same', title: 'Same for every question', description: 'One time, for every question on the paper.' },
  { value: 'type', title: 'By question type', description: 'A time for single choice, one for multiple choice and one for short answers.' }
];

/** What the times add up to: `timers` is whether all, some or none of the questions a paper can draw have one. */
function timesNote(timers, seconds, next) {
  if (timers === 'none') return 'Every time is 0, so no question has a timer: students move on with Next whenever they are ready.';
  const length = seconds > 0 ? durationLabel(seconds) : '';
  return [
    length && (timers === 'all' ? `Each paper takes up to ${length}.` : `Each paper takes about ${length} - a question with no timer counted at its usual time.`),
    next === false ? (timers === 'all' ? 'Each question stays for its full time.' : 'A timed question stays for its full time; one with no timer has Next.') : ''
  ].filter(Boolean).join(' ');
}

/**
 * How students move through the questions: all on one page, or one at a
 * time - and then Previous (going back), Next (moving on before the time is
 * up) and a timer on each question. Under the timer, its time: the same for
 * every question, or one for each type.
 *
 * Stored as before (domain/strict-timing.js). One at a time with Previous and
 * no timer is the free paper. Without Previous, or with a timer, the server
 * holds the paper one question at a time (`strictTiming`). A timer on each
 * question means no going back: a timed question closes once it is left, so
 * the paper goes forward only, and only Next is left to choose. What Previous
 * was set to is kept in the form for when the timer is turned off again.
 *
 * `started`: the test is running. A free paper still swaps between one page
 * and one at a time; Next goes on and off; going back can be turned on, never
 * off, on a paper with no timer; the timer and its times are fixed. (A test
 * saved with a timer and going back before this rule keeps both.)
 * `onChange` takes the fields to change.
 */
export function QuestionFlowFields({ values, onChange, idPrefix, estimatedSeconds, timers = 'all', started = false }) {
  const strict = values.strictTiming === true;
  const oneAtATime = strict || values.questionLayout !== 'all';
  const timer = strict && values.questionTimers !== false;
  // What the teacher chose; with a timer on each question there is no going back,
  // except on a running test that already had it (it is never taken away).
  const wantsPrevious = !strict || values.strictPrevious === true;
  const keptPrevious = started && strict && values.strictPrevious === true;
  const previous = timer ? keptPrevious : wantsPrevious;
  const typeSeconds = values.typeSeconds || {};
  const same = values.timeEach ? values.timeEach === 'same' : sameForEveryType(typeSeconds);

  const setLayout = (layout) => onChange({ questionLayout: layout, ...(layout === 'all' ? { strictTiming: false, strictPrevious: false } : {}) });
  // Without a timer, Previous is the free paper (on) or one way only (off) - until the
  // test starts: a one-way paper then stays one, and going back is turned on in it.
  const setPrevious = (on) => onChange(started ? { strictPrevious: on } : { strictTiming: !on, strictPrevious: false });
  const setTimer = (on) => onChange(on
    // Timers turned on with every type at 0 start from the usual times. Previous
    // goes off with them; what it was is kept for turning the timer off again.
    ? { strictTiming: true, questionTimers: true, strictPrevious: wantsPrevious, ...(hasQuestionTimers(typeSeconds) ? {} : { typeSeconds: { ...DEFAULT_TYPE_SECONDS } }) }
    : { questionTimers: false, strictTiming: !wantsPrevious, strictPrevious: false });
  const setTimeEach = (choice) => {
    if (choice === 'type') return onChange({ timeEach: 'type' });
    const one = Number(QUESTION_TYPES.map((type) => typeSeconds[type]).find((seconds) => Number(seconds) > 0)) || DEFAULT_TYPE_SECONDS.mcq;
    return onChange({ timeEach: 'same', typeSeconds: { mcq: one, msq: one, short: one } });
  };

  // One short line under each switch, so a newcomer sees what it does without opening anything.
  const previousHint = timer
    ? (keptPrevious
      ? 'Students can go back to questions that still have time. It stays on: they may already have used it.'
      : 'Not with a timer on each question: a question closes once it is left, so students only go forward. Next decides whether they may move on early.')
    : started && !strict
      ? 'Students move back and forth freely. Fixed once the test has started.'
      : started
        ? (values.strictPrevious
          ? 'Students can go back to questions they have seen. It stays on: they may already have used it.'
          : 'Off: no going back. Turn it on to let students go back to questions they have seen - it cannot be turned off again.')
        : 'Students can go back to earlier questions. Off: one way only.';
  return (
    <div className="form-wide flow-fields">
      <ChoiceCards
        label="How questions are shown"
        idPrefix={`${idPrefix}-layout`}
        value={oneAtATime ? 'one' : 'all'}
        onChange={setLayout}
        options={LAYOUT_OPTIONS}
        // A paper held one question at a time cannot become one page once papers are out.
        disabled={started && strict}
        hint
      />
      {oneAtATime && (
        <div className="dependent-fields strict-fields">
          <div className="switch-list">
            <SwitchRow checked={previous} onChange={setPrevious} title="Previous" hint={previousHint}
              disabled={timer || (started && (!strict || values.strictPrevious === true))}/>
            <SwitchRow checked={timer ? values.strictNext !== false : true} onChange={(on) => onChange({ strictNext: on })} title="Next"
              disabled={!timer}
              hint={timer
                ? 'Students can move on before a question\'s time is up. Off: each question stays for its full time. Can change while the test runs.'
                : 'Without a timer, students always have Next.'}/>
            <SwitchRow checked={timer} onChange={setTimer} title="Timer on each question" disabled={started}
              hint={started
                ? 'Fixed once the test has started.'
                : 'Each question gets its own time, counted only while it is on screen. When it runs out, the next question opens by itself. No going back with a timer.'}/>
          </div>
          {timer && (started ? (
            <p className="help">
              {sameForEveryType(typeSeconds)
                ? `Every question: ${secondsLabel(typeSeconds.mcq).toLowerCase()}.`
                : `${QUESTION_TYPES.map((type) => `${TYPE_NAMES[type]} ${secondsLabel(typeSeconds[type]).toLowerCase()}`).join(' · ')}.`}
              {' '}Fixed once the test has started.
            </p>
          ) : (
            <div className="dependent-fields flow-times">
              <ChoiceCards label="Time for each question" idPrefix={`${idPrefix}-time-each`} value={same ? 'same' : 'type'} onChange={setTimeEach} options={TIME_EACH} hint/>
              {same ? (
                <div className="compact-numbers">
                  <TimeStepper id={`${idPrefix}-time-all`} label="Every question" seconds={typeSeconds.mcq ?? ''}
                    onChange={(seconds) => onChange({ typeSeconds: { mcq: seconds, msq: seconds, short: seconds } })}/>
                </div>
              ) : (
                <div className="compact-numbers">
                  {QUESTION_TYPES.map((type) => (
                    <TimeStepper key={type} id={`${idPrefix}-time-${type}`} label={TYPE_NAMES[type]} seconds={typeSeconds[type] ?? ''}
                      onChange={(seconds) => onChange({ typeSeconds: { ...typeSeconds, [type]: seconds } })}/>
                  ))}
                </div>
              )}
              <p className="help">{timesNote(timers, estimatedSeconds, values.strictNext)} 0 = no timer.</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
