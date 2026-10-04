import { useEffect, useState } from 'react';
import { ChevronRight, Clock, Download, Hourglass, PenLine } from 'lucide-react';
import { api, downloadMyResponses } from '../../lib/api.js';
import { clockTime, durationLabel, shortDateTime } from '../../lib/format.js';
import { InfoTip } from '../../components/InfoTip.jsx';
import { SapIdPrompt } from './SapIdPrompt.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';

/** A test you created opens on its manage page; any other on the test's own page. */
const targetOf = (result) => (result.isOwner ? `/?admin=${encodeURIComponent(result.code)}` : `/?test=${encodeURIComponent(result.code)}`);

// Marks earned out of the paper's full marks.
const outOf = (result) => result.totalMarks ?? result.totalQuestions;
const percentOf = (result) => (outOf(result) ? (result.score / outOf(result)) * 100 : 0);
const percent = (value) => `${Math.round(value)}%`;

/**
 * Where one test stands for this student, in a few words: `now` when it is
 * waiting on them (sitting it, about to, or waiting to be let in), `done`
 * once handed in, `past` when it ended without them.
 */
function standing(result) {
  if (result.registrationStatus === 'rejected') return { group: 'past', tone: 'danger', word: 'Declined', detail: 'Your request was not accepted' };
  if (result.registrationStatus === 'pending') return { group: 'now', tone: 'warn', word: 'Waiting', detail: 'Your teacher has to let you in' };
  if (result.attemptStatus === 'in_progress') return { group: 'now', go: 'Continue', detail: `Started ${clockTime(result.startedAt)}` };
  if (result.attemptStatus === 'submitted') {
    const taken = result.timeTakenSeconds === null ? '' : ` · ${durationLabel(result.timeTakenSeconds)}`;
    return { group: 'done', detail: `${shortDateTime(result.submittedAt)}${taken}` };
  }
  if (result.testClosed) return { group: 'past', tone: 'muted', word: 'Missed', detail: 'It ended before you began' };
  return { group: 'now', go: 'Open', detail: "You're approved" };
}
const NOW_ORDER = { Continue: 0, Open: 1 };

/** Handed in: the marks, or a word on when they come. */
function Marks({ result }) {
  if (!result.released) {
    const waiting = {
      after_quiz: { icon: Hourglass, text: 'After it ends' },
      manual: { icon: PenLine, text: 'Being marked' }
    }[result.waitingFor] || { icon: Clock, text: 'Not released' };
    return (
      <span className="my-wait" title={result.message || 'Marks are not released yet.'}>
        <waiting.icon size={14} aria-hidden="true"/>{waiting.text}
      </span>
    );
  }
  // Shown before marking was finished: the score so far, and what is still to mark.
  const unmarked = result.pendingManual > 0;
  return (
    <span className="my-score" title={unmarked ? 'Your teacher has not marked every short answer yet. The score counts only what is marked so far.' : undefined}>
      <strong>{result.score}<small>/{outOf(result)}</small></strong>
      <span className={unmarked ? 'is-warn' : undefined}>{unmarked ? `${result.pendingManual} to mark` : percent(percentOf(result))}</span>
    </span>
  );
}

function DownloadButton({ result, showToast }) {
  const [busy, setBusy] = useState(false);
  if (!result.canDownload) return null;
  const download = async () => {
    setBusy(true);
    try { await downloadMyResponses(result.code); } catch (error) { showToast(error.message); }
    setBusy(false);
  };
  const label = result.pendingManual
    ? 'Download your responses (some short answers are not marked yet)'
    : 'Download your responses: your answers, the correct answers and your marks';
  return (
    <button className="my-download" type="button" disabled={busy} onClick={download} aria-label={label} title={label}>
      <Download size={18} aria-hidden="true"/>
    </button>
  );
}

/**
 * One test. The whole row opens it (the link's hit area covers the row);
 * the download button sits above that, left of the marks, so every row's
 * marks line up.
 */
function TestRow({ result, go, showToast }) {
  const state = standing(result);
  const target = targetOf(result);
  const action = result.isOwner && state.go ? 'Manage' : state.go;
  return (
    <li className={`my-row is-${state.group}`}>
      <span className="my-row-text">
        <a className="my-row-link" href={target} onClick={(event) => { event.preventDefault(); go(target); }}
          title={result.isOwner ? 'Your test: edit it, follow its students and see its results' : undefined}>
          {result.title}
        </a>
        <span>{state.detail}</span>
      </span>
      <DownloadButton result={result} showToast={showToast}/>
      <span className="my-row-side">
        {state.group === 'done' ? <Marks result={result}/>
          : action ? <span className="my-go">{action}</span>
            : <span className={`my-state is-${state.tone}`}>{state.word}</span>}
      </span>
      {!action && <ChevronRight className="my-row-chevron" size={18} aria-hidden="true"/>}
    </li>
  );
}

function TestList({ title, results, go, showToast }) {
  if (!results.length) return null;
  return (
    <section className="my-section" aria-label={title}>
      <h2>{title}</h2>
      <ul className="card my-list">
        {results.map((result) => (
          <TestRow key={`${result.code}-${result.startedAt || result.registrationStatus}`} result={result} go={go} showToast={showToast}/>
        ))}
      </ul>
    </section>
  );
}

/** How it has gone so far, from the marks released: three numbers, nothing more. */
function Stats({ results }) {
  const submitted = results.filter((result) => result.attemptStatus === 'submitted');
  if (!submitted.length) return null;
  const marked = submitted.filter((result) => result.released && outOf(result));
  const average = marked.length ? marked.reduce((total, result) => total + percentOf(result), 0) / marked.length : null;
  const best = marked.length ? Math.max(...marked.map(percentOf)) : null;
  return (
    <dl className="my-stats" title={marked.length < submitted.length ? 'Average and best count the tests whose marks are out.' : undefined}>
      <div><dt>Tests taken</dt><dd>{submitted.length}</dd></div>
      <div><dt>Average</dt><dd>{average === null ? '—' : percent(average)}</dd></div>
      <div><dt>Best</dt><dd>{best === null ? '—' : percent(best)}</dd></div>
    </dl>
  );
}

/** The student's SAP ID: shown once saved, asked for while missing. */
function SapIdLine({ profile, onAdd }) {
  if (profile === undefined) return null;
  if (profile?.sapId) {
    return <p className="my-sap-id" title="Only an administrator can change it">SAP ID <strong>{profile.sapId}</strong></p>;
  }
  return (
    <div className="notice my-sap-missing">
      <span>Add your SAP ID before you join a test.</span>
      <button className="button button-secondary button-small" type="button" onClick={onAdd}>Add SAP ID</button>
    </div>
  );
}

/**
 * The student's home: what needs them now (a test to continue, begin or be let
 * into), then every result, newest first, with tests they missed at the end.
 */
export function MyResultsScreen({ go, showToast, isStudent = false }) {
  const [results, setResults] = useState(null);
  // undefined while loading; null when the student has no SAP ID yet.
  const [profile, setProfile] = useState(undefined);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    api('/api/me/results').then((data) => setResults(data.results)).catch((error) => showToast(error.message));
  }, [showToast]);

  useEffect(() => {
    if (!isStudent) return;
    api('/api/student/profile')
      .then((data) => { setProfile(data.profile); if (!data.profile) setAsking(true); })
      .catch((error) => showToast(error.message));
  }, [isStudent, showToast]);

  const grouped = { now: [], done: [], past: [] };
  for (const result of results || []) grouped[standing(result).group].push(result);
  grouped.now.sort((left, right) => (NOW_ORDER[standing(left).go] ?? 2) - (NOW_ORDER[standing(right).go] ?? 2));
  grouped.done.sort((left, right) => String(right.submittedAt || '').localeCompare(String(left.submittedAt || '')));

  return (
    <section className="admin-list my-dash">
      <header className="my-head">
        {/* Faculty reach this from their account menu: tests they sat themselves, not their students'. */}
        <div className="page-heading">
          <h1>{isStudent ? 'My results' : 'My test attempts'}</h1>
          <InfoTip label={isStudent ? 'About My results' : 'About My test attempts'}>
            {isStudent
              ? 'Every test you joined. Marks show once your teacher releases them.'
              : 'Tests you sat yourself. Your students\' results are on each test\'s Results tab, under Tests.'}
          </InfoTip>
        </div>
        {isStudent && <SapIdLine profile={profile} onAdd={() => setAsking(true)}/>}
      </header>
      {!results ? (
        <Skeleton rows={3} label="Loading your results"/>
      ) : results.length === 0 ? (
        <div className="card empty empty-state">
          <strong>No tests yet</strong>
          <p>{isStudent
            ? 'When your teacher shows a QR code in class, scan it with your phone to join the test. Your results will appear here.'
            : 'A test you join yourself, a colleague\'s or your own, shows here.'}</p>
        </div>
      ) : (
        <>
          <Stats results={results}/>
          <TestList title="Now" results={grouped.now} go={go} showToast={showToast}/>
          <TestList title="Results" results={[...grouped.done, ...grouped.past]} go={go} showToast={showToast}/>
        </>
      )}
      {asking && (
        <SapIdPrompt
          showToast={showToast}
          onClose={() => setAsking(false)}
          onSaved={(saved) => { setProfile(saved); setAsking(false); }}
        />
      )}
    </section>
  );
}
