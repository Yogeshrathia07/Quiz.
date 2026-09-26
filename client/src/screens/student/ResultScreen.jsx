import { useState } from 'react';
import { downloadMyResponses } from '../../lib/api.js';
import { dateTime } from '../../lib/format.js';

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
    return <p className="notice">⏱ Time's up — your answers were submitted automatically ({result.answeredQuestionCount} of {result.totalQuestions} answered).</p>;
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
      <h1>{result.score}/{result.totalQuestions}</h1>
      <HowSubmitted result={result}/>
      {!['time', 'admin'].includes(result.submittedBy) && <p>Your answers were submitted successfully.</p>}
      <p className="help">
        Answered {result.answered} of {result.totalQuestions} · submitted {dateTime(result.submittedAt)}
      </p>
      <IntegrityLine result={result}/>
      <DownloadResponses result={result}/>
    </section>
  );
}
