import { useEffect, useRef, useState } from 'react';
import { leavingStatus, leavingWarningState } from './leaving-rules.js';
import { countdown } from '../../lib/format.js';
import { useCountdown } from '../../lib/useCountdown.js';

const WARNINGS = [[300, '5 minutes left', 'Your test is submitted automatically when time runs out.'], [60, '1 minute left', 'Finish your last answer.']];

/** "8h 21m" past an hour, "21:07" below it - seconds only matter near the end. */
const readable = (seconds) => {
  const value = Math.max(0, Math.ceil(seconds));
  if (value < 3600) return countdown(value);
  return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
};

/**
 * A countdown on the server's clock that calls `onExpire` once when it runs
 * out - once per deadline, so a new question (or an extension) arms it again.
 */
function useDeadline(deadlineAt, serverTime, onExpire) {
  const state = useCountdown(deadlineAt, serverTime);
  const fired = useRef(false);
  useEffect(() => { fired.current = false; }, [deadlineAt]);
  useEffect(() => {
    if (deadlineAt && state.known && state.isOver && !fired.current) { fired.current = true; onExpire?.(); }
  }, [deadlineAt, state.known, state.isOver, onExpire]);
  return deadlineAt ? state : { secondsLeft: null, known: false, isOver: false };
}

/**
 * Strict timing: a question's clock stops while the student is away from the
 * paper - the server stops it too (domain/strict-timing.js). Here it stops the
 * moment the page notices, and starts again only once a view from the server
 * says it runs, so it never runs out on this screen for time the server does
 * not count. Returns the moment (on the server's clock) the clocks are held
 * at, or null while they run.
 */
function useQuestionPause(strict, serverTime, away) {
  const offset = useRef(0);
  const [heldAt, setHeldAt] = useState(null);
  const serverPaused = Boolean(strict?.questionPaused);
  useEffect(() => { if (serverTime) offset.current = Date.parse(serverTime) - Date.now(); }, [serverTime]);
  // Leaving: stop here and now, before the server has heard.
  useEffect(() => {
    if (away) setHeldAt((current) => current ?? Date.now() + offset.current);
  }, [away]);
  // Each view from the server: stopped there too, or running again - but
  // never while this page is still away.
  useEffect(() => {
    if (serverPaused) setHeldAt(Date.parse(serverTime));
    else if (!away) setHeldAt(null);
  }, [serverTime, serverPaused]); // eslint-disable-line react-hooks/exhaustive-deps
  return strict ? heldAt : null;
}

/**
 * Leaving the test, as one small warning triangle that appears after the
 * first exit: amber once the next exit would lock the paper, red past the
 * limit. Tap it for the details. Nothing shows while the student has not left.
 */
function IntegrityBadge({ attempt }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  const exits = attempt.timesLeft || 0;
  const away = Math.round((attempt.timeAwayMs || 0) / 1000);
  const warning = leavingWarningState(attempt);
  const current = warning.exits;
  const limit = warning.exitLimit;
  const currentAway = Math.round(warning.awayMs / 1000);
  const awayLimit = Math.round(warning.awayLimitMs / 1000);
  useEffect(() => {
    if (!open) return undefined;
    // A tap anywhere else closes the details. Not a tap on the triangle - that
    // toggles them itself - and not one on the details.
    const close = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    return () => { window.clearTimeout(timer); document.removeEventListener('pointerdown', close, true); };
  }, [open]);
  // "Record only" deliberately has neither a student warning nor a lock.
  // Keep the administrator's audit trail, but do not put a warning triangle
  // on the student's paper for that mode.
  if (!attempt.warnsOnViolation && !attempt.locksOnViolation) return null;
  if (!exits && !away) return null;
  // Only activity since the last unlock drives the warning. The separate
  // overall figures below never reset, so Revive cannot hide prior activity.
  const tone = warning.over ? ' is-over' : warning.low ? ' is-last' : '';
  const awayLabel = away >= 60 ? `${Math.floor(away / 60)}m ${away % 60}s` : `${away}s`;
  const currentAwayLabel = currentAway >= 60 ? `${Math.floor(currentAway / 60)}m ${currentAway % 60}s` : `${currentAway}s`;
  const remainingAwaySeconds = warning.remainingAwayMs === null ? null : Math.ceil(warning.remainingAwayMs / 1000);
  const status = warning.over
    ? 'Limit exceeded'
    : warning.awayLow
      ? `${remainingAwaySeconds}s of away time left`
      : warning.exitsLow
        ? 'Last chance'
        : current === 0 && currentAway === 0 ? 'Allowance refreshed' : 'Activity recorded';
  return (
    <div className="exam-integrity" ref={box}>
      <button type="button" className={`exam-integrity-badge${tone}`} aria-expanded={open} onClick={() => setOpen((value) => !value)}
        aria-label={`Left the test ${exits} time${exits === 1 ? '' : 's'}. Show details`}>
        <span aria-hidden="true">⚠</span>
      </button>
      {open && (
        <div className={`exam-integrity-pop${tone}`} role="status">
          <div className="exam-integrity-pop-head">
            <span className="exam-integrity-pop-icon" aria-hidden="true">⚠</span>
            <div><strong>Leaving the test</strong><span>{status}</span></div>
          </div>
          <span className="exam-integrity-section-label">Current allowance</span>
          <div className="exam-integrity-stats">
            <div><span>Exits</span><strong>{current}{limit > 0 ? ` / ${limit}` : ''}</strong></div>
            <div><span>Away</span><strong>{currentAwayLabel}{awayLimit > 0 ? ` / ${awayLimit}s` : ''}</strong></div>
          </div>
          <p>{leavingStatus(attempt)}</p>
          <div className="exam-integrity-overall">
            <span>Overall record</span>
            <strong>{exits} exit{exits === 1 ? '' : 's'} · {awayLabel} away</strong>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The top of the paper: the title, one timer that matters most right now -
 * this question's under strict timing, else the test's - with a bar that
 * drains as it runs out, and one quiet line with the rest.
 */
export function ExamHeader({ attempt, strict, away = false, answeredCount, totalCount, onTestExpire, onQuestionExpire, onWarn }) {
  const serverTime = attempt.serverTime;
  const test = useDeadline(attempt.untimed ? null : attempt.deadlineAt, serverTime, onTestExpire);
  // The question's (and, untimed, the paper's) clock, held still while away.
  // Held, it has no deadline to run out at - only the time it had left.
  const heldAt = useQuestionPause(strict, serverTime, away);
  const questionEndsAt = strict?.questionEndsAt || null;
  const paperEndsAt = strict && attempt.untimed ? strict.paperEndsAt : null;
  const running = useDeadline(heldAt === null ? questionEndsAt : null, serverTime, onQuestionExpire);
  const paperRunning = useDeadline(heldAt === null ? paperEndsAt : null, serverTime, null);
  const held = (endsAt) => (endsAt ? { secondsLeft: (Date.parse(endsAt) - heldAt) / 1000, known: true, isOver: false } : running);
  const question = heldAt === null ? running : held(questionEndsAt);
  const paper = heldAt === null ? paperRunning : (paperEndsAt ? held(paperEndsAt) : paperRunning);
  const testOver = attempt.timeOver || test.isOver;

  // The 5- and 1-minute warnings for the test, once each, never for a mark already behind us.
  const warned = useRef(null);
  useEffect(() => {
    if (!test.known) return;
    if (warned.current === null) { warned.current = new Set(WARNINGS.filter(([at]) => test.secondsLeft <= at).map(([at]) => at)); return; }
    for (const [at, title, message] of WARNINGS) {
      if (test.secondsLeft <= at && !warned.current.has(at)) { warned.current.add(at); onWarn(title, message); }
    }
  }, [test.known, test.secondsLeft, onWarn]);

  // The main timer.
  let primary;
  if (strict) {
    primary = strict.questionEndsAt
      ? { label: 'This question', left: question.known ? question.secondsLeft : null, total: strict.questionSeconds, low: 30, critical: 10, short: true }
      : { label: 'This question', text: 'No timer' };
  } else if (!attempt.untimed) {
    const windowSeconds = (Date.parse(attempt.deadlineAt) - Date.parse(attempt.startedAt)) / 1000;
    primary = testOver ? { label: 'Time left', text: 'Time over', tone: 'is-critical' }
      : { label: 'Time left', left: test.known ? test.secondsLeft : null, total: windowSeconds, low: 300, critical: 60 };
  } else {
    primary = { label: 'Time', text: 'No end time' };
  }
  const left = primary.left === null || primary.left === undefined ? null : Math.max(0, primary.left);
  const tone = primary.tone || (left === null ? '' : left <= primary.critical ? 'is-critical' : left <= primary.low ? 'is-low' : '');
  const value = primary.text || (left === null ? '—' : primary.short ? countdown(left) : readable(left));
  const fraction = left !== null && primary.total > 0 ? Math.min(1, left / primary.total) : null;

  // The quiet line: the test's time (under strict timing), then progress.
  const parts = [];
  if (strict) {
    if (!attempt.untimed) {
      parts.push(testOver
        ? { text: 'Test time is over', urgent: true }
        : { text: `Test ends in ${test.known ? readable(test.secondsLeft) : '—'}`, urgent: test.known && test.secondsLeft <= 300 });
    } else if (strict.paperEndsAt || strict.laterSeconds) {
      const paperLeft = strict.paperEndsAt ? (paper.known ? paper.secondsLeft : null) : strict.laterSeconds;
      parts.push({ text: `Paper left ${paperLeft === null ? '—' : readable(paperLeft)}${strict.untimedLeft ? '+' : ''}` });
    }
    parts.push({ text: `Question ${strict.index + 1} of ${strict.total}` });
  } else {
    parts.push({ text: `${answeredCount} of ${totalCount} answered` });
  }

  return (
    <header className="exam-head">
      <div className="exam-head-top">
        <h1 className="exam-heading">{attempt.title}</h1>
        <IntegrityBadge attempt={attempt}/>
      </div>
      <div className={`exam-timer-card ${tone}`} role="timer" aria-live="off" aria-label={`${primary.label}: ${value}`}>
        <div className="exam-timer-row">
          <span className="exam-timer-label">{primary.label}</span>
          <strong className="exam-timer-value">{value}</strong>
        </div>
        {fraction !== null && (
          <div className="exam-timer-bar" aria-hidden="true"><span style={{ width: `${fraction * 100}%` }}/></div>
        )}
      </div>
      <p className="exam-sub">
        {parts.map((part, index) => (
          <span key={index} className={part.urgent ? 'is-urgent' : ''}>{index > 0 && <span className="exam-sub-dot" aria-hidden="true">·</span>}{part.text}</span>
        ))}
      </p>
    </header>
  );
}
