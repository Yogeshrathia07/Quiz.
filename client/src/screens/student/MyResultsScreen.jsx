import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ, Ban, BarChart3, CalendarDays, CalendarX, ChevronRight, CircleCheck, CircleDashed, CirclePlay, ClipboardCheck, Clock,
  Download, Hourglass, Minus, PenLine, Search, TrendingDown, TrendingUp, Trophy
} from 'lucide-react';
import { downloadMyResponses } from '../../lib/api.js';
import { prefetch, setCached, useCached } from '../../lib/cache.js';
import { applyFilters } from '../../lib/filters.js';
import { DownloadQuestion } from './DownloadQuestion.jsx';
import { MarksGauge } from '../../components/MarksGauge.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { clockTime, durationLabel, shortDateTime } from '../../lib/format.js';
import { InfoTip } from '../../components/InfoTip.jsx';
import { SapIdPrompt } from './SapIdPrompt.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
import {
  MY_RESULT_FILTERS, USUAL_RESULT_SORT, band, byUrgency, outOf, percentOf, placeOf, searchResults, sortResults
} from './result-filters.js';

/**
 * One you handed in opens on its result (found by your account, so on any
 * device); any other on the test's own page - as a student, even a teacher's
 * own test, which they run from Created.
 */
const targetOf = (result) => (result.attemptStatus === 'submitted' ? `/?result=${encodeURIComponent(result.code)}`
  : `/?test=${encodeURIComponent(result.code)}`);

const percent = (value) => `${Math.round(value)}%`;

/**
 * Where one test stands for this student (result-filters.js: `now` when it is
 * waiting on them, `done` once handed in, `past` when it ended without them),
 * in a few words.
 */
function standing(result) {
  const place = placeOf(result);
  switch (place.id) {
    case 'declined': return { ...place, tone: 'danger', word: 'Declined', detail: 'Your request was not accepted' };
    case 'waiting': return { ...place, tone: 'warn', word: 'Waiting', detail: 'Your teacher has to let you in' };
    case 'continue': return { ...place, go: 'Continue', detail: `Started ${clockTime(result.startedAt)}` };
    case 'submitted': {
      const taken = result.timeTakenSeconds === null ? '' : ` · ${durationLabel(result.timeTakenSeconds)}`;
      return { ...place, detail: `${shortDateTime(result.submittedAt)}${taken}` };
    }
    case 'missed': return { ...place, tone: 'muted', word: 'Missed', detail: 'It ended before you began' };
    default: return { ...place, go: 'Open', detail: "You're approved" };
  }
}

/** The list's order, from the Filter button: a field, and which way round. */
const SORTS = [
  { id: 'date', label: 'Date', icon: CalendarDays, directions: [{ id: 'desc', label: 'Newest first' }, { id: 'asc', label: 'Oldest first' }] },
  { id: 'score', label: 'Score', icon: BarChart3, directions: [{ id: 'desc', label: 'Highest first' }, { id: 'asc', label: 'Lowest first' }] },
  { id: 'title', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] }
];

const ICONS = {
  'state:open': { icon: CirclePlay, tone: 'info' },
  'state:out': { icon: CircleCheck, tone: 'ok' },
  'state:marking': { icon: PenLine, tone: 'warn' },
  'state:held': { icon: Hourglass, tone: 'muted' },
  'state:missed': { icon: CalendarX, tone: 'muted' },
  'state:declined': { icon: Ban, tone: 'bad' },
  'score:good': { icon: TrendingUp, tone: 'ok' },
  'score:mid': { icon: Minus, tone: 'warn' },
  'score:low': { icon: TrendingDown, tone: 'bad' },
  'score:none': { icon: CircleDashed, tone: 'muted' }
};

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
  // The marks in a small open gauge - its blue, yellow and red parts filled
  // with the share right, still to mark and wrong (components/MarksGauge.jsx),
  // its numbers under the pointer; under it the percentage, or what is still to mark.
  return (
    <span className="my-score">
      <MarksGauge size="small" score={result.score} total={outOf(result)} pending={result.pendingMarks}/>
      <span className={unmarked ? 'is-warn' : `is-${band(percentOf(result))}`}>{unmarked ? `${result.pendingManual} to mark` : percent(percentOf(result))}</span>
    </span>
  );
}

function DownloadButton({ result, showToast }) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  if (!result.canDownload) return null;
  const download = async () => {
    setAsking(false);
    setBusy(true);
    try { await downloadMyResponses(result.code); } catch (error) { showToast(error.message); }
    setBusy(false);
  };
  const label = result.pendingManual
    ? 'Download your responses (some short answers are not marked yet)'
    : 'Download your responses: your answers, the correct answers and your marks';
  return (
    <>
      <button className="download-round my-download" type="button" disabled={busy} onClick={() => setAsking(true)} aria-label={label} title={label}>
        <Download size={18} aria-hidden="true"/>
      </button>
      {asking && <DownloadQuestion result={result} onConfirm={download} onCancel={() => setAsking(false)}/>}
    </>
  );
}

/**
 * One test. The whole row opens it (the link's hit area covers the row);
 * the download button sits above that, at the start of the row.
 */
function TestRow({ result, go, showToast }) {
  const state = standing(result);
  const target = targetOf(result);
  const action = state.go;
  return (
    <li className={`my-row is-${state.group}`}>
      <DownloadButton result={result} showToast={showToast}/>
      <span className="my-row-text">
        <a className="my-row-link" href={target} onClick={(event) => { event.preventDefault(); go(target); }}>{result.title}</a>
        <span>{state.detail}</span>
      </span>
      {/* The marks' ring sits above the row's link (it explains itself under the pointer); a click on it still opens the test. */}
      <span className={`my-row-side${action ? ' is-action' : ''}`} onClick={() => go(target)}>
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
      <h2>{title}<span className="my-count">{results.length}</span></h2>
      <ul className="card my-list">
        {results.map((result) => (
          <TestRow key={`${result.code}-${result.startedAt || result.registrationStatus}`} result={result} go={go} showToast={showToast}/>
        ))}
      </ul>
    </section>
  );
}

/** How it has gone so far, from the marks released: three numbers, nothing more (each with its icon where there is room). */
function Stats({ results }) {
  const submitted = results.filter((result) => result.attemptStatus === 'submitted');
  if (!submitted.length) return null;
  const marked = submitted.filter((result) => result.released && outOf(result));
  const average = marked.length ? marked.reduce((total, result) => total + percentOf(result), 0) / marked.length : null;
  const best = marked.length ? Math.max(...marked.map(percentOf)) : null;
  return (
    <dl className="my-stats" title={marked.length < submitted.length ? 'Average and best count the tests whose marks are out.' : undefined}>
      <div className="is-taken"><dt><span className="my-stat-icon" aria-hidden="true"><ClipboardCheck size={19}/></span>Tests taken</dt><dd>{submitted.length}</dd></div>
      <div className="is-average"><dt><span className="my-stat-icon" aria-hidden="true"><BarChart3 size={19}/></span>Average</dt><dd>{average === null ? '—' : percent(average)}</dd></div>
      <div className="is-best"><dt><span className="my-stat-icon" aria-hidden="true"><Trophy size={19}/></span>Best</dt><dd>{best === null ? '—' : percent(best)}</dd></div>
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
 * The tests someone joined, as they see them: three numbers, a search and a
 * Filter button (which also sorts), what needs them now (a test to continue,
 * begin or be let into), then every result - newest first unless sorted
 * otherwise, tests they missed at the end. Each test a row the list's full
 * width. The student's home, and a teacher's "Taken" under Tests.
 */
export function MyTestsList({ results, go, showToast }) {
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState(USUAL_RESULT_SORT);
  const { pool, now, done } = useMemo(() => {
    const searched = searchResults(results, query);
    const shown = applyFilters(searched, MY_RESULT_FILTERS, filters);
    const waiting = shown.filter((result) => placeOf(result).group === 'now');
    return {
      pool: searched,
      // Open now keeps the most pressing first unless another order is chosen.
      now: sort === USUAL_RESULT_SORT ? byUrgency(waiting) : sortResults(waiting, sort),
      // Missed ones have no date and no score: last, whichever way round.
      done: sortResults(shown.filter((result) => placeOf(result).group !== 'now'), sort)
    };
  }, [results, query, filters, sort]);
  // The newest few results' answers, fetched in a quiet moment, so opening one
  // is instant. The rest come when their row is pointed at or touched (lib/prefetch.js).
  const newest = sortResults(results.filter((result) => placeOf(result).group === 'done' && result.canDownload), USUAL_RESULT_SORT)
    .slice(0, 3).map((result) => result.code).join(',');
  useEffect(() => {
    if (!newest) return undefined;
    const idle = window.requestIdleCallback ? window.requestIdleCallback.bind(window) : (run) => window.setTimeout(run, 600);
    const cancel = window.cancelIdleCallback ? window.cancelIdleCallback.bind(window) : window.clearTimeout;
    const handle = idle(() => newest.split(',').forEach((code) => prefetch(`/api/me/results/${encodeURIComponent(code)}/responses`, { maxAgeMs: 60_000 })));
    return () => cancel(handle);
  }, [newest]);
  const clear = () => { setQuery(''); setFilters([]); };
  return (
    <div className="my-tests">
      <Stats results={results}/>
      <div className="ql-toolbar my-toolbar">
        <label className="ql-search">
          <Search size={17} aria-hidden="true"/>
          <input className="text-input" type="search" aria-label="Search tests" placeholder="Search name or code…" value={query} onChange={(event) => setQuery(event.target.value)}/>
        </label>
        <FilterMenu groups={MY_RESULT_FILTERS} rows={pool} selected={filters} onChange={setFilters} icons={ICONS} total={results.length}
          title="Filter tests" allLabel="All tests" sorts={SORTS} sort={sort} onSort={setSort} sortHint="Tests with no final score yet go last."/>
      </div>
      {now.length + done.length === 0 ? (
        <div className="ql-empty my-empty">
          <Search size={26} aria-hidden="true"/>
          <strong>No tests match</strong>
          <p>Try another name or code, or clear the filters.</p>
          <button className="button button-secondary" type="button" onClick={clear}>Clear filters</button>
        </div>
      ) : (
        <div className="my-lists">
          <TestList title="Now" results={now} go={go} showToast={showToast}/>
          <TestList title="Results" results={done} go={go} showToast={showToast}/>
        </div>
      )}
    </div>
  );
}

/** The student's home (and a teacher's own attempts, from their account menu). */
export function MyResultsScreen({ go, showToast, isStudent = false }) {
  // Shown at once when they were seen before (lib/cache.js), and asked again behind.
  const list = useCached('/api/me/results');
  const results = list.data?.results ?? null;
  const own = useCached(isStudent ? '/api/student/profile' : null);
  // undefined while loading; null when the student has no SAP ID yet.
  const profile = own.data ? own.data.profile : undefined;
  const [asking, setAsking] = useState(false);
  const told = useRef(new Set());
  useEffect(() => {
    for (const error of [list.error, own.error]) {
      if (error && !told.current.has(error)) { told.current.add(error); showToast(error.message); }
    }
  }, [list.error, own.error, showToast]);
  // No SAP ID yet: asked for, once, as the page opens.
  const askedOnce = useRef(false);
  useEffect(() => {
    if (own.data && !own.data.profile && !askedOnce.current) {
      askedOnce.current = true;
      setAsking(true);
    }
  }, [own.data]);

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
        <MyTestsList results={results} go={go} showToast={showToast}/>
      )}
      {asking && (
        <SapIdPrompt
          showToast={showToast}
          onClose={() => setAsking(false)}
          onSaved={(saved) => { setCached('/api/student/profile', { ...(own.data || {}), profile: saved }); setAsking(false); }}
        />
      )}
    </section>
  );
}
