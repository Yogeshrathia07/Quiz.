import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { liveEventsFromPayload, useLiveUpdate } from '../../lib/live-updates.js';
import { leavingRules } from './leaving-rules.js';
import { PrivateWindowRequired } from './PrivateWindowRequired.jsx';
import { DeviceNotAllowed } from './DeviceNotAllowed.jsx';
import { deviceRefused, useDeviceCheck } from '../../lib/device.js';
import { ServerOff } from 'lucide-react';
import { SERVER_REACH_EVENT, api, isOffline, isSignedOut, post } from '../../lib/api.js';
import { AuthForm } from '../../components/AuthForm.jsx';
import {
  fullscreenSupported, inFullscreen, markResumed, requestTestFullscreen, useAwayMonitor, useClipboardGuard, useKeyboardLockdown, withoutAwayCheck
} from '../../lib/useAwayMonitor.js';
import {
  applyPending, clearCache, clearDurableCache, clearOtherCaches, createDebouncedDurableCacheWriter, isPermanentRejection, loadCache, loadCacheForCode,
  loadDurableCache, mergeAnswerAcknowledgement, mergeAttemptState, retryDelay, saveCache
} from '../../lib/offline-answers.js';
import { setExamInProgress } from '../../lib/useAppUpdate.js';
import { serverNow } from '../../lib/server-clock.js';
import { canOpenSealed, openSealed } from '../../lib/paper-seal.js';
import { useKeepAwake } from '../../lib/keep-awake.js';
import { getBrowserLocation } from '../../lib/geo.js';
import { LocationHelp } from '../../components/LocationCheck.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { centerCurrentQuestion, QuestionPalette } from './QuestionPalette.jsx';
import { QuestionPaper } from './QuestionPaper.jsx';
import { QuestionList } from './QuestionList.jsx';
import { ExamSplitDivider } from './ExamSplitDivider.jsx';
import { DEFAULT_EXAM_SPLIT } from './exam-split.js';
import { LockedAttempt, PausedAttempt } from './StatusScreens.jsx';
import { ResultScreen } from './ResultScreen.jsx';
import { ExamHeader } from './ExamHeader.jsx';
import { loadImage, useImagesSettled } from '../../components/QuestionImage.jsx';
import { SubmissionProgress } from './SubmissionProgress.jsx';
import { createSubmissionFlight, retrySubmission } from './submission-progress.js';

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
  // SSE carries ordinary admin changes in well under a second. Polling stays
  // as a safety net for a proxy that blocks EventSource, but must remain below
  // the server's 60 s offline threshold even on a quiet paper.
  if (attempt?.isLocked || attempt?.paused) return 12_000 + Math.round(random * 4_000);
  if (hidden) return 36_000 + Math.round(random * 8_000);
  const deadline = Date.parse(attempt?.endsAt || attempt?.deadlineAt || '');
  if (Number.isFinite(deadline) && deadline - Date.now() < 2 * 60_000) return 12_000 + Math.round(random * 5_000);
  return 32_000 + Math.round(random * 8_000);
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
/** As the server (attempt-service KEYBOARD_GRACE_MS): leaving while typing, back this quickly, is a note. */
const KEYBOARD_GRACE_MS = 15_000;
const KEYBOARD_NOTES_MAX = 3;
/** Left the paper while the server was out of reach: back within this long of it answering again, it never counts. */
const OUTAGE_RETURN_GRACE_MS = 30_000;
/** A departure this soon before the first ask the server did not answer began in the outage (its report was that ask). */
const OUTAGE_LEAVE_SLACK_MS = 3_000;
/** Avoid every timed paper opening one connection on the exact same millisecond. */
const AUTO_SUBMIT_JITTER_MS = 8_000;
/**
 * Strict timing: moving on waits this long for an answer before asking again.
 * A reply stuck on a weak connection used to hold the next question back for
 * the browser's 25 seconds - while its clock ran on the server.
 */
const MOVE_TIMEOUT_MS = 8_000;
// A timed one-way paper (a timer on each question): the next questions
// travel ahead sealed, fetched this long after each change (not to compete with
// it), and the next one's key is asked for this long before the open one ends -
// the server gives it in the last 1.5 s (src/domain/paper-seal.js).
const AHEAD_FETCH_DELAY_MS = 600;
// Spread over the first moments of a question, so a class whose questions all
// change together does not ask at the same instant.
const AHEAD_SPREAD_MS = 4_000;
const AHEAD_COUNT = 3;
const KEY_ASK_LEAD_MS = 1_300;
const KEY_TIMEOUT_MS = 2_000;

/**
 * The paper as this screen shows it while a move made here is still on its way:
 * the next question - opened from its sealed copy the instant the last one ran
 * out - with its whole time. As soon as the server's paper has moved past the
 * question it left (or anything else changed it), the server's paper is shown.
 */
function earlyView(attempt, early) {
  if (!attempt || !early || attempt.status !== 'in_progress' || !attempt.strict || attempt.paused || attempt.isLocked) return attempt;
  const strict = attempt.strict;
  if ((strict.index ?? 0) !== early.fromIndex) return attempt;
  const index = early.fromIndex + 1;
  return {
    ...attempt,
    questions: [early.question],
    strict: {
      ...strict,
      index,
      reached: Math.max(strict.reached ?? index, index + 1),
      questionEndsAt: early.endsAt,
      questionSeconds: early.seconds || null,
      questionLeftSeconds: early.seconds || null,
      questionPaused: false,
      shownPending: false,
      laterSeconds: Math.max(0, (strict.laterSeconds || 0) - (early.seconds || 0)),
      // The question left ran out, so Previous leads where it led from there.
      forwardTo: index + 1 < strict.total ? index + 1 : null,
      track: [...(strict.track || []).slice(0, early.fromIndex), { answered: early.answered, final: true, timedOut: true }, { answered: false, final: false, timedOut: false }],
      closed: [...(strict.closed || []), { how: 'time' }]
    }
  };
}
/** Telling the server the paper is on screen is worth this long, a few times, within the shown grace. */
const SHOWN_TIMEOUT_MS = 6_000;
/** Worth trying again: the connection dropped, or the server was momentarily overloaded. */
const isRetryable = (error) => isOffline(error) || isSignedOut(error) || error.status >= 500 || error.status === 429 || error.status === 408;
// These events change what a student is permitted to see or do. Activity
// frames (answer_saved, location, integrity) are for the administrator only;
// re-fetching a complete paper for each of those was needless traffic.
/** These change what a handed-in paper's result shows: its marks released, or a mark given. */
const RESULT_REFRESH_EVENTS = new Set(['results_released', 'marks_updated']);
const PAPER_REFRESH_EVENTS = new Set([
  'resync', 'stream_reconnected', 'time_changed', 'test_settings_changed', 'test_closed', 'test_reopened',
  'quiz_restarted', 'test_reset', 'attempts_restarted', 'attempts_bulk_updated',
  'attempt_revived', 'attempt_restarted', 'attempt_paused', 'attempt_continued',
  'attempt_submitted', 'registration_changed', 'location_override', 'results_released', 'paper_reopened'
]);

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

/**
 * Strict timing: where the student is on the paper, and each question opened
 * so far - answered (blue) or not (grey), however it closed: by Next or by
 * its clock. Where the test lets students go back, a question that still has
 * time is a button that opens it again; nothing else here can be clicked.
 * `answered`: whether the open question is answered, as this screen has it.
 */
function StrictDots({ strict, answered: openAnswered, disabled, onGo }) {
  const rail = useRef(null);
  useEffect(() => { centerCurrentQuestion(rail.current); }, [strict.index]);
  const reached = strict.reached ?? strict.index + 1;
  return (
    <div className="q-dots strict-dots" role="group" aria-label={`Question ${strict.index + 1} of ${strict.total}`} ref={rail}>
      {Array.from({ length: strict.total }, (_unused, position) => {
        const open = position === strict.index;
        // A page from before `track` (cached across an update): only whether each one closed.
        const dot = strict.track ? strict.track[position] : strict.closed?.[position] && { answered: false, final: true };
        const seen = open || (position < reached && Boolean(dot));
        const answered = open ? openAnswered : Boolean(dot?.answered);
        const state = !seen ? 'not reached yet'
          : `${open ? 'open now, ' : ''}${answered ? 'answered' : 'not answered'}${!open && dot?.timedOut ? ', time ran out' : ''}`;
        // Colour says answered or not; whether it can open again shows as a button (can-go), never as grey.
        const classes = ['q-dot', answered ? 'is-done' : seen && !open ? 'is-missed' : '', open ? 'is-current' : ''].filter(Boolean).join(' ');
        if (strict.previous && seen && !open && !dot?.final) {
          return (
            <button key={position} type="button" className={`${classes} can-go`} disabled={disabled} onClick={() => onGo(position)}
              aria-label={`Question ${position + 1}, ${state}. Go back to it`}>
              {position + 1}
            </button>
          );
        }
        return (
          <span key={position} className={classes} title={seen && !open ? (answered ? 'Answered' : 'Not answered') : undefined} aria-current={open ? 'step' : undefined}>
            {position + 1}<span className="sr-only">, {state}</span>
          </span>
        );
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
function TimeUpGate({ unsent, online }) {
  return <SubmissionProgress automatic phase={!online ? 'retrying' : unsent ? 'saving' : 'sending'} unsent={unsent}/>;
}

/**
 * Every tap on an option queues an answer for a split second, shown beside
 * its question as "Saving…". Only sending that is really stuck - longer than
 * slow classroom Wi-Fi takes for one save - says so in amber.
 */
const STUCK_AFTER_MS = 8_000;

/** Blocked actions the student is warned about. A refused fullscreen is the browser's doing, not theirs. */
const FLAG_WARNINGS = {
  copy: 'Copying is not allowed',
  cut: 'Cutting text is not allowed',
  paste: 'Pasting is not allowed',
  drop: 'Dragging text in is not allowed',
  context_menu: 'That menu is not allowed',
  print: 'Printing is not allowed'
};
// Whether an answer carried with a move has anything in it (a cleared one does not).
const hasContent = (answer) => Boolean((answer?.answerText || '').trim() || answer?.selectedOptions?.length);

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
/**
 * The test server is out of reach (its tunnel answers for it - not this
 * device's own connection): the paper waits, blurred behind this, every clock
 * held (ExamHeader), until the server answers again. The server pauses every
 * paper too, and gives the time back (reachability.js).
 */
function ServerOfflineGate() {
  return (
    <div className="away-gate server-gate" role="alertdialog" aria-modal="true" aria-labelledby="server-gate-title" aria-describedby="server-gate-what">
      <div className="away-gate-card card">
        <span className="server-gate-icon" aria-hidden="true"><ServerOff size={30}/></span>
        <p className="eyebrow">Test paused</p>
        <h2 id="server-gate-title">The test server is offline</h2>
        <p id="server-gate-what">Everyone's test is paused and your time is stopped. When the server is back you carry on from where you were, with the time you had left.</p>
        <p className="help">Your answers are kept on this device. Keep this page open.</p>
        <p className="server-gate-status" role="status"><span className="server-gate-dot" aria-hidden="true"/>Reconnecting…</p>
      </div>
    </div>
  );
}

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
        <p className="away-gate-line">
          <span>{pastLimit(attempt)
            ? `You have left the test ${attempt.timesLeft} times, more than the ${attempt.fullscreenExitLimit} allowed.`
            : 'You left the test. This is recorded.'}</span>
          {line && <InfoTip label="Your leaving allowance">{line}</InfoTip>}
        </p>
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
        <LocationHelp problem={problem}/>
        <p className="away-gate-line help">
          <span>Your answers are safe.</span>
          <InfoTip label="About the venue check">The check runs again every few seconds. Your paper and your answers are safe, your time keeps running, and this is recorded for your administrator.</InfoTip>
        </p>
        <button className="button button-primary button-wide" type="button" disabled={checking} onClick={onCheck}>
          {checking ? 'Checking…' : 'Check my location now'}
        </button>
      </div>
    </div>
  );
}

export function AttemptScreen({ code, initialAttempt = null, microsoft = null, showToast, onPaperGone = () => {}, windowKind, privateExempt = false, onDeclareWindow = () => {} }) {
  // Sent with every poll, so a private-window rule switched on mid-test is
  // recorded against the window the paper is actually in.
  const windowRef = useRef(windowKind);
  windowRef.current = windowKind;
  const [attempt, setAttempt] = useState(() => initialAttempt || null);
  const [result, setResult] = useState(null);
  const [index, setIndex] = useState(0);
  // A layout preference only: it does not alter answers or test timing.
  const [examSplit, setExamSplit] = useState(DEFAULT_EXAM_SPLIT);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submissionProblem, setSubmissionProblem] = useState(null);
  // State disables the controls; the ref also catches two taps before React renders.
  const manualSubmission = useRef(null);
  const strictConfirming = useRef(false);
  const submissionFlight = useRef(createSubmissionFlight());
  const submissionMounted = useRef(true);
  useEffect(() => {
    submissionMounted.current = true;
    return () => {
      submissionMounted.current = false;
      if (manualSubmission.current) manualSubmission.current.cancelled = true;
    };
  }, []);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  // The test server out of reach, this device online (ServerOfflineGate): the paper paused until it answers.
  const [serverDown, setServerDown] = useState(false);
  const [pending, setPending] = useState(() => new Map());
  useEffect(() => {
    if (submitting === 'preparing' && pending.size) setSubmitting('saving');
  }, [submitting, pending.size]);
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
  const loadInFlight = useRef(null);
  const loadAgain = useRef(false);
  const usedInitialAttempt = useRef(Boolean(initialAttempt));
  const durableWriter = useRef(null);
  // Strict timing: the move to the next question that could not reach the
  // server yet ({ questionId, auto }), tried again as soon as it can be.
  const pendingMove = useRef(null);
  const moveRetryTimer = useRef(null);
  const moveRetryRound = useRef(0);
  const retryMove = useRef(null);
  // Strict timing: the question whose time ran out on this screen. It is
  // final from here on, even while the move waits for the connection.
  const [expiredId, setExpiredId] = useState(null);
  // A timed one-way paper: the next few questions, sealed, fetched while the
  // student works (lib/paper-seal.js) ...
  const aheadRef = useRef(new Map());
  const [aheadSize, setAheadSize] = useState(0);
  // ... the next one, opened with the key given in this question's last moments ...
  const [upcoming, setUpcoming] = useState(null);
  // ... and that next question, shown from the moment this one ran out until
  // the server confirms the move ({ fromIndex, question, seconds, endsAt }).
  const [early, setEarly] = useState(null);
  const earlyRef = useRef(null);
  earlyRef.current = early;
  // The questions this screen opened early: each was on it from the moment
  // its clock started, so there is no "on screen" to tell the server.
  const shownEarlyIds = useRef(new Set());
  // The venue check, for code above where it is defined.
  const checkLocationRef = useRef(null);
  // Answers this device still held for the paper, put back after a reload.
  const [restoredId, setRestoredId] = useState(null);
  const clearDurable = useCallback(() => {
    const writer = durableWriter.current;
    return writer ? writer.clear() : clearDurableCache(durableStorage, code);
  }, [code]);

  // localStorage remains immediate for a just-typed answer. IndexedDB is a
  // slower second durable copy, so coalesce its repeated snapshots while
  // retaining strict write/clear ordering around a submission or reset.
  useEffect(() => {
    const writer = createDebouncedDurableCacheWriter(durableStorage, code);
    durableWriter.current = writer;
    return () => {
      if (durableWriter.current === writer) durableWriter.current = null;
      void writer.dispose();
    };
  }, [code]);

  /* ------------------------------------------------------- loading the paper */

  const loadAttempt = useCallback(async () => {
    if (loadInFlight.current) {
      loadAgain.current = true;
      return loadInFlight.current;
    }
    let job;
    job = (async () => {
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
        // Handed in, and open again: the teacher reopened this paper (or resumed
        // the test that closed it). Back to the paper, and why. Wherever the
        // student is now (out of fullscreen, say) is not them leaving the test.
        const before = attemptRef.current;
        if (before?.id === response.attempt.id && before.status === 'submitted' && response.attempt.status === 'in_progress') {
          markResumed();
          showToast('Your teacher reopened your paper. Carry on where you left off.', 'info', { title: 'Paper reopened' });
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
          void clearDurable();
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
    })();
    loadInFlight.current = job;
    try { return await job; }
    finally {
      if (loadInFlight.current === job) {
        loadInFlight.current = null;
        if (loadAgain.current) {
          loadAgain.current = false;
          window.setTimeout(() => { void loadAttempt(); }, 0);
        }
      }
    }
  }, [code, showToast, clearDurable, paperGone]);

  useEffect(() => {
    if (usedInitialAttempt.current) {
      usedInitialAttempt.current = false;
      return undefined;
    }
    void loadAttempt();
    return undefined;
  }, [loadAttempt]);
  // Which device the paper is open on, reported for the teacher; on a phones-
  // or laptops-only test, the paper is covered on any other kind of device.
  // Asked again when the rule changes or the teacher allows this device.
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const deviceCheck = useDeviceCheck(code, {
    stage: 'paper',
    enabled: Boolean(attempt?.id) && attempt?.status === 'in_progress',
    refreshKey: `${attempt?.devices || 'any'}:${deviceRefresh}`
  });
  const streamLive = useLiveUpdate(
    attempt?.id ? `/api/tests/${encodeURIComponent(code)}/events` : null,
    (payload) => {
      const events = liveEventsFromPayload(payload);
      if (events.some((event) => event?.kind === 'device_override' || event?.kind === 'test_settings_changed')) setDeviceRefresh((value) => value + 1);
      if (events.some((event) => PAPER_REFRESH_EVENTS.has(event?.kind))) void loadAttempt();
      // A handed-in paper: marks released, or a mark given, show at once.
      if (attempt?.status === 'submitted' && events.some((event) => RESULT_REFRESH_EVENTS.has(event?.kind))) void loadResult(attempt.id);
    },
    Boolean(attempt?.id)
  );

  // The live stream dropped (the quickest sign the server went out of reach): ask at once, rather than at the next
  // check-in - the reply, or the tunnel's error page in its place, says which it is.
  const wasLive = useRef(false);
  useEffect(() => {
    if (wasLive.current && !streamLive && attemptRef.current?.status === 'in_progress') void loadAttempt();
    wasLive.current = streamLive;
  }, [streamLive, loadAttempt]);
  // Every reply says whether the server answered. Its tunnel answering for it twice running - a lone error page may
  // be a blip, so a second ask follows a moment later - pauses the paper; the server answering again carries on.
  const unreachableRun = useRef(0);
  // When this run of unanswered asks began: the server went out of reach then, near enough (the live stream
  // dropping asks at once, and so does a departure's own report).
  const unreachableSince = useRef(null);
  useEffect(() => {
    let confirm = null;
    const onReach = (event) => {
      if (event.detail?.reached) {
        unreachableRun.current = 0;
        unreachableSince.current = null;
        window.clearTimeout(confirm);
        confirm = null;
        setServerDown(false);
        return;
      }
      if (unreachableRun.current === 0) unreachableSince.current = Date.now();
      unreachableRun.current += 1;
      if (unreachableRun.current >= 2) { setServerDown(true); return; }
      window.clearTimeout(confirm);
      confirm = window.setTimeout(() => { void loadAttempt(); }, 1_200);
    };
    window.addEventListener(SERVER_REACH_EVENT, onReach);
    return () => { window.removeEventListener(SERVER_REACH_EVENT, onReach); window.clearTimeout(confirm); };
  }, [loadAttempt]);
  // A paper no longer being written has nothing to pause.
  const paused = serverDown && attempt?.status === 'in_progress';

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

  // Answers still unsent when the page was reloaded - or the phone put it
  // away and opened it again - are on this device: put them back in the
  // queue, so they are sent rather than forgotten. Anything changed since
  // the reload is newer and stays.
  useEffect(() => {
    if (!attempt?.id || restoredId === attempt.id) return undefined;
    const id = attempt.id;
    let cancelled = false;
    const restore = (found) => {
      if (cancelled) return;
      // A restart keeps the paper's id: answers from before it are not for this paper.
      const gap = Math.abs(Date.parse(found?.attempt?.startedAt || '') - Date.parse(attemptRef.current?.startedAt || ''));
      if (found?.attempt?.id === id && found.pending?.size && !(gap > 30_000)) {
        setPending((current) => {
          const next = new Map(found.pending);
          current.forEach((payload, questionId) => next.set(questionId, payload));
          return next;
        });
      }
      setRestoredId(id);
    };
    const cached = loadCache(storage, id);
    if (cached) restore(cached);
    else loadDurableCache(durableStorage, code).then(restore, () => restore(null));
    return () => { cancelled = true; };
  }, [attempt?.id, restoredId, code]);

  // Persist the paper and anything unsent on every change - once what this
  // device held from before has been put back, or it would be overwritten.
  // A paper handed in (by the clock, say, while this device was offline) is
  // kept until its last answer held here has gone (domain/late-answers.js).
  useEffect(() => {
    if (!attempt?.id || restoredId !== attempt.id) return;
    if (attempt.status === 'submitted') {
      if (pending.size) saveCache(storage, attempt.id, attempt, pending);
      else {
        clearCache(storage, attempt.id);
        void clearDurable();
      }
      return;
    }
    saveCache(storage, attempt.id, attempt, pending);
    durableWriter.current?.schedule(attempt, pending);
  }, [attempt, pending, code, restoredId, clearDurable]);

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
    // A question shown before the server has opened it (opened early, below):
    // its answers wait until it has - sent sooner they would be refused.
    const holding = earlyRef.current?.question.id;
    const queued = [...pending.entries()].filter(([questionId]) => questionId !== holding);
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
          // Locked: kept too, and sent once the paper is revived. (It used to
          // be taken as refused for good and dropped from this device.)
          if (error.code === 'LOCKED') { await loadAttempt(); queueAnswerRetry(); break; }
          // The venue check went quiet while offline: check now, and send it
          // once the paper is open again. Never dropped for that.
          if (error.code === 'VENUE_CLOSED') { void checkLocationRef.current?.('blocked'); queueAnswerRetry(); break; }
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
  // Continued after a pause, or revived after a lock: answers held back by it go now.
  useEffect(() => { if (attempt && !attempt.paused && !attempt.isLocked) flush(); }, [attempt?.paused, attempt?.isLocked]); // eslint-disable-line react-hooks/exhaustive-deps
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
            // Marked in place: each stays the same entry (see the departure an outage takes back, below).
            for (const entry of presenceQueue.current) entry.queued = true;
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
    if (body.type === 'exit') lastExit.current = { entry: body, at: Date.now() };
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
    const goOnline = () => { setOnline(true); flush(); flushPresence(); void loadAttempt(); retryMove.current?.(); };
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
  }, [flush, flushPresence, pending.size, loadAttempt]);

  const saveAnswer = useCallback(async (payload) => {
    const { questionId, ...rest } = payload;
    // Show it at once and keep it on this device; the queue does the rest.
    // When it was made, on the server's clock: an answer held here by a lost
    // connection is still taken after its time, marked late (late-answers.js).
    setPending((current) => new Map(current).set(questionId, { questionId, ...rest, madeAt: Math.round(serverNow()) }));
    setSaving(true);
  }, []);

  /* ---------------------------------------------------------- the attempt UI */

  useEffect(() => {
    if (placed.current || !attempt?.questions || attempt.questionLayout === 'all') return;
    placed.current = true;
    setIndex(landingIndex(attempt.questions));
  }, [attempt]);

  useEffect(() => {
    // Locked and paused screens have their own focused fallback poll below;
    // keeping this paper heartbeat there too doubled their traffic.
    if (!attempt?.id || attempt.status === 'submitted' || attempt.isLocked || attempt.paused) return undefined;
    let timer;
    const tick = async () => {
      const fresh = await loadAttempt();
      timer = window.setTimeout(tick, attemptPollDelay(fresh || attemptRef.current));
    };
    timer = window.setTimeout(tick, attemptPollDelay(attemptRef.current));
    return () => window.clearTimeout(timer);
  }, [attempt?.id, attempt?.status, attempt?.isLocked, attempt?.paused, loadAttempt]);

  // Strict timing moved on while an answer was on its way: the question held
  // here is not the open one any more, so fetch the paper as it now stands.
  useEffect(() => { if (attempt?.questionsStale) void loadAttempt(); }, [attempt?.questionsStale, loadAttempt]);

  // The paper - or, under strict timing, the open question - is on this
  // screen: tell the server, whose clock for it starts now rather than when
  // it was sent, so a slow connection does not eat the time (markShown). The
  // server allows this only a few seconds after sending, so it is tried a few
  // times, quickly, and then left.
  const shownSent = useRef('');
  const pendingShown = attempt?.strict?.shownPending ? attempt.questions?.[0]?.id ?? null : null;
  const shownQuestion = pendingShown !== null && !shownEarlyIds.current.has(pendingShown) ? pendingShown : null;
  const shownPaper = Boolean(attempt?.clockPending);
  // Every picture on the paper starts loading as it opens. "On screen" waits
  // for the pictures it is about - this question's, or (the paper's own clock)
  // all of them - so no clock runs while a picture is still on its way. The
  // server gives a question with a picture up to 30 s for this.
  // The paper as shown: the next question already, while a move made here is on its way.
  const viewAttempt = useMemo(() => earlyView(attempt, early), [attempt, early]);
  const imageUrls = useMemo(() => (viewAttempt?.questions || []).map((question) => question.image?.url).filter(Boolean), [viewAttempt?.questions]);
  const settled = useImagesSettled(imageUrls);
  const shownImages = shownQuestion ? [attempt.questions[0]?.image?.url].filter(Boolean) : shownPaper ? imageUrls : [];
  const imagesWaiting = shownImages.some((url) => !settled.has(url));
  useEffect(() => {
    const attemptId = attempt?.id;
    if (!attemptId || attempt?.status !== 'in_progress' || (!shownQuestion && !shownPaper)) return undefined;
    if (imagesWaiting) return undefined;
    const key = `${attemptId}:${shownQuestion ?? ''}:${shownPaper}`;
    if (shownSent.current === key) return undefined;
    shownSent.current = key;
    let cancelled = false;
    (async () => {
      for (let round = 0; round < 3 && !cancelled; round += 1) {
        try {
          const response = await post(`/api/test-attempts/${attemptId}/shown`, {
            ...(shownQuestion ? { questionId: shownQuestion } : {}), ...(shownPaper ? { paper: true } : {})
          }, { timeoutMs: SHOWN_TIMEOUT_MS });
          const fresh = response?.attempt;
          if (!fresh || cancelled) return;
          // Only its clocks: anything else may have moved on while this was on its way.
          setAttempt((current) => (current?.id !== fresh.id ? current : {
            ...current,
            startedAt: fresh.startedAt,
            deadlineAt: fresh.deadlineAt,
            timeOver: fresh.timeOver,
            clockPending: fresh.clockPending,
            serverTime: fresh.serverTime,
            revision: undefined,
            ...(current.strict && fresh.strict && current.strict.index === fresh.strict.index ? { strict: fresh.strict } : {})
          }));
          return;
        } catch (error) {
          if (isSignedOut(error) || !isRetryable(error)) return;
          await wait(1_500);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [attempt?.id, attempt?.status, shownQuestion, shownPaper, imagesWaiting]);

  const attemptId = attempt?.id;
  // The admin turned on "Private window only" and this is a normal window:
  // the paper is covered until it is reopened in Incognito. Leaving this tab
  // to do that is not counted against the student.
  const privateBlocked = Boolean(attempt?.requirePrivateWindow) && !privateExempt && windowKind === 'normal' && attempt?.status !== 'submitted';
  // Likewise a paper opened on a device the test does not allow.
  const deviceBlocked = attempt?.status === 'in_progress' && deviceRefused(deviceCheck);
  const sitting = Boolean(attemptId) && attempt?.status !== 'submitted' && !privateBlocked && !deviceBlocked;
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
  const [locationProblem, setLocationProblem] = useState(null);
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
        setLocationProblem(null);
      } catch (error) { setLocationProblem(error); /* reported as inconclusive below */ }
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
  checkLocationRef.current = checkLocation;

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

  // Leaving the paper while the server is out of reach - the paper paused for everyone (ServerOfflineGate) - is not
  // held against the student: that departure is not reported, and back on the paper within OUTAGE_RETURN_GRACE_MS of
  // the server answering again, it never counts. Still away then, it counts from that moment. One begun in the moment
  // before the outage was known (its report still unsent) is taken back too; one begun earlier counts up to it.
  const downSince = useRef(null);
  const outageLeave = useRef(null);
  const countFrom = useRef(null);
  const outageGrace = useRef(null);
  const lastExit = useRef(null);
  useEffect(() => {
    if (serverDown) {
      if (downSince.current !== null) return;
      downSince.current = unreachableSince.current ?? Date.now();
      // A departure's report goes at once, so one made while the server is out of reach is what found that out.
      const last = lastExit.current;
      const at = last && last.at >= downSince.current - OUTAGE_LEAVE_SLACK_MS ? presenceQueue.current.indexOf(last.entry) : -1;
      if (at < 0) return;
      const back = presenceQueue.current.findIndex((entry, index) => index > at && entry.type === 'return');
      presenceQueue.current = presenceQueue.current.filter((_entry, index) => index !== at && index !== back);
      writePresence(attemptIdRef.current, presenceQueue.current);
      if (back < 0) outageLeave.current = { detail: last.entry.detail, typing: Boolean(last.entry.typing) };
      return;
    }
    if (downSince.current === null) return;
    downSince.current = null;
    if (!outageLeave.current) return;
    window.clearTimeout(outageGrace.current);
    outageGrace.current = window.setTimeout(() => {
      const left = outageLeave.current;
      if (!left || downSince.current !== null || attemptRef.current?.status !== 'in_progress') return;
      outageLeave.current = null;
      countFrom.current = Date.now();
      reportPresence({ type: 'exit', detail: left.detail, ...(left.typing ? { typing: true } : {}) });
    }, OUTAGE_RETURN_GRACE_MS);
  }, [serverDown]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => window.clearTimeout(outageGrace.current), []);

  // Keyboard-app notes so far in this sitting (the server keeps the real count).
  const keyboardNotes = useRef(0);
  const { away, awayReason, recheck } = useAwayMonitor({
    // A locked or paused attempt has no paper on screen, so leaving it is not watched.
    enabled: sitting && !attempt?.isLocked && !attempt?.paused,
    enforceFullscreen,
    serverAway: Boolean(attempt?.isAway),
    onLeave: (detail, { typing = false } = {}) => {
      // The server out of reach: not reported - see the outage's departures above.
      if (downSince.current !== null) { outageLeave.current = { detail, typing }; return; }
      reportPresence({ type: 'exit', detail, ...(typing ? { typing: true } : {}) });
    },
    onReturn: (away, detail, { typing = false } = {}) => {
      // Left while the server was out of reach, and back within the grace: nothing to count.
      if (outageLeave.current) {
        outageLeave.current = null;
        window.clearTimeout(outageGrace.current);
        return;
      }
      let durationMs = away;
      if (countFrom.current !== null) {
        // Still away when the grace ran out: counted from then.
        durationMs = Math.min(away, Date.now() - countFrom.current);
        countFrom.current = null;
      } else if (downSince.current !== null) {
        // Left before the server went out of reach, back while it still is: counted up to then. Sent as queued, so
        // the server takes this time rather than measuring its own up to when it arrives.
        durationMs = Math.max(0, Math.min(away, downSince.current - (Date.now() - away)));
      }
      reportPresence({ type: 'return', durationMs, detail, ...(downSince.current !== null ? { queued: true } : {}) });
      const current = attemptRef.current;
      // Away only a moment, while typing: most likely the keyboard's own app
      // (voice typing, its settings). The server makes that a note, not a
      // departure - the same limits as there, so this never promises more.
      if (typing && durationMs <= KEYBOARD_GRACE_MS && keyboardNotes.current < KEYBOARD_NOTES_MAX) {
        keyboardNotes.current += 1;
        showToast("Your keyboard opened another app. Back this quickly, it is only noted for your teacher, not counted as leaving. To be safe, use the phone's own keyboard and type rather than dictate.", 'info', { title: 'Keyboard app' });
        return;
      }
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
  useKeyboardLockdown({ enabled: sitting && !attempt?.isLocked });

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

  /* ---------------------- a timed one-way paper: the next question, ready */

  // Only where the open question has a timer: a change because its time is up
  // comes at a moment the server knows in advance.
  const serverStrict = attempt?.strict || null;
  const serverIndex = serverStrict ? serverStrict.index ?? 0 : null;
  // The questions not opened yet start here; where students may go back, the
  // open one is not always the furthest.
  const serverReached = serverStrict ? serverStrict.reached ?? serverIndex + 1 : null;
  const atNewest = serverStrict ? serverIndex === serverReached - 1 : false;
  const openId = serverStrict ? attempt.questions?.[0]?.id ?? null : null;
  // With Next allowed too: when time runs out the next one is here at once, while pressing Next still asks the server.
  const sealing = Boolean(serverStrict && attempt.status === 'in_progress' && !attempt.paused && !attempt.isLocked && !attempt.timeOver
    && serverStrict.questionSeconds) && canOpenSealed();

  // The next few questions, sealed: fetched a moment after each change, only
  // those not held yet. Without them the paper moves on as it always did.
  const aheadFor = useRef(null);
  useEffect(() => {
    if (!sealing || serverReached === null || !attempt?.id) return undefined;
    if (aheadFor.current !== attempt.id) { aheadRef.current.clear(); aheadFor.current = attempt.id; }
    for (const held of [...aheadRef.current.keys()]) if (held < serverReached) aheadRef.current.delete(held);
    let first = serverReached;
    while (aheadRef.current.has(first)) first += 1;
    if (first >= serverStrict.total || first >= serverReached + AHEAD_COUNT) return undefined;
    const attemptId = attempt.id;
    let cancelled = false;
    let timer;
    const fetchAhead = async (round = 0) => {
      try {
        const reply = await api(`/api/test-attempts/${attemptId}/ahead?from=${first}`, { timeoutMs: MOVE_TIMEOUT_MS });
        if (cancelled) return;
        for (const sealed of reply?.questions || []) aheadRef.current.set(sealed.index, sealed);
        setAheadSize((value) => value + 1);
      } catch {
        if (!cancelled && round < 2) timer = window.setTimeout(() => fetchAhead(round + 1), retryDelay(round + 1));
      }
    };
    const spread = Math.min(AHEAD_SPREAD_MS, (serverStrict.questionSeconds || 0) * 250);
    timer = window.setTimeout(fetchAhead, AHEAD_FETCH_DELAY_MS + Math.round(Math.random() * spread));
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [sealing, attempt?.id, serverReached]); // eslint-disable-line react-hooks/exhaustive-deps

  // A question left behind: what was opened for it is of no use any more.
  useEffect(() => { setUpcoming((held) => (held && held.fromId !== openId ? null : held)); }, [openId]);

  // In the open question's last moments the server gives the next one's key:
  // it is opened here, and its picture fetched, ready for the change.
  // Only from the furthest question: one gone back to leads on to questions already seen.
  const keyIndex = serverIndex === null ? null : serverIndex + 1;
  const haveUpcoming = Boolean(upcoming && upcoming.fromId === openId);
  const keyWanted = sealing && atNewest && !early && !away && !haveUpcoming && openId !== null && keyIndex < serverStrict.total
    && Boolean(serverStrict.questionEndsAt) && !serverStrict.questionPaused && (!serverStrict.shownPending || shownEarlyIds.current.has(openId));
  useEffect(() => {
    if (!keyWanted) return undefined;
    const sealed = aheadRef.current.get(keyIndex);
    // Not fetched yet: this runs again when it is.
    if (!sealed) return undefined;
    const attemptId = attempt.id;
    let cancelled = false;
    let timer;
    const ask = async (round = 0) => {
      try {
        const reply = await post(`/api/test-attempts/${attemptId}/next-key`, { questionId: openId }, { timeoutMs: KEY_TIMEOUT_MS });
        if (cancelled) return;
        if (reply?.ready && reply.questionId === sealed.questionId) {
          const question = await openSealed(sealed, reply.key);
          if (cancelled || question?.id !== sealed.questionId) return;
          const url = question.image?.url;
          setUpcoming({ fromId: openId, index: keyIndex, question, seconds: sealed.seconds, imageReady: !url });
          if (url) void loadImage(url).then(() => setUpcoming((held) => (held?.question.id === question.id ? { ...held, imageReady: true } : held)));
        } else if (reply?.retryInMs && round < 3) {
          timer = window.setTimeout(() => ask(round + 1), Math.min(reply.retryInMs + 50, 60_000));
        }
      } catch {
        // Not given: at zero the paper moves on as it always did.
      }
    };
    timer = window.setTimeout(ask, Math.max(0, Date.parse(serverStrict.questionEndsAt) - serverNow() - KEY_ASK_LEAD_MS));
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [keyWanted, attempt?.id, openId, keyIndex, serverStrict?.questionEndsAt, aheadSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // The server has the move (or the paper changed some other way): its own
  // paper from here on, and the answers held for the early question go.
  useEffect(() => {
    if (!early) return;
    if (attempt?.status !== 'in_progress' || attempt.paused || attempt.isLocked || !attempt.strict || (attempt.strict.index ?? 0) !== early.fromIndex) setEarly(null);
  }, [attempt, early]);
  useEffect(() => { if (!early && pendingRef.current.size) void flush(); }, [early]); // eslint-disable-line react-hooks/exhaustive-deps
  // The early question ran out here before the server heard of the move (a
  // long loss of connection): final here, unless the server, once it has the
  // move, says it still has time.
  const earlyExpired = useRef(null);
  useEffect(() => {
    const expired = earlyExpired.current;
    if (!expired || early) return;
    earlyExpired.current = null;
    const endsAt = Date.parse(attempt?.strict?.questionEndsAt || '');
    if (openId === expired && Number.isFinite(endsAt) && endsAt - serverNow() > 2_000) setExpiredId(null);
  }, [attempt, early, openId]);

  const questions = useMemo(() => applyPending(viewAttempt?.questions, pending), [viewAttempt?.questions, pending]);
  // How sending stands, shown beside every question number (QuestionPaper SaveState).
  const hasUnsent = pending.size > 0;
  const [sendingStuck, setSendingStuck] = useState(false);
  useEffect(() => {
    if (!hasUnsent) { setSendingStuck(false); return undefined; }
    const timer = window.setTimeout(() => setSendingStuck(true), STUCK_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [hasUnsent]);
  // Offline - or the browser still has a network, so it is the test server that cannot be reached.
  const connection = online ? (sendingStuck ? 'stuck' : 'online')
    : typeof navigator !== 'undefined' && navigator.onLine ? 'server' : 'offline';
  const showAll = attempt?.questionLayout === 'all';
  const current = questions[Math.min(index, Math.max(0, questions.length - 1))];
  const openCount = questions.filter((question) => !question.answered).length;
  const scrollToQuestion = (target) => {
    const node = document.getElementById(`question-${questions[target]?.id}`);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const cancelSubmission = () => {
    if (manualSubmission.current?.requestSent) return;
    if (manualSubmission.current) manualSubmission.current.cancelled = true;
    manualSubmission.current = null;
    setSubmitting(false);
    setSubmissionProblem(null);
  };
  const submit = async (alreadyConfirmed = false) => {
    if (manualSubmission.current || strictConfirming.current || moving.current || autoSubmitting.current || attemptRef.current?.status !== 'in_progress') return;
    const job = { id: attemptRef.current.id, cancelled: false, requestSent: false };
    manualSubmission.current = job;
    const active = () => submissionMounted.current && !job.cancelled && manualSubmission.current === job && attemptRef.current?.id === job.id;
    const phase = (value) => { if (active()) setSubmitting(value); };
    let failed = false;
    setSubmissionProblem(null);
    try {
      if (alreadyConfirmed !== true) {
        phase('confirming');
        // Confirm immediately, before waiting for a location or a slow save.
        const unanswered = attempt.strict
          ? attempt.strict.total - attempt.answeredQuestionCount
          : questions.filter((question) => !question.answered).length;
        if (!(await askToConfirm({
          title: 'Submit your test?',
          message: unanswered
            ? `${unanswered} question${unanswered === 1 ? ' is' : 's are'} not answered${attempt.strict ? ' or not reached yet' : ''}. You cannot change anything after submitting.`
            : 'You cannot change your answers after submitting.',
          confirmLabel: 'Submit test', danger: unanswered > 0
        }))) return;
      }
      if (!active()) return;
      phase(pendingRef.current.size ? 'saving' : 'preparing');
      // Nothing is handed in over an unsent answer. Saving keeps its existing
      // durable queue/backoff; the dialog now waits rather than warning and
      // making the student press Submit again after a slow connection.
      if (attemptRef.current.locationRequired) await Promise.race([checkLocation('submit'), wait(SUBMIT_LOCATION_MS)]);
      if (!active()) return;
      const settled = await settleAnswers();
      if (!settled) phase('waiting');
      while (active() && pendingRef.current.size && attemptRef.current?.status === 'in_progress' && !attemptRef.current.timeOver && !attemptRef.current.paused && !attemptRef.current.isLocked) await wait(250);
      if (!active() || attemptRef.current?.status !== 'in_progress' || attemptRef.current.timeOver || attemptRef.current.paused || attemptRef.current.isLocked) return;
      phase('sending');
      job.requestSent = true;
      flushPresence();
      const response = await retrySubmission(() => {
        phase('sending');
        return submissionFlight.current(job.id, () => post(`/api/test-attempts/${job.id}/submit`));
      }, {
        shouldRetry: (error) => !isSignedOut(error) && isRetryable(error), pause: wait,
        retryWait: (round) => Math.min(8_000, 1_000 * 2 ** round) * (0.5 + Math.random()),
        onRetry: () => phase('retrying'),
        active: () => active() && attemptRef.current?.status === 'in_progress' && !attemptRef.current.timeOver && !attemptRef.current.paused && !attemptRef.current.isLocked
      });
      if (!active() || !response) return;
      if (response.attempt.status !== 'submitted') {
        setAttempt(response.attempt);
        throw new Error('Your paper is still open. Please check it before submitting again.');
      }
      clearCache(storage, job.id);
      void clearDurable();
      writePresence(job.id, []);
      setAttempt(response.attempt);
    } catch (error) {
      if (!active()) return;
      if (isSignedOut(error)) setSignedOut(error.message);
      else {
        failed = true;
        setSubmissionProblem({
          message: isRetryable(error)
            ? 'We could not confirm submission. Your saved answers are kept. Try again to confirm.'
            : error.message,
          uncertain: job.requestSent && isRetryable(error), retryable: isRetryable(error)
        });
        phase('error');
      }
    } finally {
      if (manualSubmission.current === job) {
        manualSubmission.current = null;
        if (submissionMounted.current && !failed) setSubmitting(false);
      }
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
      // Answers still on this device go first: the server takes them for 90
      // seconds after the end. Handing the paper in over them would leave
      // them out - so if they cannot go by then, the server hands the paper
      // in after its grace instead, and they follow it (late-answers.js).
      const until = Date.now() + 75_000;
      await flush();
      while (pendingRef.current.size && Date.now() < until && attemptRef.current?.status === 'in_progress' && attemptRef.current?.timeOver) {
        await wait(3_000);
        await flush();
      }
      // Time given back meanwhile (the server was out of reach, say): the paper opens again.
      if (!attemptRef.current?.timeOver) {
        setTimeUp(false);
        return;
      }
      flushPresence();
      if (pendingRef.current.size) {
        await loadAttempt();
        return;
      }
      for (let round = 0; round < 4; round += 1) {
        try {
          // `auto`: refused (TIME_LEFT) if the server still has time on the paper - it is not handed in for time it gave back.
          const finalId = attemptIdRef.current;
          const response = await submissionFlight.current(finalId, () => post(`/api/test-attempts/${finalId}/submit`, { auto: true }));
          if (response.attempt.status !== 'submitted') { setAttempt(response.attempt); return; }
          clearCache(storage, attemptIdRef.current);
          void clearDurable();
          writePresence(attemptIdRef.current, []);
          setAttempt(response.attempt);
          return;
        } catch (error) {
          if (error.code === 'TIME_LEFT') {
            await loadAttempt();
            setTimeUp(false);
            return;
          }
          if (!isRetryable(error)) break;
          await wait(retryDelay(round));
        }
      }
      await loadAttempt();
    } finally {
      autoSubmitting.current = false;
    }
  }, [flush, flushPresence, loadAttempt, clearDurable]);
  useEffect(() => { if (attempt?.timeOver && attempt.status === 'in_progress') autoSubmit(); }, [attempt?.timeOver, attempt?.status, autoSubmit]);
  useEffect(() => {
    if (!attempt?.timeOver || !confirmRequest) return;
    confirmRequest.resolve(false);
    setConfirmRequest(null);
  }, [attempt?.timeOver, confirmRequest]);
  // An extension while the gate is up gives the paper back.
  useEffect(() => { if (attempt?.status === 'in_progress' && !attempt.timeOver && !autoSubmitting.current) setTimeUp(false); }, [attempt]);

  // Strict timing: close this question and open the next - by the student's
  // Next, or by its clock. The answer on screen is sent first; the question
  // id tells the server which one we mean, so a repeat never skips one.
  const moving = useRef(false);
  const [movingOn, setMovingOn] = useState(false);
  // A move that has not reached the server yet: it goes by itself (below).
  const [moveWaiting, setMoveWaiting] = useState(false);
  // `typed`: the answer as it was on screen when the paper changed here first
  // (shownEarly) - by now the screen shows the next question.
  const goNext = useCallback(async (questionId, { auto = false, retry = false, shownEarly = false, typed: typedThen } = {}) => {
    if (moving.current || !attemptIdRef.current) return;
    moving.current = true;
    setMovingOn(true);
    const timing = attemptRef.current?.strict;
    const finishing = timing && (timing.forwardTo !== undefined ? timing.forwardTo === null : timing.index >= timing.total - 1);
    if (finishing) { setSubmissionProblem(null); setSubmitting(flushing.current || pendingRef.current.size ? 'saving' : 'preparing'); }
    window.clearTimeout(moveRetryTimer.current);
    // The answer on screen goes with the move itself - one request, not a
    // save and then a move. A save already on its way lands first, so it can
    // never arrive after the question has closed.
    for (const until = Date.now() + 3_000; flushing.current && Date.now() < until;) await wait(25);
    const typed = typedThen !== undefined ? typedThen : paperDraft.current?.();
    // Its time is up on this screen: the answer is final from here on, also
    // while the move waits for the connection.
    if (auto) setExpiredId(questionId);
    const queued = pendingRef.current.get(questionId);
    const carried = typed ? { questionId, ...typed, madeAt: Math.round(serverNow()) } : queued || null;
    if (queued) {
      setPending((current) => {
        if (current.get(questionId) !== queued) return current;
        const next = new Map(current);
        next.delete(questionId);
        return next;
      });
    }
    try {
      if (finishing) setSubmitting('sending');
      const url = `/api/test-attempts/${attemptIdRef.current}/next`;
      // `auto`: time ran out on this screen. If the server still has time on the question (given back after an
      // outage, say) it says QUESTION_OPEN, and the question opens again here rather than being lost.
      const body = { questionId, ...(carried ? { answer: carried } : {}), ...(auto ? { auto: true } : {}), ...(shownEarly ? { shownEarly: true } : {}) };
      // Asking again for the same question is safe - the server never skips
      // one - so a reply stuck on a weak connection is not waited out.
      let response;
      for (let round = 0; !response; round += 1) {
        try {
          response = await (finishing
            ? submissionFlight.current(attemptIdRef.current, () => post(url, body, { timeoutMs: MOVE_TIMEOUT_MS }))
            : post(url, body, { timeoutMs: MOVE_TIMEOUT_MS }));
        } catch (error) {
          if (isOffline(error) || isSignedOut(error) || !isRetryable(error) || round >= 2) throw error;
          if (finishing) setSubmitting('retrying');
          await wait(retryDelay(round) / 2);
          if (finishing) setSubmitting('sending');
        }
      }
      pendingMove.current = null;
      moveRetryRound.current = 0;
      setMoveWaiting(false);
      if (finishing) setSubmitting(false);
      if (response.attempt.status === 'submitted' && !pendingRef.current.size) {
        clearCache(storage, attemptIdRef.current);
        void clearDurable();
        writePresence(attemptIdRef.current, []);
      }
      setAttempt(response.attempt);
      // Not moved after all: the screen shows the server's paper again.
      if (shownEarly && response.attempt.strict && (response.attempt.strict.index ?? 0) === earlyRef.current?.fromIndex) setEarly(null);
      // Time ran out: a warning only when it cost the student something - the
      // question was left blank. An answered one simply moves on, and the last
      // one lands on the result, which says the test was submitted.
      if (auto && response.attempt.status !== 'submitted') {
        const answered = carried ? hasContent(carried) : Boolean(attemptRef.current?.questions?.find((question) => question.id === questionId)?.answered);
        if (!answered) showToast('It was left unanswered. Here is the next question.', 'warn', { title: 'Time is up for that question' });
      }
    } catch (error) {
      // Not delivered: the answer goes back in the queue, so it is not lost.
      if (carried && (isRetryable(error) || isSignedOut(error) || ['LOCKED', 'PAUSED', 'VENUE_CLOSED'].includes(error.code))) {
        setPending((current) => (current.has(questionId) ? current : new Map(current).set(questionId, carried)));
      }
      // The connection, or this screen's clock a moment ahead of the
      // server's: the move goes again by itself - soon, and at once when the
      // connection is back - rather than waiting for the next refresh.
      const waitsToGo = isRetryable(error) || (auto && error.code === 'QUESTION_OPEN');
      if (waitsToGo) {
        if (finishing) setSubmitting('retrying');
        pendingMove.current = { questionId, auto, shownEarly };
        setMoveWaiting(true);
        const round = moveRetryRound.current;
        moveRetryRound.current += 1;
        moveRetryTimer.current = window.setTimeout(() => retryMove.current?.(), error.code === 'QUESTION_OPEN' ? 1_500 : retryDelay(round));
      }
      // The question still has time on the server: the next one, shown early, goes back until it is due.
      if (shownEarly && error.code === 'QUESTION_OPEN') {
        const shown = earlyRef.current?.question.id;
        if (shown !== undefined) shownEarlyIds.current.delete(shown);
        setEarly(null);
      }
      if (isSignedOut(error)) { setSignedOut(error.message); if (finishing) setSubmitting(false); }
      else if (error.code === 'QUESTION_OPEN') { if (finishing) setSubmitting(false); void loadAttempt(); }
      else if (waitsToGo) {
        if (!retry && !finishing) showToast('Your test moves on as soon as it is back.', 'warn', { title: 'No connection' });
      } else {
        if (shownEarly) setEarly(null);
        if (finishing) {
          setSubmissionProblem({ message: error.message, uncertain: false, retryable: false });
          setSubmitting('error');
        } else showToast(error.message);
        await loadAttempt();
      }
    } finally {
      moving.current = false;
      setMovingOn(false);
    }
  }, [code, loadAttempt, showToast, clearDurable]);
  retryMove.current = () => {
    const move = pendingMove.current;
    // An early change already shows the next question: the answer left behind
    // is the one queued for it, not what is on screen now.
    if (move) void goNext(move.questionId, { auto: move.auto, retry: true, ...(move.shownEarly ? { shownEarly: true, typed: null } : {}) });
  };

  // Going back, where the test allows it: from the open question to one
  // already seen that still has time - by Previous, or by its number. Its
  // clock stops with the time it has left, and the answer on screen goes with
  // the move, as with Next. It needs the server: offline, the student stays.
  const [movingTo, setMovingTo] = useState(null);
  const goTo = useCallback(async (questionId, position) => {
    if (moving.current || !attemptIdRef.current) return;
    moving.current = true;
    setMovingOn(true);
    setMovingTo(position);
    for (const until = Date.now() + 3_000; flushing.current && Date.now() < until;) await wait(25);
    const typed = paperDraft.current?.();
    const queued = pendingRef.current.get(questionId);
    const carried = typed ? { questionId, ...typed, madeAt: Math.round(serverNow()) } : queued || null;
    if (queued) {
      setPending((current) => {
        if (current.get(questionId) !== queued) return current;
        const next = new Map(current);
        next.delete(questionId);
        return next;
      });
    }
    try {
      const response = await post(`/api/test-attempts/${attemptIdRef.current}/go`, { questionId, to: position, ...(carried ? { answer: carried } : {}) }, { timeoutMs: MOVE_TIMEOUT_MS });
      setAttempt(response.attempt);
    } catch (error) {
      // Not delivered: the answer goes back in the queue, so it is not lost.
      if (carried) setPending((current) => (current.has(questionId) ? current : new Map(current).set(questionId, carried)));
      if (isSignedOut(error)) setSignedOut(error.message);
      else if (isRetryable(error)) showToast('Going back needs the connection. Your answer is kept on this device.', 'warn', { title: 'No connection' });
      else if (error.code === 'QUESTION_ENDING') showToast(error.message, 'info');
      else {
        showToast(error.message);
        await loadAttempt();
      }
    } finally {
      moving.current = false;
      setMovingOn(false);
      setMovingTo(null);
    }
  }, [loadAttempt, showToast]);

  // The server moved on by itself (a refresh shows another question, or the
  // paper handed in): the move that was waiting is done.
  // Or it says the question still has time (its clock was moved on - a pause,
  // say - and this screen ran out early): the question opens again here.
  useEffect(() => {
    const move = pendingMove.current;
    if (!move || !attempt) return;
    const openId = attempt.questions?.[0]?.id;
    const endsAt = Date.parse(attempt.strict?.questionEndsAt || '');
    const timeLeft = move.auto && openId === move.questionId && Number.isFinite(endsAt) && endsAt - serverNow() > 2_000;
    if (attempt.status !== 'in_progress' || (attempt.strict && openId !== undefined && openId !== move.questionId) || timeLeft) {
      pendingMove.current = null;
      moveRetryRound.current = 0;
      window.clearTimeout(moveRetryTimer.current);
      setMoveWaiting(false);
      if (timeLeft) setExpiredId(null);
      if (!manualSubmission.current && !moving.current) setSubmitting(false);
    }
  }, [attempt]);
  useEffect(() => () => window.clearTimeout(moveRetryTimer.current), []);

  // Out of reach - the server, or this device's own connection - or a move still waiting: ask every few seconds
  // rather than on the slow beat (and the browser seldom says when only the server was out of reach), so the
  // moment it answers the paper carries on - a question whose time was given back opens again at once.
  useEffect(() => {
    if ((online && !moveWaiting) || !attempt?.id || attempt.status !== 'in_progress') return undefined;
    let stopped = false;
    let timer;
    const beat = async () => {
      await loadAttempt();
      if (!stopped) timer = window.setTimeout(beat, 3_000 + Math.round(Math.random() * 1_500));
    };
    timer = window.setTimeout(beat, 3_000 + Math.round(Math.random() * 1_500));
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [online, moveWaiting, attempt?.id, attempt?.status, loadAttempt]);
  // Reached again: what waited goes at once - the move, the answers, the record of leaving.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) { flush(); flushPresence(); retryMove.current?.(); }
    wasOnline.current = online;
  }, [online]); // eslint-disable-line react-hooks/exhaustive-deps

  const signedBackIn = async () => {
    setSignedOut('');
    await loadAttempt();
    flush();
    flushPresence();
  };

  const loadResult = useCallback(async (attemptId) => {
    try {
      const next = (await api(`/api/test-attempts/${attemptId}/result`)).result;
      // Open again (the teacher reopened it, or resumed the test): loading the
      // paper brings it back and says why.
      if (next.reopened) {
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
  // Marks released before marking was done keep being checked until every
  // answer is marked (live events bring them sooner).
  const closedByTeacher = result?.submittedBy === 'admin';
  useEffect(() => {
    if (!attempt?.id || attempt.status !== 'submitted' || result?.wasReset) return undefined;
    if (result?.released && !closedByTeacher && !(result.pendingManual > 0)) return undefined;
    const timer = window.setInterval(() => loadResult(attempt.id), result?.released ? 15_000 : 7_000);
    return () => window.clearInterval(timer);
  }, [attempt?.id, attempt?.status, result, closedByTeacher, loadResult]);

  if (!attempt) return <div className="empty card">Loading your paper…</div>;
  if (attempt.status === 'submitted') return <ResultScreen result={result}/>;
  if (privateBlocked) return <PrivateWindowRequired test={{ code, title: attempt.title }} showToast={showToast} onDeclare={onDeclareWindow} midTest/>;
  if (deviceBlocked) return <DeviceNotAllowed test={{ code, title: attempt.title }} rule={attempt.devices} check={deviceCheck} stage="paper" showToast={showToast}/>;
  if (attempt.paused) return <PausedAttempt attempt={attempt} reload={loadAttempt}/>;
  if (attempt.isLocked) return <LockedAttempt attempt={attempt} reload={loadAttempt}/>;
  if (!current) return <div className="empty card">Preparing your questions…</div>;

  const strict = viewAttempt.strict || null;
  const answeredCount = strict ? attempt.answeredQuestionCount : questions.length - openCount;
  const totalCount = strict ? strict.total : questions.length;
  // Nothing can open after this one: Next hands the paper in. (A page from
  // before `forwardTo`: the last question.)
  const isLastStrict = strict && (strict.forwardTo !== undefined ? strict.forwardTo === null : strict.index >= strict.total - 1);
  const strictNext = async () => {
    if (manualSubmission.current || moving.current || strictConfirming.current || confirmRequest || submitting) return;
    strictConfirming.current = true;
    try {
      // Where students may go back, a question left unanswered is still there while it has time.
      const request = isLastStrict
        ? { title: 'Submit your test?', message: current.answered ? 'You cannot change your answers after submitting.' : 'This question is not answered.', confirmLabel: 'Submit test', danger: !current.answered }
        : (current.answered || strict.previous ? null : { title: 'Skip this question?', message: 'You cannot come back to it.', confirmLabel: 'Skip it', cancelLabel: 'Stay here', danger: true });
      if (request && !(await askToConfirm(request))) return;
      if (attemptRef.current?.status !== 'in_progress' || attemptRef.current.timeOver) return;
      void goNext(current.id);
    } finally { strictConfirming.current = false; }
  };
  // Going back is held while a move is under way, or the open question's time ran out here.
  const canGoBack = Boolean(strict?.previous) && !movingOn && !submitting && !early && !moveWaiting && expiredId !== current.id;
  const goBack = (position) => { if (canGoBack) void goTo(current.id, position); };
  // The open question's time ran out on this screen. With the next one here
  // and opened (its key came in this one's last moments) and its picture in,
  // it shows at once and the server is told meanwhile - nothing waits on the
  // connection. Otherwise the move goes to the server first, as it always did.
  const questionExpired = () => {
    if (early) {
      if (current.id === early.question.id) { earlyExpired.current = current.id; setExpiredId(current.id); }
      return;
    }
    const next = upcoming;
    const ready = next && next.fromId === current.id && next.index === serverIndex + 1 && next.imageReady && next.seconds > 0 && !moving.current;
    if (!ready) { void goNext(current.id, { auto: true }); return; }
    const typed = paperDraft.current?.() ?? null;
    shownEarlyIds.current.add(next.question.id);
    setUpcoming(null);
    setEarly({
      fromIndex: serverIndex, question: next.question, seconds: next.seconds, endsAt: new Date(serverNow() + next.seconds * 1000).toISOString(),
      // For its number along the top, until the server's paper comes.
      answered: Boolean(current.answered) || Boolean(typed && hasContent(typed))
    });
    void goNext(current.id, { auto: true, shownEarly: true, typed });
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
  const showSubmissionProgress = Boolean(submitting && submitting !== 'confirming');

  return (
    <section
      className={`exam-screen exam-protected${showAll ? ' is-list' : ''}`}
      style={!showAll ? { '--exam-question-fr': `${examSplit}fr`, '--exam-answer-fr': `${100 - examSplit}fr` } : undefined}
    >
      {/* Said aloud when the connection drops; each question shows it in words beside its number. */}
      <span className="sr-only" role="status">
        {connection === 'offline' ? 'You are offline. Your answers are kept on this device.'
          : connection === 'server' ? 'Cannot reach the server. Your answers are kept on this device.' : ''}
      </span>
      <ExamHeader
        attempt={viewAttempt}
        strict={strict}
        away={away}
        serverDown={paused}
        waitingForPicture={imagesWaiting}
        answeredCount={answeredCount}
        totalCount={totalCount}
        onTestExpire={autoSubmit}
        onQuestionExpire={questionExpired}
        onWarn={warnToast}
      />

      {strict
        ? <StrictDots strict={strict} answered={Boolean(current.answered)} disabled={!canGoBack} onGo={goBack}/>
        : <QuestionPalette questions={questions} currentIndex={showAll ? -1 : current.index} onSelect={showAll ? scrollToQuestion : selectQuestion}/>}

      <div className="exam-notices">
        {strict && moveWaiting && !movingOn && !early && (
          <p className="notice" role="status">
            {expiredId === current.id
              ? 'No connection to the server. Your answer is kept on this device. When it is back, this question carries on if it still has time - otherwise the next one opens.'
              : 'Waiting for the connection to open the next question. Your answer is kept on this device.'}
          </p>
        )}

      </div>
      {confirmRequest && !timeUp && !signedOut && <ConfirmGate request={confirmRequest} onAnswer={answerConfirm}/>}
      {timeUp && !signedOut && <TimeUpGate unsent={pending.size} online={online}/>}
      {showSubmissionProgress && !timeUp && !signedOut && <SubmissionProgress
        phase={submitting} problem={submissionProblem} unsent={pending.size}
        onCancel={manualSubmission.current && !manualSubmission.current.requestSent && !submissionProblem && ['preparing', 'saving', 'waiting'].includes(submitting) ? cancelSubmission : undefined}
        onRetry={submissionProblem?.retryable ? () => submit(true) : undefined}
        onContinue={submissionProblem && !submissionProblem.uncertain ? cancelSubmission : undefined}
      />}
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

      {/* Last, so it covers anything else: the whole paper waits for the server. */}
      {paused && !signedOut && !timeUp && !showSubmissionProgress && <ServerOfflineGate/>}
      <div className={`exam-body${shielded ? ' is-shielded' : ''}`} inert={paused || Boolean(submitting) || timeUp}>
        {shielded && (
          <div className="screenshot-shield" role="alert">
            <strong>Screenshots are not allowed</strong>
            <span>This was recorded and your administrator can see it.</span>
          </div>
        )}
        {showAll
          ? <QuestionList questions={questions} onSave={saveAnswer} connection={connection}/>
          : <QuestionPaper key={current.id} question={strict && current.id === expiredId ? { ...current, locked: true } : current} total={totalCount} onSave={saveAnswer} flushRef={strict ? paperFlush : undefined} draftRef={strict ? paperDraft : undefined} connection={connection} splitPanes/>}
        {strict && movingOn && !early && (
          <div className="strict-switching" role="status">
            {movingTo !== null ? `Opening question ${movingTo + 1}…` : isLastStrict ? 'Submitting your paper…' : 'Opening the next question…'}
          </div>
        )}
      </div>

      {!showAll && <ExamSplitDivider value={examSplit} onChange={setExamSplit}/>}
      {strict ? (
        <footer className={`exam-foot strict-foot${strict.previous ? ' has-back' : ''}`} inert={Boolean(submitting) || timeUp}>
          {strict.previous && (
            // Back to the nearest question before this one that still has time.
            <button className="exam-arrow" type="button" aria-label={strict.backTo === null || strict.backTo === undefined ? 'Previous question (none to go back to)' : `Previous question (question ${strict.backTo + 1})`}
              disabled={!canGoBack || strict.backTo === null || strict.backTo === undefined} onClick={() => goBack(strict.backTo)}>
              <Arrow back/>
            </button>
          )}
          {(!strict.canMoveOn || !isLastStrict) && (
            <button className="exam-submit is-secondary" type="button" disabled={movingOn || Boolean(submitting)} onClick={() => submit()}>
              {submitting === 'sending' ? 'Submitting…' : submitting ? 'Please wait…' : 'Submit test'}
            </button>
          )}
          {strict.canMoveOn && (
            // Shown early, the question's own Next waits until the server has the change that opened it.
            <button className="exam-submit" type="button" disabled={movingOn || Boolean(submitting) || Boolean(early)} onClick={strictNext}>
              {isLastStrict ? 'Finish & submit' : 'Next question →'}
            </button>
          )}
        </footer>
      ) : (
      <footer className="exam-foot" inert={Boolean(submitting) || timeUp}>
        {!showAll && (
          <button className="exam-arrow" type="button" aria-label="Previous question" disabled={current.index === 0} onClick={() => move(-1)}>
            <Arrow back/>
          </button>
        )}
        <button className="exam-submit" type="button" disabled={Boolean(submitting)} onClick={() => submit()}>
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
