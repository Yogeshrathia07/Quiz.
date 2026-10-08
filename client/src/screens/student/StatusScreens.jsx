import { useEffect, useRef } from 'react';
import { countdown, dateTime, durationLabel } from '../../lib/format.js';
import { useCountdown } from '../../lib/useCountdown.js';
import { InfoTip } from '../../components/InfoTip.jsx';

export function TestHeader({ test, showInstructions = true }) {
  return (
    <>
      <p className="eyebrow" style={{ color: 'var(--brand)' }}>{test.code}</p>
      <h1>{test.title}</h1>
      {showInstructions && <p>{test.instructions || 'Follow the administrator’s instructions before you begin.'}</p>}
    </>
  );
}

/** Re-check without synchronising an entire class on the same millisecond. */
function usePolling(reload, minimumMs, maximumMs = minimumMs + 4_000) {
  useEffect(() => {
    let timer;
    const tick = async () => {
      try { if (!document.hidden) await reload(); }
      finally {
        const minimum = document.hidden ? Math.max(20_000, minimumMs) : minimumMs;
        const maximum = document.hidden ? Math.max(30_000, maximumMs) : maximumMs;
        timer = window.setTimeout(tick, minimum + Math.round(Math.random() * (maximum - minimum)));
      }
    };
    timer = window.setTimeout(tick, minimumMs + Math.round(Math.random() * (maximumMs - minimumMs)));
    return () => window.clearTimeout(timer);
  }, [reload, minimumMs, maximumMs]);
}

export function GuestsNotAllowed({ test }) {
  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <div className="notice danger">
        This test accepts only college accounts. Sign out of the guest account and sign in with your college
        email to continue.
      </div>
    </section>
  );
}

export function TestTimeOver({ test, reload }) {
  usePolling(reload, 30_000, 45_000);
  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <p className="eyebrow" style={{ color: 'var(--danger)' }}>Time is over</p>
      <h2>This test closed at {dateTime(test.endsAt)}.</h2>
      <p>
        You did not begin before the time ran out, so a new attempt cannot be started. Speak to your
        administrator — if they extend the time, this page will let you in automatically.
      </p>
    </section>
  );
}

export function RegistrationRejected({ test }) {
  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <p className="eyebrow" style={{ color: 'var(--danger)' }}>Registration declined</p>
      <h2>You can’t enter this test.</h2>
      <p>Please contact the administrator if you think this was a mistake.</p>
    </section>
  );
}

export function TestClosed({ test }) {
  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <p className="eyebrow" style={{ color: 'var(--success)' }}>Test complete</p>
      <h2>This test is closed.</h2>
      <p>The administrator has completed this test. New registrations and attempts are no longer available.</p>
    </section>
  );
}

export function RegistrationPending({ test, registration, reload }) {
  // EventSource delivers approval immediately. This is only the fallback for
  // a network/proxy that cannot keep an EventSource connection open.
  usePolling(reload, 25_000, 35_000);
  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <p className="eyebrow" style={{ color: 'var(--warning)' }}>Registration pending</p>
      <div className="launch-title">
        <h2>Waiting for approval</h2>
        <InfoTip label="About your request">
          Sent at {dateTime(registration.requestedAt)}. This page checks for the decision by itself.
          {registration.expiresAt && ` If it is not approved by ${dateTime(registration.expiresAt)}, the request is withdrawn and you can send it again.`}
        </InfoTip>
      </div>
      <p>Your teacher has to let you in. This page moves on by itself.</p>
      <button className="button button-secondary button-wide" onClick={reload}>Check now</button>
    </section>
  );
}

/** How the test ends, in one line a student can plan around; `brief` leaves out what happens then. */
export function EndLine({ test, brief = false }) {
  const then = brief ? '' : ' When time runs out, your paper is submitted automatically.';
  if (test.untimed) return <>No time limit — your instructor ends the test{brief ? '' : ', which submits your paper'}.</>;
  // Each student's own time: however late they begin, the whole duration is theirs.
  if (test.endMode === 'each') {
    return <>You get <strong>{durationLabel((test.durationMinutes || 0) * 60)}</strong> from when you press Begin.{then}</>;
  }
  if (test.endMode === 'duration' && !test.isStarted) {
    return <>You will have <strong>{durationLabel((test.durationMinutes || 0) * 60)}</strong> from the start.{then}</>;
  }
  return <>Ends at <strong>{dateTime(test.endsAt)}</strong> for everyone.{then}</>;
}

/**
 * Before the start. A scheduled test counts down on the server's clock and
 * asks again the moment it reaches zero; one the administrator starts by hand
 * is told of Start by the live stream at once - and while that stream is down
 * (`live` false), the page asks every few seconds instead, so nobody sits
 * waiting for a start that has already happened.
 */
export function WaitingForStart({ test, serverTime, reload, live = true, venue = null }) {
  usePolling(reload, live ? 25_000 : 5_000, live ? 35_000 : 9_000);
  const scheduled = test.startMode === 'scheduled' && test.opensAt;
  const { secondsLeft, known } = useCountdown(scheduled ? test.opensAt : null, serverTime);
  const due = scheduled && known && secondsLeft <= 0;
  const asked = useRef(false);
  useEffect(() => {
    if (due && !asked.current) { asked.current = true; reload(); }
  }, [due, reload]);

  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <p className="eyebrow" style={{ color: 'var(--success)' }}>Registration approved</p>
      {scheduled ? (
        <>
          <h2>{due ? 'Starting…' : 'The test starts in'}</h2>
          {!due && <p className="start-countdown" role="timer" aria-live="off">{known ? countdown(secondsLeft) : '—'}</p>}
          <p>Starts at <strong>{dateTime(test.opensAt)}</strong>. Keep this page open — the Begin button appears here by itself.</p>
        </>
      ) : (
        <>
          <h2>Waiting for your instructor to start the test</h2>
          <p className="waiting-pulse"><span aria-hidden="true"/>Keep this page open. It moves on by itself the moment the test starts.</p>
        </>
      )}
      <p className="help"><EndLine test={test}/></p>
      {venue}
    </section>
  );
}

/**
 * Paused by the teacher: the paper is off the screen and the clock is
 * stopped. The time left is shown as it stood - it does not run - and the
 * page asks every few seconds, carrying on the moment the teacher continues.
 */
export function PausedAttempt({ attempt, reload }) {
  usePolling(reload, 12_000, 16_000);
  const leftMs = attempt.deadlineAt ? Math.max(0, Date.parse(attempt.deadlineAt) - Date.parse(attempt.serverTime)) : null;
  return (
    <section className="join-card card lock-card pause-card">
      <p className="eyebrow" style={{ color: 'var(--primary, #1598D1)' }}>Test paused</p>
      <h1>Your teacher has paused your test</h1>
      <p>Your time is stopped{leftMs !== null ? <> with <strong>{countdown(Math.round(leftMs / 1000))}</strong> left</> : ''}. Your answers are saved.</p>
      <div className="lock-stats">
        <div><strong>{attempt.answeredQuestionCount}/{attempt.totalQuestions}</strong><span>answered</span></div>
        {leftMs !== null && <div><strong>{countdown(Math.round(leftMs / 1000))}</strong><span>left, not running</span></div>}
      </div>
      <p className="help">Stay on this page — it carries on by itself.</p>
    </section>
  );
}

/**
 * A locked attempt waits for the administrator to revive it; this page asks
 * the server every few seconds and continues the moment they do. Where a lock
 * wait is configured instead, it counts down to its own unlock.
 */
export function LockedAttempt({ attempt, reload }) {
  usePolling(reload, 12_000, 16_000);
  const { secondsLeft, known } = useCountdown(attempt.unlocksAt, attempt.serverTime);
  const tries = attempt.fullscreenExitLimit || 0;
  const awaySeconds = attempt.fullscreenAbsenceLimitSeconds || 0;
  const warnings = attempt.locksOnViolation ? attempt.warningsBeforeLock || 0 : 0;
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  // What an unlock gives back: the exits allowed, and - with "Warn, then lock" - the warnings too.
  const allowance = [
    tries > 0 && plural(tries, 'exit'),
    awaySeconds > 0 && `${awaySeconds} seconds away`,
    warnings > 0 && plural(warnings, 'warning')
  ].filter(Boolean).join(', ');
  return (
    <section className="join-card card lock-card">
      <p className="eyebrow" style={{ color: 'var(--danger)' }}>Attempt locked</p>
      <h1>{attempt.unlocksAt ? (known && secondsLeft > 0 ? `Unlocks in ${countdown(secondsLeft)}` : 'Unlocking…') : 'Waiting for your administrator'}</h1>
      <p>{attempt.lockReason || 'This attempt was locked by the integrity policy.'}</p>
      <div className="lock-stats">
        <div><strong>{attempt.timesLeft}</strong><span>times left the test</span></div>
        <div><strong>{attempt.timesLocked}</strong><span>times locked</span></div>
      </div>
      <p className="help lock-line">
        <span>{attempt.unlocksAt ? 'Stay on this page — it unlocks by itself.' : 'Tell your administrator. Your test continues here once they approve it.'}</span>
        <InfoTip label="About the lock">
          {attempt.unlocksAt ? 'Your test continues automatically when the timer ends.' : 'You went past what this test allows.'}
          {allowance ? ` After the unlock you get ${allowance} again before it locks.` : ''}
          {' '}{attempt.strictTiming
            ? 'This question’s timer is paused until you are back on it; the test’s own time keeps running.'
            : 'Your test time keeps running while it is locked.'}
          {' '}Every exit is recorded in your result.
        </InfoTip>
      </p>
    </section>
  );
}
