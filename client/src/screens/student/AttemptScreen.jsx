import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { leavingRules } from './leaving-rules.js';
import { PrivateWindowRequired } from './PrivateWindowRequired.jsx';
import { api, isOffline, isSignedOut, post } from '../../lib/api.js';
import { AuthForm } from '../../components/AuthForm.jsx';
import {
  fullscreenSupported, inFullscreen, markResumed, requestTestFullscreen, useAwayMonitor, useClipboardGuard, useKeyboardLockdown, withoutAwayCheck
} from '../../lib/useAwayMonitor.js';
import {
  applyPending, clearCache, clearDurableCache, clearOtherCaches, isPermanentRejection, loadCache, loadCacheForCode,
  loadDurableCache, mergeAnswerAcknowledgement, mergeAttemptState, retryDelay, saveCache, saveDurableCache
} from '../../lib/offline-answers.js';
import { setExamInProgress } from '../../lib/useAppUpdate.js';
import { useKeepAwake } from '../../lib/keep-awake.js';
import { useExtensionWatch } from '../../lib/extension-watch.js';
import { getBrowserLocation } from '../../lib/geo.js';
import { QuestionPalette } from './QuestionPalette.jsx';
import { QuestionPaper } from './QuestionPaper.jsx';
import { QuestionList } from './QuestionList.jsx';
import { LockedAttempt, PausedAttempt } from './StatusScreens.jsx';
import { ResultScreen } from './ResultScreen.jsx';
import { ExamHeader } from './ExamHeader.jsx';

const storage = typeof window === 'undefined' ? null : window.localStorage;
const durableStorage = typeof window === 'undefined' ? null : window.indexedDB;
const PRESENCE_KEY = (attemptId) => `quiz-presence:${attemptId}`;
const wait = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });
/**
 * Spread refreshes and adapt their rate. A normal open paper needs only a
 * heartbeat comfortably inside the 60-second offline window; locked/paused
 * papers check faster so a teacher's Revive appears quickly, while a hidden
 * page backs off. No class now lands on one fixed second.
 */
export const attemptPollDelay = (attempt, hidden = typeof document !== 'undefined' && document.hidden, random = Math.random()) => {
  if (attempt?.isLocked || attempt?.paused) return 5_000 + Math.round(random * 3_000);
  if (hidden) return 28_000 + Math.round(random * 8_000);
  const deadline = Date.parse(attempt?.endsAt || attempt?.deadlineAt || '');
  if (Number.isFinite(deadline) && deadline - Date.now() < 2 * 60_000) return 7_000 + Math.round(random * 4_000);
  return 18_000 + Math.round(random * 7_000);
};
export const locationPollDelay = (closed, random = Math.random()) => {
  const base = closed ? 12_000 : 54_000;
  const spread = closed ? 6_000 : 12_000;
  return base + Math.round(random * spread);
};
/** A location report that has not answered in this long is given up; the next check retries. */
const REPORT_MS = 15_000;
/** Submit waits at most this long for the location reading that goes on the record. */
const SUBMIT_LOCATION_MS = 3_000;
/** Avoid every timed paper opening one connection on the exact same millisecond. */
const AUTO_SUBMIT_JITTER_MS = 8_000;
/** Worth trying again: the connection dropped, or the server was momentarily overloaded. */
const isRetryable = (error) => isOffline(error) || isSignedOut(error) || error.status >= 500 || error.status === 429 || error.status === 408;

/**
 * Shown over the paper when this device was signed out mid-test - normally
 * because the account signed in somewhere else. The paper and every unsent
 * answer stay on this device; signing in here (which signs the other device
 * out) sends them and carries on.
 */
function SignedOutGate({ message, microsoft, onSignedIn, showToast }) {
  return (
    <div className="soft-lock" role="alertdialog" aria-modal="true" aria-label="Signed out">
      <div className="card signed-out-card">
        <p className="eyebrow">Signed out</p>
        <h2>Sign in again to continue your test</h2>
        <p className="notice danger">{message}</p>
        <p className="help">Your answers are kept on this device and are sent as soon as you sign in. Signing in here signs your other device out.</p>
        <AuthForm compact microsoft={microsoft} returnTo={window.location.pathname + window.location.search} onSignedIn={onSignedIn} showToast={showToast}/>
      </div>
    </div>
  );
}

function readPresence(attemptId) {
  try { return JSON.parse(storage?.getItem(PRESENCE_KEY(attemptId)) || '[]'); } catch { return []; }
}

function writePresence(attemptId, queue) {
  try {
    if (queue.length) storage?.setItem(PRESENCE_KEY(attemptId), JSON.stringify(queue));
    else storage?.removeItem(PRESENCE_KEY(attemptId));
  } catch { /* storage full or blocked: the in-memory queue still sends */ }
}

/** Land on the first unanswered question, so a reload resumes where work is left. */
const landingIndex = (questions = []) => Math.max(0, questions.findIndex((question) => !question.answered));

function Arrow({ back = false }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d={back ? 'M15 5l-7 7 7 7' : 'M9 5l7 7-7 7'}/>
    </svg>
  );
}

/** Strict timing: where the student is on the paper. Nothing here can be clicked - there is no going back. */
function StrictDots({ strict }) {
  return (
    <div className="q-dots strict-dots" aria-label={`Question ${strict.index + 1} of ${strict.total}`}>
      {Array.from({ length: strict.total }, (_unused, position) => {
        const closed = strict.closed?.[position];
        const classes = ['q-dot', closed ? 'is-done' : '', closed?.how === 'time' ? 'is-timed-out' : '', position === strict.index ? 'is-current' : '']
          .filter(Boolean).join(' ');
        return <span key={position} className={classes} title={closed ? (closed.how === 'time' ? 'Time ran out' : 'Done') : undefined}>{position + 1}</span>;
      })}
    </div>
  );
}

/**
 * A confirmation drawn in the page. The browser's own confirm() box takes the
 * page out of fullscreen, and pressing Escape to dismiss it leaves fullscreen
 * too - both counted as leaving the test. This never touches fullscreen, and
 * it is answered with its buttons only.
 */
function ConfirmGate({ request, onAnswer }) {
  const confirmRef = useRef(null);
  useEffect(() => { confirmRef.current?.focus(); }, []);
  return (
    <div
      className="confirm-gate"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-gate-title"
      // A tap on the blurred page around the card is the same as "keep going".
      onPointerDown={(event) => { if (event.target === event.currentTarget) onAnswer(false); }}
    >
      <div className="confirm-gate-card card">
        <h2 id="confirm-gate-title">{request.title}</h2>
        {request.message && <p>{request.message}</p>}
        <div className="confirm-gate-actions">
          <button className="button button-secondary" type="button" onClick={() => onAnswer(false)}>{request.cancelLabel || 'Keep going'}</button>
          <button ref={confirmRef} className={`button ${request.danger ? 'button-danger' : 'button-primary'}`} type="button" onClick={() => onAnswer(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Covers the paper the moment time runs out, while it is being submitted. */
function TimeUpGate({ unsent, answered, total, online }) {
  return (
    <div className="away-gate" role="alertdialog" aria-modal="true" aria-labelledby="time-up-title">
      <div className="away-gate-card card">
        <p className="eyebrow" style={{ color: 'var(--danger)' }}>Time's up</p>
        <h2 id="time-up-title">Submitting your answers…</h2>
        <p>The test time has ended, so your paper is being submitted automatically with the {answered} of {total} answers you gave.</p>
        <p className="help">
          {!online
            ? 'The server can’t be reached right now. Your answers are safe on this device — keep this page open and it finishes by itself.'
            : unsent > 0
              ? `${unsent} answer${unsent === 1 ? ' is' : 's are'} still being sent from this device — keep this page open.`
              : 'Keep this page open. Your result appears here in a moment.'}
        </p>
      </div>
    </div>
  );
}

/**
 * Every tap on an option queues an answer for a split second. A normal save
 * shows nothing: the answer is already kept on this device. The strip appears
 * only when sending is really stuck - longer than slow classroom Wi-Fi takes
 * for one save - or when offline.
 */
const STUCK_AFTER_MS = 8_000;

/** Blocked actions the student is warned about. A refused fullscreen is the browser's doing, not theirs. */
const FLAG_WARNINGS = {
  copy: 'Copying is not allowed',
  cut: 'Cutting text is not allowed',
  paste: 'Pasting is not allowed',
  drop: 'Dragging text in is not allowed',
  context_menu: 'That menu is not allowed',
  screenshot: 'Screenshots are not allowed',
  print: 'Printing is not allowed',
  devtools: 'Developer tools are not allowed'
};
// Whether an answer carried with a move has anything in it (a cleared one does not).
const hasContent = (answer) => Boolean((answer?.answerText || '').trim() || answer?.selectedOptions?.length);

function ConnectionNotice({ online, unsent }) {
  // The browser still has a network, so it is the test server that is unreachable.
  const serverDown = !online && typeof navigator !== 'undefined' && navigator.onLine;
  const [stuck, setStuck] = useState(false);
  const hasUnsent = unsent > 0;
  useEffect(() => {
    if (!hasUnsent) { setStuck(false); return undefined; }
    const timer = window.setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hasUnsent]);
  const synced = online && unsent === 0;
  const title = synced ? 'Synced' : online ? (stuck ? 'Still sending…' : 'Saved on this device') : serverDown ? 'Can’t reach the server' : 'You are offline';
  const detail = synced ? 'All answers are saved on the server.' : online ? 'Keep this page open.'
    : serverDown ? 'Answers are saved here; lost time is given back.'
      : 'Answers are saved here. Over a minute offline counts as leaving.';
  const saved = unsent > 0 ? ` · ${unsent} waiting to send` : '';
  return (
    <div className={`connection-strip${synced ? ' is-synced' : online ? '' : ' is-down'}`} role="status" title={`${title}. ${detail}`}>
      <span className="connection-dot" aria-hidden="true"/>
      <strong>{title}</strong>
      <span className="connection-detail">{saved || ` · ${detail}`}</span>
    </div>
  );
}

/** Past the test's switch allowance (a test that only warns never locks, so the student can go past it). */
const pastLimit = (attempt) => attempt.fullscreenExitLimit > 0 && (attempt.timesLeft || 0) > attempt.fullscreenExitLimit;

function limitsLine(attempt) {
  const parts = [`You have left the test ${attempt.timesLeft || 0} time${attempt.timesLeft === 1 ? '' : 's'}.`];
  const rules = leavingRules(attempt).trim();
  if (rules) parts.push(rules);
  parts.push('Every exit and how long you were away is recorded.');
  return parts.join(' ');
}

/**
 * Covers the paper while the student is away - above all, after pressing Home
 * and coming back, when the phone has silently dropped out of fullscreen. The
 * paper stays mounted underneath, so a half-typed answer is not lost.
 */
/** Strict timing: the open question's timer waits while the student is away. */
const pausedNote = (attempt) => (attempt.strict?.questionEndsAt
  ? <p className="help away-paused">This question's timer is paused until you come back.</p>
  : null);

function AwayGate({ attempt, split, starting, needsFullscreen, refusals = 0, onResume, onSkipFullscreen }) {
  // The browser said no to fullscreen: say so here, where the student is
  // looking - a message that fades was easy to miss - and after the second
  // no, let them carry on without it (recorded), as on an iPhone.
  const refused = needsFullscreen && refusals > 0 && (
    <p className="notice danger away-refused">
      Your browser would not open fullscreen{refusals > 1 ? ` (${refusals} tries)` : ''}. Press the button again, or open this test in Chrome or Safari.
    </p>
  );
  // The quieter second choice, under the main button.
  const skip = needsFullscreen && refusals > 1 && (
    <button className="button button-wide away-skip" type="button" onClick={onSkipFullscreen}>Continue without fullscreen</button>
  );
  const line = limitsLine(attempt);
  if (starting) {
    return (
      <div className="away-gate" role="alertdialog" aria-modal="true" aria-labelledby="away-gate-title">
        <div className="away-gate-card card">
          <p className="eyebrow">Almost ready</p>
          <h2 id="away-gate-title">Enter fullscreen to start</h2>
          <p>The test runs in fullscreen. Nothing has been recorded.</p>
          {refused}
          <button className="button button-primary button-wide" type="button" onClick={onResume}>Enter fullscreen</button>
          {skip}
        </div>
      </div>
    );
  }
  if (split) {
    return (
      <div className="away-gate" role="alertdialog" aria-modal="true" aria-labelledby="away-gate-title">
        <div className="away-gate-card card">
          <p className="eyebrow">Paper hidden</p>
          <h2 id="away-gate-title">Close split screen to continue</h2>
          <p>The test must fill the whole screen. Close the other app or window, or make this window full size — the test comes back by itself.</p>
          <p className="help">This has been recorded, and your administrator can see it.</p>
          {pausedNote(attempt)}
        </div>
      </div>
    );
  }
  return (
    <div className="away-gate" role="alertdialog" aria-modal="true" aria-labelledby="away-gate-title">
      <div className="away-gate-card card">
        {pastLimit(attempt)
          ? <p className="eyebrow away-warning">Warning · over the limit</p>
          : <p className="eyebrow">Paper hidden</p>}
        <h2 id="away-gate-title">{needsFullscreen ? 'Return to fullscreen to continue' : 'Tap to continue your test'}</h2>
        <p>{pastLimit(attempt)
          ? `You have left the test ${attempt.timesLeft} times, more than the ${attempt.fullscreenExitLimit} allowed. Your administrator can see every exit.`
          : 'You left the test. This has been recorded, and your administrator can see it.'}</p>
        {line && <p className="help">{line}</p>}
        {pausedNote(attempt)}
        {refused}
        <button className="button button-primary button-wide" type="button" onClick={onResume}>
          {needsFullscreen ? 'Return to fullscreen' : 'Continue test'}
        </button>
        {skip}
      </div>
    </div>
  );
}

/**
 * How often the student has left, in a few characters: exits in the current
 * round against the limit, and the total time spent away. The full rules are
 * in the tooltip and on the "paper hidden" screen.
 */
function VenueGate({ venue, radiusMeters, checking, problem, onCheck }) {
  const away = venue.distanceMeters === null || venue.distanceMeters === undefined
    ? null
    : `${Math.round(venue.distanceMeters)} m from the venue`;
  return (
    <div className="away-gate" role="alertdialog" aria-modal="true" aria-labelledby="venue-gate-title">
      <div className="away-gate-card card">
        <p className="eyebrow" style={{ color: 'var(--danger)' }}>Paper closed</p>
        <h2 id="venue-gate-title">
          {venue.reason === 'outside' ? 'Go back to the test venue' : 'Location check needed'}
        </h2>
        <p>
          {venue.reason === 'outside'
            ? `Your device says you are ${away || 'away from the venue'}. Answers cannot be saved from outside${radiusMeters ? ` the ${radiusMeters} m test area` : ' the test area'}.`
            : 'Your device has stopped telling us where it is. Allow location access, and keep this page open at the venue.'}
        </p>
        {problem && <p className="notice danger" role="alert">{problem}</p>}
        <p className="help">
          The check runs again every few seconds. Your paper and your answers are safe, your time keeps running, and this is recorded for your administrator.
        </p>
        <button className="button button-primary button-wide" type="button" disabled={checking} onClick={onCheck}>
          {checking ? 'Checking…' : 'Check my location now'}
        </button>
      </div>
    </div>
  );
}

export function AttemptScreen({ code, microsoft = null, showToast, onPaperGone = () => {}, windowKind, privateExempt = false, onDeclareWindow = () => {} }) {
  // Sent with every poll, so a private-window rule switched on mid-test is
  // recorded against the window the paper is actually in.
  const windowRef = useRef(windowKind);
  windowRef.current = windowKind;
  const [attempt, setAttempt] = useState(null);
  const [result, setResult] = useState(null);
  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [pending, setPending] = useState(() => new Map());
  const [fullscreenUnavailable, setFullscreenUnavailable] = useState(false);
  const [shielded, setShielded] = useState(false);
  const [signedOut, setSignedOut] = useState('');
  // Held in a ref so the callbacks below keep their identity, and fired once.
  const paperGoneRef = useRef(onPaperGone);
  paperGoneRef.current = onPaperGone;
  const paperGoneFired = useRef(false);
  const paperGone = useCallback(() => {
    if (paperGoneFired.current) return;
    paperGoneFired.current = true;
    paperGoneRef.current();
  }, []);
  // The open in-page confirmation, and how to answer it.
  const [confirmRequest, setConfirmRequest] = useState(null);
  const askToConfirm = useCallback((request) => new Promise((resolve) => {
    setConfirmRequest({ ...request, resolve });
  }), []);
  const answerConfirm = (answer) => {
    confirmRequest?.resolve(answer);
    setConfirmRequest(null);
  };
  // The short answer being typed (strict timing), and the answers still queued.
  const paperFlush = useRef(null);
  // The latest attempt, for event handlers that outlive a render.
  const attemptRef = useRef(null);
  attemptRef.current = attempt;
  const warnFlag = useCallback((detail) => {
    if (FLAG_WARNINGS[detail]) showToast('Not allowed during the test. This is recorded.', 'warn', { title: FLAG_WARNINGS[detail] });
  }, [showToast]);
  const paperDraft = useRef(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const shieldTimer = useRef(null);
  const placed = useRef(false);
  const flushing = useRef(false);
  const attemptIdRef = useRef(null);
  const presenceQueue = useRef([]);
  const sendingPresence = useRef(false);
  const presenceFlushTimer = useRef(null);
  const answerRetryTimer = useRef(null);
  const answerRetryRound = useRef(0);
  const [answerRetrySignal, setAnswerRetrySignal] = useState(0);

  /* ------------------------------------------------------- loading the paper */

  const loadAttempt = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (windowRef.current) query.set('window', windowRef.current);
      if (attemptRef.current?.revision) query.set('revision', attemptRef.current.revision);
      const queryText = query.toString();
      const response = await api(`/api/tests/${encodeURIComponent(code)}/attempt${queryText ? `?${queryText}` : ''}`);
      // A 204 is a successful heartbeat: the server confirms that the paper's
      // revision has not changed, without downloading it again.
      if (!response) {
        setOnline(true);
        setSignedOut('');
        return attemptRef.current;
      }
      setAttempt(response.attempt);
      setOnline(true);
      setSignedOut('');
      return response.attempt;
    } catch (error) {
      if (isSignedOut(error)) { setSignedOut(error.message); return null; }
      // The quiz was restarted or reset: this paper is gone.
      if (error.code === 'NO_ATTEMPT') {
        clearCache(storage, attemptIdRef.current);
        void clearDurableCache(durableStorage, code);
        paperGone();
        return null;
      }
      if (isRetryable(error)) {
        setOnline(false);
        // Fall back to the paper this device already holds, so a reload during
        // an outage still shows the test rather than an error.
        const cached = (attemptIdRef.current && loadCache(storage, attemptIdRef.current))
          || loadCacheForCode(storage, code)
          || await loadDurableCache(durableStorage, code);
        if (cached) {
          attemptIdRef.current = cached.attempt.id;
          setAttempt(cached.attempt);
          setPending(cached.pending);
          return cached.attempt;
        }
        return null;
      }
      showToast(error.message);
      return null;
    }
  }, [code, showToast]);

  useEffect(() => { loadAttempt(); }, [loadAttempt]);

  // Remember which attempt this device holds, and drop any older one.
  useEffect(() => {
    if (!attempt?.id) return;
    attemptIdRef.current = attempt.id;
    clearOtherCaches(storage, attempt.id);
    // Departures recorded on an earlier page load that never reached the
    // server - left while offline, then reloaded - still go.
    const stored = readPresence(attempt.id).map((entry) => ({ ...entry, queued: true }));
    if (stored.length) presenceQueue.current = [...stored, ...presenceQueue.current];
    // Skipping was replaced by Reset; drop the old per-device skip list.
    try { storage?.removeItem(`quiz-skipped:${attempt.id}`); } catch { /* storage blocked */ }
  }, [attempt?.id]);

  // Persist the paper and anything unsent on every change.
  useEffect(() => {
    if (!attempt?.id || attempt.status === 'submitted') return;
    saveCache(storage, attempt.id, attempt, pending);
    void saveDurableCache(durableStorage, code, attempt, pending);
  }, [attempt, pending, code]);

  /* ------------------------------------------------- sending queued answers */

  const queueAnswerRetry = useCallback(() => {
    if (answerRetryTimer.current) return;
    const round = answerRetryRound.current;
    answerRetryRound.current += 1;
    answerRetryTimer.current = window.setTimeout(() => {
      answerRetryTimer.current = null;
      setAnswerRetrySignal((value) => value + 1);
    }, retryDelay(round));
  }, []);

  const flush = useCallback(async () => {
    if (flushing.current || !attemptIdRef.current) return;
    const queued = [...pending.entries()];
    if (!queued.length) return;

    flushing.current = true;
    try {
      for (const [questionId, payload] of queued) {
        try {
          const response = await post(`/api/test-attempts/${attemptIdRef.current}/answer`, { ...payload, compact: true });
          setAttempt((current) => mergeAnswerAcknowledgement(current, response));
          setOnline(true);
          answerRetryRound.current = 0;
          if (answerRetryTimer.current) {
            window.clearTimeout(answerRetryTimer.current);
            answerRetryTimer.current = null;
          }
          setPending((current) => {
            const next = new Map(current);
            // Clear it only if nothing newer was queued for this question while
            // the request was in flight.
            if (next.get(questionId) === payload) next.delete(questionId);
            return next;
          });
        } catch (error) {
          if (isOffline(error)) { setOnline(false); queueAnswerRetry(); break; }
          // Not a refusal of the answer: keep it queued until they sign back in.
          if (isSignedOut(error)) { setSignedOut(error.message); queueAnswerRetry(); break; }
          // Paused by the teacher: keep it, and send it once they continue.
          if (error.code === 'PAUSED') { await loadAttempt(); break; }
          if (isPermanentRejection(error.status)) {
            // The server will keep refusing this one: drop it and take its truth.
            setPending((current) => {
              const next = new Map(current);
              next.delete(questionId);
              return next;
            });
            showToast(error.message);
            await loadAttempt();
            continue;
          }
          if (isRetryable(error)) queueAnswerRetry();
          break;
        }
      }
    } finally {
      flushing.current = false;
    }
  }, [pending, loadAttempt, queueAnswerRetry, showToast]);

  // A fast double tap, an MSQ with several choices, or a phone input method
  // can produce several changes in a moment. Keep only the latest value for
  // that question and send it after this short coalescing window.
  useEffect(() => {
    if (!pending.size) { setSaving(false); return undefined; }
    const timer = window.setTimeout(() => { flush().finally(() => setSaving(false)); }, 250);
    return () => window.clearTimeout(timer);
  }, [flush, pending.size, answerRetrySignal]);
  // Continued after a pause: answers held back by it go now.
  useEffect(() => { if (attempt && !attempt.paused) flush(); }, [attempt?.paused]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => {
    if (answerRetryTimer.current) window.clearTimeout(answerRetryTimer.current);
  }, []);

  /**
   * Sends the answer on screen and waits until every queued answer has
   * reached the server - before handing the paper in or moving on - so the
   * last thing typed is never left behind. False if they are still stuck.
   */
  const settleAnswers = useCallback(async (ms = 5_000) => {
    paperFlush.current?.();
    const until = Date.now() + ms;
    await wait(50);
    while (pendingRef.current.size && Date.now() < until) await wait(150);
    return pendingRef.current.size === 0;
  }, []);

  /* ------------------------------------------- sending leave/return events */

  // Presence events queue exactly like answers. Otherwise switching the Wi-Fi
  // off before leaving the app would leave nothing on the record.
  const flushPresence = useCallback(async () => {
    const attemptId = attemptIdRef.current;
    if (sendingPresence.current || !attemptId || !presenceQueue.current.length) return;
    sendingPresence.current = true;
    try {
      while (presenceQueue.current.length) {
        const batch = presenceQueue.current.slice(0, 30);
        try {
          // keepalive lets a final batch finish even as the phone puts the page away.
          const response = await api(`/api/test-attempts/${attemptId}/events`, {
            method: 'POST', body: JSON.stringify({ events: batch }), keepalive: true
          });
          presenceQueue.current.splice(0, Math.min(response.processed || batch.length, batch.length));
          setAttempt((current) => mergeAttemptState(current, response));
          setOnline(true);
        } catch (error) {
          if (isRetryable(error)) {
            presenceQueue.current = presenceQueue.current.map((entry) => ({ ...entry, queued: true }));
            break;
          }
          // Refused for good, e.g. already submitted. It is safe to stop
          // retrying this batch; answers have their own independent queue.
          presenceQueue.current.splice(0, batch.length);
        } finally {
          writePresence(attemptId, presenceQueue.current);
        }
      }
    } finally {
      sendingPresence.current = false;
    }
  }, []);

  const reportPresence = useCallback((body) => {
    presenceQueue.current.push(body);
    writePresence(attemptIdRef.current, presenceQueue.current);
    // Exits go immediately because a hidden phone may suspend timers. Other
    // flags and returns share a short batch window.
    if (body.type === 'exit') flushPresence();
    else {
      window.clearTimeout(presenceFlushTimer.current);
      presenceFlushTimer.current = window.setTimeout(flushPresence, 500);
    }
  }, [flushPresence]);

  // Retry when the browser says the connection is back, and on a slow beat in
  // case that never fires (captive portals, flaky mobile data).
  useEffect(() => {
    const goOnline = () => { setOnline(true); flush(); flushPresence(); };
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    let timer;
    const retryQueued = () => {
      if (pending.size) flush();
      flushPresence();
      timer = window.setTimeout(retryQueued, 25_000 + Math.round(Math.random() * 10_000));
    };
    timer = window.setTimeout(retryQueued, 25_000 + Math.round(Math.random() * 10_000));
    const pageHide = () => flushPresence();
    window.addEventListener('pagehide', pageHide);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('pagehide', pageHide);
      window.clearTimeout(timer);
      window.clearTimeout(presenceFlushTimer.current);
    };
  }, [flush, flushPresence, pending.size]);

  const saveAnswer = useCallback(async (payload) => {
    const { questionId, ...rest } = payload;
    // Show it at once and keep it on this device; the queue does the rest.
    setPending((current) => new Map(current).set(questionId, { questionId, ...rest }));
    setSaving(true);
  }, []);

  /* ---------------------------------------------------------- the attempt UI */

  useEffect(() => {
    if (placed.current || !attempt?.questions || attempt.questionLayout === 'all') return;
    placed.current = true;
    setIndex(landingIndex(attempt.questions));
  }, [attempt]);

  useEffect(() => {
    if (!attempt?.id || attempt.status === 'submitted') return undefined;
    let timer;
    const tick = async () => {
      const fresh = await loadAttempt();
      timer = window.setTimeout(tick, attemptPollDelay(fresh || attemptRef.current));
    };
    timer = window.setTimeout(tick, attemptPollDelay(attemptRef.current));
    return () => window.clearTimeout(timer);
  }, [attempt?.id, attempt?.status, loadAttempt]);

  const attemptId = attempt?.id;
  // The admin turned on "Private window only" and this is a normal window:
  // the paper is covered until it is reopened in Incognito. Leaving this tab
  // to do that is not counted against the student.
  const privateBlocked = Boolean(attempt?.requirePrivateWindow) && !privateExempt && windowKind === 'normal' && attempt?.status !== 'submitted';
  const sitting = Boolean(attemptId) && attempt?.status !== 'submitted' && !privateBlocked;
  // The 5-minute and 1-minute notices are warnings, shown in the warning colour.
  const warnToast = useCallback((title, message) => showToast(message, 'warn', { title }), [showToast]);
  // Fullscreen is required wherever the browser offers it. If it refuses (some
  // in-app browsers do), the refusal is logged and the student carries on.
  // Once the browser has fullscreen, it stays required: a refused request is
  // reported and retried, never a way to carry on outside fullscreen.
  const enforceFullscreen = fullscreenSupported() && !fullscreenUnavailable;
  const [fullscreenRefusals, setFullscreenRefusals] = useState(0);

  // One check at a time. It always finishes: the location gives up after
  // LOCATION_PATIENCE_MS and the report after REPORT_MS. A check that could
  // hang used to hold this flag for good - no check ever ran again, answers
  // were refused as "location unknown", and only a reload let the student
  // submit.
  const checkingLocation = useRef(false);
  const [checkingNow, setCheckingNow] = useState(false);
  // Why the device's location could not be had, and what to do about it.
  const [locationProblem, setLocationProblem] = useState('');
  const checkLocation = useCallback(async (trigger = 'timer') => {
    if (!attemptIdRef.current || !attempt?.locationRequired || checkingLocation.current || document.hidden) return;
    checkingLocation.current = true;
    setCheckingNow(true);
    try {
      let point = {};
      // The browser's own "allow location?" prompt takes focus from the page;
      // answering it is not leaving the test. Only while one can appear -
      // once allowed, a location check shows nothing.
      const prompts = await navigator.permissions?.query?.({ name: 'geolocation' })
        .then((status) => status.state === 'prompt', () => false);
      try {
        point = await (prompts ? withoutAwayCheck(getBrowserLocation) : getBrowserLocation());
        setLocationProblem('');
      } catch (error) { setLocationProblem(error.message); /* reported as inconclusive below */ }
      // Still reported when there is no reading: the server hears from the paper.
      const response = await api(`/api/test-attempts/${attemptIdRef.current}/location`, {
        method: 'POST', body: JSON.stringify({ ...point, trigger }), signal: AbortSignal.timeout?.(REPORT_MS)
      });
      setOnline(true);
      setAttempt((current) => (current ? {
        ...current,
        locationChecks: response.locationChecks,
        venueClosed: response.venue
          ? { reason: response.venue.reason, distanceMeters: response.venue.distanceMeters ?? null, since: response.venue.since || null }
          : null
      } : current));
    } catch (error) {
      if (isRetryable(error)) setOnline(false);
      // Offline, too slow, or the attempt ended; the next check will retry.
    }
    finally {
      checkingLocation.current = false;
      setCheckingNow(false);
    }
  }, [attempt?.locationRequired]);

  const venueClosed = attempt?.venueClosed || null;
  useEffect(() => {
    if (!sitting || !attempt?.locationRequired) return undefined;
    // Shut out: look again soon, so coming back reopens the paper quickly.
    let timer;
    const tick = async () => {
      await checkLocation(venueClosed ? 'blocked' : 'timer');
      timer = window.setTimeout(tick, locationPollDelay(Boolean(venueClosed)));
    };
    timer = window.setTimeout(tick, locationPollDelay(Boolean(venueClosed)));
    return () => window.clearTimeout(timer);
  }, [sitting, attempt?.locationRequired, venueClosed, checkLocation]);

  // Hold back any new version of the app until this paper is submitted.
  useEffect(() => {
    setExamInProgress(sitting);
    return () => setExamInProgress(false);
  }, [sitting]);

  // Locked, then unlocked: tell the away monitor before it starts watching
  // again (this effect runs first), so where the student is right now does
  // not count as leaving.
  const wasLocked = useRef(false);
  useEffect(() => {
    if (wasLocked.current && attempt && !attempt.isLocked && !attempt.paused) markResumed();
    wasLocked.current = Boolean(attempt?.isLocked || attempt?.paused);
  }, [attempt?.isLocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // The screen stays on for the whole paper - locked and away included - so
  // it never dims and locks by itself mid-question.
  useKeepAwake(attempt?.status === 'in_progress');

  const { away, awayReason, recheck } = useAwayMonitor({
    // A locked or paused attempt has no paper on screen, so leaving it is not watched.
    enabled: sitting && !attempt?.isLocked && !attempt?.paused,
    enforceFullscreen,
    serverAway: Boolean(attempt?.isAway),
    onLeave: (detail) => reportPresence({ type: 'exit', detail }),
    onReturn: (durationMs, detail) => {
      reportPresence({ type: 'return', durationMs, detail });
      const current = attemptRef.current;
      // A test that only warns: say so each time, so going past the limit is never silent.
      // ("Lock only" shows no warning: the lock itself is the message.)
      if (current && !current.locksOnViolation && current.warnsOnViolation !== false) {
        const left = current.timesLeft || 0;
        const limit = current.fullscreenExitLimit || 0;
        if (limit > 0 && left > limit) showToast(`Only ${limit} allowed. Your administrator has been told.`, 'warn', { title: `You have left the test ${left} times` });
        else showToast(`${limit > 0 ? `${left} of ${limit} allowed. ` : ''}This is recorded.`, 'warn', { title: 'You left the test' });
      }
    }
  });

  // "Warn, then lock": a numbered warning each time the student goes past a
  // limit, counted by the server, so the lock never comes as a surprise.
  const seenViolations = useRef(null);
  useEffect(() => {
    if (!attempt) return;
    const count = attempt.violationCount || 0;
    const before = seenViolations.current;
    seenViolations.current = count;
    if (before === null || count <= before || attempt.isLocked || !attempt.locksOnViolation) return;
    const warnings = attempt.warningsBeforeLock || 0;
    if (warnings > 0 && count <= warnings) {
      showToast(count === warnings
        ? 'You went past the limit for leaving the test. Next time, it locks until your administrator approves it.'
        : `You went past the limit for leaving the test. After ${warnings} warnings, it locks.`, 'warn',
      { title: count === warnings ? `Last warning (${count} of ${warnings})` : `Warning ${count} of ${warnings}` });
    }
  }, [attempt?.violationCount, attempt?.isLocked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Text arriving in an answer all at once: on the record against its question,
  // and the student is reminded - not more than every 20 seconds.
  const burstWarnedAt = useRef(0);
  const onTextBurst = useCallback((questionId, chars) => {
    reportPresence({ type: 'flag', detail: 'text_burst', questionId, chars });
    if (Date.now() - burstWarnedAt.current < 20_000) return;
    burstWarnedAt.current = Date.now();
    showToast('Answers pasted in are recorded, and your administrator sees them.', 'warn', { title: 'Text appeared all at once' });
  }, [reportPresence, showToast]);

  // A browser extension changing the paper: on the record each time it shows
  // something new (a few at most), and a notice above the paper that stays -
  // a message that fades would be gone at the first tap.
  const extensionReports = useRef(0);
  const [extensionSeen, setExtensionSeen] = useState(false);
  useExtensionWatch({
    enabled: sitting,
    onFound: (note) => {
      extensionReports.current += 1;
      setExtensionSeen(true);
      if (extensionReports.current <= 5) reportPresence({ type: 'flag', detail: 'extension', note });
    }
  });

  useClipboardGuard({
    enabled: sitting && !attempt?.isLocked,
    onFlag: (detail) => { reportPresence({ type: 'flag', detail }); warnFlag(detail); },
    // Hide the paper, so the screen being captured shows nothing: while the
    // Windows / Cmd key is held, and for a moment after a capture key.
    onScreenshot: (phase) => {
      window.clearTimeout(shieldTimer.current);
      setShielded(true);
      // Even while a key is held, the shield lets go on its own: a key-up that
      // never arrives (the Windows key opens the Start menu) must not leave
      // the paper covered.
      shieldTimer.current = window.setTimeout(() => setShielded(false), phase === 'hold' ? 10_000 : phase === 'release' ? 800 : 2_500);
    }
  });
  useEffect(() => () => window.clearTimeout(shieldTimer.current), []);

  // Any sign of life uncovers the paper again.
  useEffect(() => {
    if (!shielded) return undefined;
    const uncover = () => { window.clearTimeout(shieldTimer.current); setShielded(false); };
    const events = ['pointerdown', 'keyup', 'focus', 'visibilitychange'];
    events.forEach((name) => window.addEventListener(name, uncover, true));
    return () => events.forEach((name) => window.removeEventListener(name, uncover, true));
  }, [shielded]);

  // Mouse, finger and scroll only; keys work just for typing a short answer.
  useKeyboardLockdown({
    enabled: sitting && !attempt?.isLocked,
    onFlag: (detail) => { reportPresence({ type: 'flag', detail }); warnFlag(detail); }
  });

  const resume = async () => {
    if (enforceFullscreen && !inFullscreen() && !(await requestTestFullscreen())) {
      // Refused (a browser built into an app, or a tap the browser did not
      // trust): recorded once, and the gate says so and, after two, offers a way on.
      if (!fullscreenRefusals) reportPresence({ type: 'flag', detail: 'fullscreen_denied' });
      setFullscreenRefusals((count) => count + 1);
      return;
    }
    window.focus();
    // The student says they are back: look again once the window has settled,
    // and say what still stands in the way - never a button that does nothing.
    window.setTimeout(() => {
      if (recheck() === 'split_screen') {
        showToast('Close split screen or the other app, or make this window full size, to continue.', 'warn', { title: 'The test needs the whole screen' });
      }
    }, 400);
  };
  // After the browser refused fullscreen twice: carry on without it, recorded,
  // as on an iPhone. Leaving the test is still watched in every other way.
  const skipFullscreen = () => {
    setFullscreenUnavailable(true);
    recheck();
  };

  const questions = useMemo(() => applyPending(attempt?.questions, pending), [attempt?.questions, pending]);
  const showAll = attempt?.questionLayout === 'all';
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))];
  const openCount = questions.filter((question) => !question.answered).length;
  const scrollToQuestion = (target) => {
    const node = document.getElementById(`question-${questions[target]?.id}`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submit = async () => {
    if (submitting) return;
    // Something happens the moment Submit is tapped, even before the question.
    setSubmitting('preparing');
    // Where the student was when they handed it in, for the admin's record -
    // never worth holding the submit for: a moment at most.
    if (attempt?.locationRequired) await Promise.race([checkLocation('submit'), wait(SUBMIT_LOCATION_MS)]);
    if (!(await settleAnswers())) {
      setSubmitting(false);
      return showToast('Stay on this page until they send, then submit.', 'warn', { title: 'Some answers are still sending' });
    }
    // Under strict timing only the open question is on the page; the rest
    // are counted from the attempt.
    const unanswered = attempt.strict
      ? attempt.strict.total - attempt.answeredQuestionCount
      : questions.filter((question) => !question.answered).length;
    const confirmed = await askToConfirm({
      title: 'Submit your test?',
      message: unanswered
        ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} not answered${attempt.strict ? ' or not reached yet' : ''}. You cannot change anything after submitting.`
        : 'You cannot change your answers after submitting.',
      confirmLabel: 'Submit test',
      danger: unanswered > 0
    });
    if (!confirmed) { setSubmitting(false); return; }

    setSubmitting('sending');
    flushPresence();
    try {
      // When the whole class submits in the same minute, a request can fail
      // for no fault of the student's. Submitting twice is harmless - the
      // server finalises once - so keep trying for a while before giving up.
      let response;
      for (let round = 0; !response; round += 1) {
        try {
          response = await post(`/api/test-attempts/${attempt.id}/submit`);
        } catch (error) {
          if (!isRetryable(error) || round >= 6) throw error;
          await wait(Math.min(8_000, 1_000 * 2 ** round) * (0.5 + Math.random()));
        }
      }
      clearCache(storage, attempt.id);
      void clearDurableCache(durableStorage, code);
      writePresence(attempt.id, []);
      setAttempt(response.attempt);
    } catch (error) {
      if (isSignedOut(error)) setSignedOut(error.message);
      else showToast(error.message);
      setSubmitting(false);
    }
  };

  // Time's up: send whatever is still queued, then hand the paper in. If this
  // fails (offline, locked), the server submits it anyway once the grace ends,
  // and the background refresh picks that up.
  const [timeUp, setTimeUp] = useState(false);
  const autoSubmitting = useRef(false);
  const autoSubmit = useCallback(async () => {
    if (attemptRef.current?.paused) return;
    setTimeUp(true);
    if (autoSubmitting.current || !attemptIdRef.current) return;
    autoSubmitting.current = true;
    try {
      // The server leaves a 90-second grace for answers already on their way.
      // Spreading this first request over a few seconds turns a 3,000-student
      // connection spike into a steady stream without changing anyone's time.
      await wait(Math.round(Math.random() * AUTO_SUBMIT_JITTER_MS));
      if (!attemptRef.current?.timeOver || attemptRef.current?.status !== 'in_progress') {
        setTimeUp(false);
        return;
      }
      await flush();
      flushPresence();
      for (let round = 0; round < 4; round += 1) {
        try {
          const response = await post(`/api/test-attempts/${attemptIdRef.current}/submit`);
          clearCache(storage, attemptIdRef.current);
          void clearDurableCache(durableStorage, code);
          writePresence(attemptIdRef.current, []);
          setAttempt(response.attempt);
          return;
        } catch (error) {
          if (!isRetryable(error)) break;
          await wait(retryDelay(round));
        }
      }
      await loadAttempt();
    } finally {
      autoSubmitting.current = false;
    }
  }, [code, flush, flushPresence, loadAttempt]);
  useEffect(() => { if (attempt?.timeOver && attempt.status === 'in_progress') autoSubmit(); }, [attempt?.timeOver, attempt?.status, autoSubmit]);
  // An extension while the gate is up gives the paper back.
  useEffect(() => { if (attempt?.status === 'in_progress' && !attempt.timeOver && !autoSubmitting.current) setTimeUp(false); }, [attempt]);

  // Strict timing: close this question and open the next - by the student's
  // Next, or by its clock. The answer on screen is sent first; the question
  // id tells the server which one we mean, so a repeat never skips one.
  const moving = useRef(false);
  const [movingOn, setMovingOn] = useState(false);
  const goNext = useCallback(async (questionId, { auto = false } = {}) => {
    if (moving.current || !attemptIdRef.current) return;
    moving.current = true;
    setMovingOn(true);
    // The answer on screen goes with the move itself - one request, not a
    // save and then a move. A save already on its way lands first, so it can
    // never arrive after the question has closed.
    for (const until = Date.now() + 3_000; flushing.current && Date.now() < until;) await wait(25);
    const typed = paperDraft.current?.();
    const queued = pendingRef.current.get(questionId);
    const carried = typed ? { questionId, ...typed } : queued || null;
    if (queued) {
      setPending((current) => {
        if (current.get(questionId) !== queued) return current;
        const next = new Map(current);
        next.delete(questionId);
        return next;
      });
    }
    try {
      const response = await post(`/api/test-attempts/${attemptIdRef.current}/next`, carried ? { questionId, answer: carried } : { questionId });
      if (response.attempt.status === 'submitted') {
        clearCache(storage, attemptIdRef.current);
        void clearDurableCache(durableStorage, code);
        writePresence(attemptIdRef.current, []);
      }
      setAttempt(response.attempt);
      // Time ran out: a warning only when it cost the student something - the
      // question was left blank. An answered one simply moves on, and the last
      // one lands on the result, which says the test was submitted.
      if (auto && response.attempt.status !== 'submitted') {
        const answered = carried ? hasContent(carried) : Boolean(attemptRef.current?.questions?.find((question) => question.id === questionId)?.answered);
        if (!answered) showToast('It was left unanswered. Here is the next question.', 'warn', { title: 'Time is up for that question' });
      }
    } catch (error) {
      // Not delivered: the answer goes back in the queue, so it is not lost.
      if (carried && (isRetryable(error) || isSignedOut(error))) {
        setPending((current) => (current.has(questionId) ? current : new Map(current).set(questionId, carried)));
      }
      if (isSignedOut(error)) setSignedOut(error.message);
      else if (isOffline(error)) showToast('Your test moves on as soon as it is back.', 'warn', { title: 'No connection' });
      else { showToast(error.message); await loadAttempt(); }
    } finally {
      moving.current = false;
      setMovingOn(false);
    }
  }, [code, loadAttempt, showToast]);

  const signedBackIn = async () => {
    setSignedOut('');
    await loadAttempt();
    flush();
    flushPresence();
  };

  const loadResult = useCallback(async (attemptId) => {
    try {
      const next = (await api(`/api/test-attempts/${attemptId}/result`)).result;
      // The administrator resumed a test they closed by mistake: back to the paper, where it was.
      // Wherever the student is now (out of fullscreen, say) is not them leaving the test.
      if (next.reopened) {
        markResumed();
        showToast('Your teacher reopened the test. Carry on where you were.', 'info', { title: 'Test resumed' });
        await loadAttempt();
        return;
      }
      setResult(next);
    } catch (error) {
      if (error.code === 'NO_ATTEMPT') paperGone();
      else if (!isOffline(error)) showToast(error.message);
    }
  }, [showToast, loadAttempt]);

  useEffect(() => { if (attempt?.status === 'submitted') loadResult(attempt.id); }, [attempt?.id, attempt?.status, loadResult]);
  // Checked until the marks arrive - and, for a paper the teacher's Close
  // handed in, a little longer, in case the Close was a mistake and they resume.
  const closedByTeacher = result?.submittedBy === 'admin';
  useEffect(() => {
    if (!attempt?.id || attempt.status !== 'submitted' || result?.wasReset) return undefined;
    if (result?.released && !closedByTeacher) return undefined;
    const timer = window.setInterval(() => loadResult(attempt.id), result?.released ? 15_000 : 7_000);
    return () => window.clearInterval(timer);
  }, [attempt?.id, attempt?.status, result, closedByTeacher, loadResult]);

  if (!attempt) return <div className="empty card">Loading your paper…</div>;
  if (attempt.status === 'submitted') return <ResultScreen result={result}/>;
  if (privateBlocked) return <PrivateWindowRequired test={{ code, title: attempt.title }} showToast={showToast} onDeclare={onDeclareWindow} midTest/>;
  if (attempt.paused) return <PausedAttempt attempt={attempt} reload={loadAttempt}/>;
  if (attempt.isLocked) return <LockedAttempt attempt={attempt} reload={loadAttempt}/>;
  if (!current) return <div className="empty card">Preparing your questions…</div>;

  const strict = attempt.strict || null;
  const answeredCount = strict ? attempt.answeredQuestionCount : questions.length - openCount;
  const totalCount = strict ? strict.total : questions.length;
  const isLastStrict = strict && strict.index >= strict.total - 1;
  const strictNext = async () => {
    const request = isLastStrict
      ? { title: 'Submit your test?', message: current.answered ? 'You cannot change your answers after submitting.' : 'This question is not answered.', confirmLabel: 'Submit test', danger: !current.answered }
      : (current.answered ? null : { title: 'Skip this question?', message: 'You cannot come back to it.', confirmLabel: 'Skip it', cancelLabel: 'Stay here', danger: true });
    if (request && !(await askToConfirm(request))) return;
    goNext(current.id);
  };

  const selectQuestion = (target) => {
    setIndex(target);
    checkLocation('question');
  };
  const move = (step) => setIndex((value) => {
    const next = Math.min(questions.length - 1, Math.max(0, value + step));
    if (next !== value) checkLocation('question');
    return next;
  });

  return (
    <section className={`exam-screen exam-protected${showAll ? ' is-list' : ''}`}>
      <ExamHeader
        attempt={attempt}
        strict={strict}
        away={away}
        answeredCount={answeredCount}
        totalCount={totalCount}
        onTestExpire={autoSubmit}
        onQuestionExpire={() => goNext(current.id, { auto: true })}
        onWarn={warnToast}
      />

      {strict
        ? <StrictDots strict={strict}/>
        : <QuestionPalette questions={questions} currentIndex={showAll ? -1 : current.index} onSelect={showAll ? scrollToQuestion : selectQuestion}/>}

      <div className="exam-notices">
        <ConnectionNotice online={online} unsent={pending.size}/>
        {extensionSeen && (
          <p className="notice danger" role="status">
            <strong>A browser extension is changing this page.</strong> Turn extensions off, or take the test in a private (Incognito) window. This is recorded.
          </p>
        )}

      </div>
      {confirmRequest && !timeUp && !signedOut && <ConfirmGate request={confirmRequest} onAnswer={answerConfirm}/>}
      {timeUp && !signedOut && <TimeUpGate unsent={pending.size} answered={answeredCount} total={totalCount} online={online}/>}
      {signedOut && <SignedOutGate message={signedOut} microsoft={microsoft} onSignedIn={signedBackIn} showToast={showToast}/>}
      {!signedOut && !timeUp && away && <AwayGate attempt={attempt} split={awayReason === 'split_screen'} starting={awayReason === 'begin'}needsFullscreen={enforceFullscreen && !inFullscreen()} refusals={fullscreenRefusals} onResume={resume} onSkipFullscreen={skipFullscreen}/>}
      {!away && venueClosed && (
        <VenueGate
          venue={venueClosed}
          radiusMeters={attempt.locationRadiusMeters}
          checking={checkingNow}
          problem={locationProblem}
          onCheck={() => checkLocation('manual')}
        />
      )}

      <div className={`exam-body${shielded ? ' is-shielded' : ''}`}>
        {shielded && (
          <div className="screenshot-shield" role="alert">
            <strong>Screenshots are not allowed</strong>
            <span>This was recorded and your administrator can see it.</span>
          </div>
        )}
        {showAll
          ? <QuestionList questions={questions} onSave={saveAnswer} onTextBurst={onTextBurst}/>
          : <QuestionPaper key={current.id} question={current} total={totalCount} onSave={saveAnswer} flushRef={strict ? paperFlush : undefined} draftRef={strict ? paperDraft : undefined} onTextBurst={onTextBurst}/>}
        {strict && movingOn && (
          <div className="strict-switching" role="status">{isLastStrict ? 'Submitting your paper…' : 'Opening the next question…'}</div>
        )}
      </div>

      {strict ? (
        <footer className="exam-foot strict-foot">
          {(!strict.canMoveOn || !isLastStrict) && (
            <button className="exam-submit is-secondary" type="button" disabled={movingOn || Boolean(submitting)} onClick={submit}>
              {submitting === 'sending' ? 'Submitting…' : submitting ? 'Please wait…' : 'Submit test'}
            </button>
          )}
          {strict.canMoveOn && (
            <button className="exam-submit" type="button" disabled={movingOn || submitting} onClick={strictNext}>
              {isLastStrict ? 'Finish & submit' : 'Next question →'}
            </button>
          )}
        </footer>
      ) : (
      <footer className="exam-foot">
        {!showAll && (
          <button className="exam-arrow" type="button" aria-label="Previous question" disabled={current.index === 0} onClick={() => move(-1)}>
            <Arrow back/>
          </button>
        )}
        <button className="exam-submit" type="button" disabled={Boolean(submitting)} onClick={submit}>
          {submitting === 'sending' ? 'Submitting…' : submitting ? 'Please wait…' : 'Submit test'}
        </button>
        {!showAll && (
          <button className="exam-arrow is-next" type="button" aria-label="Next question" disabled={current.index === questions.length - 1} onClick={() => move(1)}>
            <Arrow/>
          </button>
        )}
      </footer>
      )}
    </section>
  );
}
