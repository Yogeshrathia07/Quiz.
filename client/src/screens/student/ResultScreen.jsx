import { useState } from 'react';
import { downloadMyResponses } from '../../lib/api.js';
import { clockTime, dateTime } from '../../lib/format.js';

/** Offered once the test is closed and marks are released; unmarked short answers show as ungraded. */
function DownloadResponses({ result }) {
  const [state, setState] = useState('');
  if (!result.canDownload) return null;
  const download = async () => {
    setState('busy');
    try { await downloadMyResponses(result.code); setState(''); } catch (error) { setState(error.message); }
  };
  return (
    <>
      <button className="button button-secondary button-wide" type="button" disabled={state === 'busy'} onClick={download}>
        {state === 'busy' ? 'Preparing…' : result.pendingManual ? 'Download my responses (short answers ungraded)' : 'Download my responses'}
      </button>
      {state && state !== 'busy' && <p className="help">{state}</p>}
    </>
  );
}

/** Why the paper was handed in, when it was not the student's own Submit. */
function HowSubmitted({ result }) {
  if (result.submittedBy === 'time') {
    // Each student's own time: theirs ran out, not the test's.
    const when = result.ownTime && result.deadlineAt ? `Your time was up at ${clockTime(result.deadlineAt)}` : "Time's up";
    return <p className="notice">⏱ {when} — your answers were submitted automatically ({result.answeredQuestionCount} of {result.totalQuestions} answered).</p>;
  }
  if (result.submittedBy === 'admin') {
    return <p className="notice">Your instructor closed the test, so your answers were submitted as they stood ({result.answeredQuestionCount} of {result.totalQuestions} answered).</p>;
  }
  if (result.submittedBy === 'teacher') {
    return <p className="notice">Your instructor handed in your paper, with your answers as they stood ({result.answeredQuestionCount} of {result.totalQuestions} answered).</p>;
  }
  return null;
}

function IntegrityLine({ result }) {
  if (!result.timesLeft && !result.timesLocked) return <p className="help">You stayed on the test the whole time.</p>;
  return (
    <p className="help">
      You left the test {result.timesLeft} time{result.timesLeft === 1 ? '' : 's'}
      {result.timesLocked ? ` and were locked ${result.timesLocked} time${result.timesLocked === 1 ? '' : 's'}` : ''}.
      Your administrator can see this.
    </p>
  );
}

export function ResultScreen({ result }) {
  if (!result) return <div className="empty card">Preparing result…</div>;

  if (result.wasReset) {
    return (
      <section className="join-card card">
        <p className="eyebrow">Attempt reset</p>
        <h1>Your administrator reset this attempt.</h1>
        <p>Reload the test link to begin again.</p>
      </section>
    );
  }

  if (!result.released) {
    return (
      <section className="join-card card">
        <p className="eyebrow" style={{ color: 'var(--warning)' }}>Test submitted</p>
        <h1>Marks are pending</h1>
        <HowSubmitted result={result}/>
        <p>{result.message || 'Your marks are not available yet.'}</p>
        <p className="help">This page checks automatically when marks become available.</p>
        <IntegrityLine result={result}/>
        <DownloadResponses result={result}/>
      </section>
    );
  }

  return (
    <section className="join-card card">
      <p className="eyebrow" style={{ color: 'var(--success)' }}>Test submitted</p>
      <h1>{result.score}/{result.totalMarks ?? result.totalQuestions}</h1>
      <HowSubmitted result={result}/>
      {!['time', 'admin'].includes(result.submittedBy) && <p>Your answers were submitted successfully.</p>}
      {/* Shown before marking was finished: the score so far, said plainly. */}
      {result.pendingManual > 0 && (
        <p className="notice">
          {result.pendingManual} short answer{result.pendingManual === 1 ? ' is' : 's are'} not marked yet. This score counts only what has been
          marked so far, and changes as your teacher marks the rest.
        </p>
      )}
      <p className="help">
        Answered {result.answered} of {result.totalQuestions} · submitted {dateTime(result.submittedAt)}
      </p>
      <IntegrityLine result={result}/>
      <DownloadResponses result={result}/>
    </section>
  );
}
