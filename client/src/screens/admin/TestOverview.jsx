import { useEffect, useRef } from 'react';
import {
  BarChart3, CircleCheck, Circle, Clock, FileSpreadsheet, Lock, PenLine, Send, UserCheck
} from 'lucide-react';
import { loadCached, useCached } from '../../lib/cache.js';
import { matrixPath, overviewPath } from '../../lib/dashboard-paths.js';
import { durationLabel, shortDateTime } from '../../lib/format.js';

/*
 * The Test tab below the status bar: how the class took part, what to do
 * next, the QR and the test's own settings - and the wording the Analysis tab
 * shares. The figures come from the server's overview
 * (services/overview-service.js), worked out over the whole class.
 */

export const plural = (count, word, many = `${word}s`) => `${count} ${count === 1 ? word : many}`;
export const marksText = (value) => (value === null || value === undefined ? '—' : String(Math.round(value * 10) / 10));
export const percentText = (value) => (value === null || value === undefined ? '—' : `${Math.round(value)}%`);
export const TYPE_WORD = { mcq: 'MCQ', msq: 'MSQ', short: 'Short' };

export function releaseLabel(test) {
  if (test.resultReleaseMode === 'instant') return 'Shown as each paper is submitted';
  if (test.resultReleaseMode === 'after_quiz') return 'Shown when the test closes';
  return test.resultsReleasedAt ? `Released ${shortDateTime(test.resultsReleasedAt)}` : 'When you release them';
}

export function endsLabel(test) {
  if (test.untimed) return 'When you close it';
  if (test.endMode === 'each') return `${durationLabel((test.durationMinutes || 0) * 60)} each, from their own Begin`;
  if (test.endsAt) return shortDateTime(test.endsAt);
  return `${durationLabel((test.durationMinutes || 0) * 60)} after the start`;
}

/**
 * The overview, asked for when the Test tab opens and again whenever the
 * class's numbers move (`signature`) - at most every 10 s while the test is
 * live, when every answer moves them, so a busy test does not ask on each one.
 */
export function useOverview(code, { enabled, live, signature, matrix = false }) {
  // `matrix`: the Analysis tab's data - every submitted paper against every question.
  const path = enabled ? (matrix ? matrixPath(code) : overviewPath(code)) : null;
  const { data } = useCached(path);
  const askedAt = useRef(Date.now());
  const seen = useRef(signature);
  useEffect(() => {
    if (!path || seen.current === signature) return undefined;
    seen.current = signature;
    const wait = Math.max(300, askedAt.current + (live ? 10_000 : 600) - Date.now());
    const timer = window.setTimeout(() => {
      askedAt.current = Date.now();
      loadCached(path, { force: true }).catch(() => {});
    }, wait);
    return () => window.clearTimeout(timer);
  }, [path, signature, live]);
  return data || null;
}

export function Panel({ title, note, action, className = '', children }) {
  return (
    <section className={`card ov-panel${className ? ` ${className}` : ''}`}>
      <header className="ov-panel-head">
        <h2>{title}</h2>
        {action}
      </header>
      {note && <p className="ov-panel-note">{note}</p>}
      {children}
    </section>
  );
}

export function Empty({ children }) {
  return <p className="ov-empty">{children}</p>;
}

function Step({ done, title, detail, action }) {
  return (
    <li className={`ov-step${done ? ' is-done' : ''}`}>
      {done ? <CircleCheck className="ov-step-mark" size={20} aria-label="Done"/> : <Circle className="ov-step-mark" size={20} aria-label="To do"/>}
      <div className="ov-step-text"><strong>{title}</strong>{detail && <span>{detail}</span>}</div>
      {action}
    </li>
  );
}

const stepButton = (label, icon, onClick, disabled = false) => {
  const Icon = icon;
  return (
    <button type="button" className="button button-view ov-step-button" disabled={disabled} onClick={onClick}>
      <Icon size={15} aria-hidden="true"/>{label}
    </button>
  );
};

/** While the test runs, what needs you now; once it is over, what to do next, in order. */
function StepsPanel({ test, counts, people, isBusy, hasShort, onOpenList, onOpenMarking, onRelease, onExport }) {
  if (!test.isClosed) {
    const now = [
      people?.locked > 0 && { key: 'locked', text: `${plural(people.locked, 'student')} locked`, action: stepButton('Open', Lock, () => onOpenList('students', ['paper:locked'])) },
      people?.paused > 0 && { key: 'paused', text: `${plural(people.paused, 'student')} paused by you`, action: stepButton('Open', Clock, () => onOpenList('students', ['paper:paused'])) },
      people?.away > 0 && { key: 'away', text: `${plural(people.away, 'student')} away from the page right now`, action: null },
      counts.pending > 0 && { key: 'pending', text: `${plural(counts.pending, 'request')} waiting for you`, action: stepButton('Review', UserCheck, () => onOpenList('students', ['pending'])) }
    ].filter(Boolean);
    return (
      <Panel title="Right now">
        {now.length ? (
          <ul className="ov-steps">
            {now.map((item) => <li key={item.key} className="ov-step is-alert"><div className="ov-step-text"><strong>{item.text}</strong></div>{item.action}</li>)}
          </ul>
        ) : <Empty>All quiet: nobody is locked, paused or away, and no requests are waiting.</Empty>}
      </Panel>
    );
  }
  const released = test.resultReleaseMode !== 'admin' || Boolean(test.resultsReleasedAt);
  const held = counts.awaitingMarking > 0 && !test.releaseUnmarked;
  const frozen = Boolean(test.resultsFrozenAt);
  // When the students see their marks, in a few plain words.
  const releaseNote = held ? 'Waiting for marking to finish'
    : test.resultsReleasedAt ? `Released on ${shortDateTime(test.resultsReleasedAt)}`
      : test.resultReleaseMode === 'instant' ? 'Students see marks when they submit'
        : test.resultReleaseMode === 'after_quiz' ? 'Students see marks after the test ends'
          : 'Students cannot see their marks yet';
  return (
    <Panel title="Tasks">
      <ol className="ov-steps">
        {/* Releasing the marks first: it is what students are waiting for. */}
        <Step done={released && !held} title="Release marks" detail={releaseNote}
          action={(!released || held) && !frozen && stepButton('Release', Send, onRelease, isBusy)}/>
        {hasShort && (
          <Step done={!counts.awaitingMarking} title="Mark answers"
            detail={counts.awaitingMarking ? `${plural(counts.awaitingMarking, 'paper')} to mark` : 'All answers are marked'}
            action={counts.awaitingMarking > 0 && stepButton(`Mark ${counts.awaitingMarking}`, PenLine, onOpenMarking)}/>
        )}
        <Step done={false} title="Download results" detail="All answers and marks in one Excel file"
          action={stepButton('Excel', FileSpreadsheet, onExport)}/>
        {/* Freezing the results is in ⋮ → Freeze results. */}
        <Step done={false} title="View analysis" detail="See how the class performed"
          action={stepButton('Analysis', BarChart3, () => onOpenList('analysis'))}/>
      </ol>
    </Panel>
  );
}

const LEAVING_VERB = { warn: 'Warned', lock: 'Locked', warn_lock: 'Warned, then locked,' };
const DEVICE_WORDS = { phone: 'Phones and tablets only', laptop: 'Laptops and desktops only' };

/** The test's settings that matter, one line each; what every test does by default is left out. */
function detailRows(test, fullMarks) {
  const mix = test.questionMix;
  const mixLine = mix ? ['mcq', 'msq', 'short'].filter((type) => mix[type]).map((type) => `${mix[type]} ${TYPE_WORD[type]}`).join(' · ') : '';
  const exits = Number(test.fullscreenExitLimit) || 0;
  const away = Number(test.fullscreenAbsenceLimitSeconds) || 0;
  const limits = [exits && plural(exits, 'exit'), away && `${away}s away`].filter(Boolean).join(' or ');
  const leaving = test.violationAction === 'record' || !LEAVING_VERB[test.violationAction] ? 'Recorded only'
    : limits ? `${LEAVING_VERB[test.violationAction]} after ${limits}` : LEAVING_VERB[test.violationAction];
  const ends = test.isClosed ? ['Ended', shortDateTime(test.closedAt)]
    : ['Ends', test.isStarted && !test.untimed && test.endMode !== 'each' ? shortDateTime(test.endsAt) : endsLabel(test)];
  return [
    ['Questions', `${test.questionCount} per student${mixLine ? ` (${mixLine})` : ''}`],
    fullMarks ? ['Full marks', marksText(fullMarks)] : null,
    ends,
    test.strictTiming ? ['Questions shown', 'One at a time, no going back'] : null,
    ['Leaving the page', leaving],
    test.locationRequired ? ['Venue', `Within ${test.locationRadiusMeters} m`] : null,
    DEVICE_WORDS[test.devices] ? ['Devices', DEVICE_WORDS[test.devices]] : null,
    test.requirePrivateWindow ? ['Window', 'Private window required'] : null,
    ['Who can join', test.allowGuests ? 'College accounts and guests' : 'College accounts only'],
    ['Marks shown', releaseLabel(test)]
  ].filter(Boolean);
}

function DetailsList({ test, fullMarks }) {
  return (
    <dl className="ov-details">
      {detailRows(test, fullMarks).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>
  );
}

/** The QR to show the class, big, with its code and the way to the link. */
function QrBlock({ test, onOpenQr }) {
  return (
    <div className="ov-qr">
      {/* The QR itself opens it big, with the link to copy - all there is room for on a very short screen. */}
      <button type="button" className="ov-qr-image" onClick={onOpenQr} title="Enlarge & copy link">
        <img className="qr" src={`/api/tests/${encodeURIComponent(test.code)}/qr.svg`} alt={`QR code for ${test.code}: enlarge it and copy the link`}/>
      </button>
      <div className="ov-qr-foot">
        <p className="test-code-display">{test.code}</p>
        <button className="button button-secondary" type="button" onClick={onOpenQr}>Enlarge &amp; copy link</button>
      </div>
    </div>
  );
}

/**
 * Everything below the status bar on the Test tab - running the test, not
 * how it went (that is the Analysis tab): before the start the QR and the
 * settings; once begun, what needs you or what is left to do, the QR while
 * students can still join, and the settings.
 */
export function OverviewPanels({ test, counts, overview, isBusy, onOpenQr, onOpenList, onOpenMarking, onRelease, onExport }) {
  const begun = test.isStarted || test.isClosed;
  const hasShort = (test.questionMix?.short || 0) > 0 || counts.awaitingMarking > 0;
  const steps = (
    <StepsPanel test={test} counts={counts} people={overview?.people} isBusy={isBusy} hasShort={hasShort}
      onOpenList={onOpenList} onOpenMarking={onOpenMarking}
      onRelease={onRelease} onExport={onExport}/>
  );
  const fullMarks = overview?.marks?.fullMarks ?? overview?.paper?.fullMarks;
  // Before the start: the QR, big, beside the test's settings - one card,
  // sized to the window so the whole tab fits one screen (theme.css .ov-share).
  if (!begun) {
    return (
      <section className="card ov-panel ov-share">
        <QrBlock test={test} onOpenQr={onOpenQr}/>
        <div className="ov-share-details">
          <h2>Test details</h2>
          <DetailsList test={test} fullMarks={fullMarks}/>
        </div>
      </section>
    );
  }
  const details = <Panel title="Test details" className="ov-details-panel"><DetailsList test={test} fullMarks={fullMarks}/></Panel>;
  // Over: what is left to do, beside the settings. How it went is the Analysis tab.
  if (test.isClosed) {
    return <div className="ov-columns"><div className="ov-column">{steps}</div><div className="ov-column">{details}</div></div>;
  }
  // Under way: what needs you, the QR for anyone still to join, and the
  // settings - three across a wide screen, the QR under Right now on a
  // narrower one (theme.css .ov-live).
  return (
    <div className="ov-columns ov-live">
      {steps}
      <section className="card ov-panel ov-qr-card"><QrBlock test={test} onOpenQr={onOpenQr}/></section>
      {details}
    </div>
  );
}
