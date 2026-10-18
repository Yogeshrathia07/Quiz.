import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, ArrowDownAZ, BarChart3, CalendarClock, CalendarDays, CircleCheck, ClipboardList, Copy,
  Eye, EyeOff, FileCheck2, Hourglass, Lock, MoreVertical, PenLine, Plus, Radio, Search, Settings2, Trash2, UserCheck, UserX, Users
} from 'lucide-react';
import { api, downloadSpreadsheet, post } from '../../lib/api.js';
import { loadCached, prefetch, useCached } from '../../lib/cache.js';
import { wholeClassPath } from '../../lib/dashboard-paths.js';
import { hasQuizResults } from '../../lib/admin-navigation.js';
import { shortDateTime } from '../../lib/format.js';
import { applyFilters, optionCounts } from '../../lib/filters.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
import { MyTestsList } from '../student/MyResultsScreen.jsx';
import {
  ARCHIVED, TEST_FILTERS, USUAL_TEST_SORT, papersToMark, quizFacts, sortTests, statusOf, testFiltersFrom, unlessArchivedTicked
} from './test-filters.js';

/* ------------------------------------------------------------ helpers */

const SORTS = [
  { id: 'created', label: 'Created', icon: CalendarDays, directions: [{ id: 'desc', label: 'Newest first' }, { id: 'asc', label: 'Oldest first' }] },
  { id: 'title', label: 'Title', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'score', label: 'Average score', icon: BarChart3, directions: [{ id: 'desc', label: 'Highest first' }, { id: 'asc', label: 'Lowest first' }] },
  { id: 'registered', label: 'Registrations', icon: Users, directions: [{ id: 'desc', label: 'Most first' }, { id: 'asc', label: 'Fewest first' }] }
];
const RESULT_LIST_FILTERS = TEST_FILTERS.filter((group) => group.id !== 'requests');

const ICONS = {
  'status:live': { icon: Radio, tone: 'ok' },
  'status:scheduled': { icon: CalendarClock, tone: 'info' },
  'status:waiting': { icon: Hourglass, tone: 'muted' },
  'status:completed': { icon: CircleCheck, tone: 'ok' },
  [ARCHIVED]: { icon: Archive, tone: 'muted' },
  'requests:waiting': { icon: UserCheck, tone: 'warn' },
  'requests:none': { icon: UserCheck, tone: 'muted' },
  'marking:due': { icon: PenLine, tone: 'warn' },
  'marking:done': { icon: PenLine, tone: 'muted' },
  'marks:released': { icon: Eye, tone: 'ok' },
  'marks:held': { icon: EyeOff, tone: 'muted' },
  'created:today': { icon: CalendarDays, tone: 'info' },
  'created:week': { icon: CalendarDays, tone: 'info' },
  'created:month': { icon: CalendarDays, tone: 'muted' },
  'created:older': { icon: CalendarDays, tone: 'muted' }
};

const FACT_ICONS = { when: CalendarDays, absent: UserX, requests: UserCheck, marking: PenLine, average: BarChart3, marks: Eye, frozen: Lock };
/** A fact's icon: a tick once every paper is marked, a closed eye while marks are held. */
const factIcon = (fact) => (fact.id === 'marking' && fact.tone === 'ok' ? CircleCheck
  : fact.id === 'marks' && fact.tone === 'warn' ? EyeOff : FACT_ICONS[fact.id]);

/* ---------------------------------------------------------- the pieces */

/** A number, or nothing: a missing value shows as a dash, never "undefined" or "NaN". */
const known = (value) => typeof value === 'number' && Number.isFinite(value);

function QuizCard({ test, onOpen, onResults, onMark, onDuplicate, onArchive, onDelete }) {
  const status = statusOf(test);
  const registered = known(test.registrationCount) ? test.registrationCount : 0;
  const submitted = known(test.submittedCount) ? test.submittedCount : null;
  const meta = [
    known(test.questionCount) ? `${test.questionCount} question${test.questionCount === 1 ? '' : 's'}` : null,
    known(test.runMinutes) ? `${test.runMinutes} min` : null
  ].filter(Boolean);
  return (
    <article className={`ql-card${test.archivedAt ? ' is-archived' : ''}`}
      onPointerEnter={() => prefetch(wholeClassPath(test.code))} onFocus={() => prefetch(wholeClassPath(test.code))}>
      <div className="ql-card-title">
        <h2><a href={`/?admin=${encodeURIComponent(test.code)}`} onClick={(event) => { event.preventDefault(); onOpen(); }}>{test.title}</a></h2>
        <p>
          {meta.length > 0 && <span>{meta.join(' · ')}</span>}
          {test.code && <span className="ql-meta-code">{meta.length > 0 && <span className="ql-meta-separator"> · </span>}{test.code}</span>}
        </p>
        {/* Minimal: when, and what waits on you. Who missed it, the average and the marks show on hover. */}
        <ul className="ql-facts">
          {quizFacts(test, shortDateTime).map((fact) => {
            const Icon = factIcon(fact);
            return <li key={fact.id} className={`is-${fact.tone}${fact.more ? ' is-more' : ''}`}><Icon size={13} aria-hidden="true"/>{fact.text}</li>;
          })}
        </ul>
      </div>
      <span className={`badge is-${status.tone}`}>{status.label}</span>
      <p className="ql-progress-text">
        <strong>{submitted === null ? '—' : submitted}</strong> / {registered} submitted
      </p>
      <div className="ql-actions">
        {/* Papers waiting for a mark: straight to them; otherwise (marks released anyway too) to the results. */}
        {papersToMark(test) > 0 ? (
          <button className="button button-tinted" type="button" onClick={onMark}
            title={`${papersToMark(test)} paper${papersToMark(test) === 1 ? ' has' : 's have'} short answers to mark`}>
            <PenLine size={16} aria-hidden="true"/>Mark {papersToMark(test)}
          </button>
        ) : (
          <button className="button button-tinted" type="button" onClick={onResults}><BarChart3 size={16} aria-hidden="true"/>View results</button>
        )}
        <ActionMenu
          label={<MoreVertical size={18} aria-label={`More actions for ${test.title}`}/>}
          trigger="icon"
          items={[
            { label: 'Manage', icon: Settings2, onSelect: onOpen },
            { label: 'Duplicate', icon: Copy, onSelect: onDuplicate },
            { label: test.archivedAt ? 'Restore from archive' : 'Archive', icon: test.archivedAt ? ArchiveRestore : Archive, onSelect: onArchive },
            { label: 'Delete…', icon: Trash2, danger: true, onSelect: onDelete }
          ]}
        />
      </div>
    </article>
  );
}

/** Results are grouped by quiz; student-level scores stay inside that quiz. */
function ResultCard({ test, onOpen, onMark, onResults, onManage }) {
  const status = statusOf(test);
  const marking = papersToMark(test);
  return (
    <article className={`ql-card ql-result-card${test.archivedAt ? ' is-archived' : ''}`}
      onPointerEnter={() => prefetch(wholeClassPath(test.code))} onFocus={() => prefetch(wholeClassPath(test.code))}>
      <div className="ql-card-title">
        <h2><a href={`/?admin=${encodeURIComponent(test.code)}&tab=analysis`} onClick={(event) => { event.preventDefault(); onOpen(); }}>{test.title}</a></h2>
        <p><span>{test.code}</span><span className="ql-result-date">{shortDateTime(test.closedAt || test.startedAt || test.createdAt)}</span></p>
        {marking > 0 && <p className="ql-result-pending"><PenLine size={13} aria-hidden="true"/>{marking} to mark</p>}
      </div>
      <span className={`badge is-${status.tone}`}>{status.label}</span>
      <p className="ql-progress-text"><strong>{known(test.submittedCount) ? test.submittedCount : '—'}</strong> submitted
        {known(test.averageScore) && <small>Average {test.averageScore}%{marking > 0 ? ' so far' : ''}</small>}
      </p>
      <div className="ql-actions">
        <button className="button button-tinted" type="button" onClick={marking > 0 ? onMark : onOpen}>
          {marking > 0 ? <PenLine size={16} aria-hidden="true"/> : <BarChart3 size={16} aria-hidden="true"/>}{marking > 0 ? `Mark ${marking}` : 'View results'}
        </button>
        <ActionMenu label={<MoreVertical size={18} aria-label={`More results for ${test.title}`}/>} trigger="icon" items={[
          { label: 'Analysis', icon: BarChart3, onSelect: onOpen },
          { label: 'Results', icon: FileCheck2, onSelect: onResults },
          { label: 'Manage quiz', icon: Settings2, onSelect: onManage }
        ]}/>
      </div>
    </article>
  );
}

function DeleteDialog({ test, onCancel, onConfirm }) {
  const [exportFirst, setExportFirst] = useState(test.registrationCount > 0);
  const [busy, setBusy] = useState(false);
  const confirm = async () => { setBusy(true); await onConfirm(exportFirst); setBusy(false); };
  return (
    <Modal label={`Delete ${test.title}`} onClose={onCancel}>
      <div className="dialog">
        <h1>Delete “{test.title}”?</h1>
        <p>
          This removes the quiz{test.registrationCount ? `, its ${test.registrationCount} registration${test.registrationCount === 1 ? '' : 's'} and every answer and mark` : ''}.
          {' '}It cannot be undone.
        </p>
        {test.registrationCount > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={exportFirst} onChange={(event) => setExportFirst(event.target.checked)}/>
            Download the results as Excel first
          </label>
        )}
        <div className="dialog-actions">
          <button className="button button-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="button button-danger-solid" type="button" onClick={confirm} disabled={busy}>
            <Trash2 size={16} aria-hidden="true"/>{busy ? 'Deleting…' : 'Delete quiz'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- page */

export function TestListScreen({ area = 'quizzes', navigation, go, showToast }) {
  const isResults = area === 'results';
  const groups = isResults ? RESULT_LIST_FILTERS : TEST_FILTERS;
  // Both lists show at once when seen before (lib/cache.js), and are asked again behind.
  const created = useCached('/api/admin/tests');
  const owned = created.data?.tests || null;
  const tests = useMemo(() => owned ? (isResults ? owned.filter(hasQuizResults) : owned) : null, [owned, isResults]);
  const failed = !tests && created.error ? created.error.message : '';
  const [query, setQuery] = useState('');
  // The home page links straight to a filter: ?admin=tests&filter=marking:due.
  const [filters, setFilters] = useState(() => {
    const allowed = new Set(groups.flatMap((group) => group.options.map((option) => option.id)));
    return testFiltersFrom(new URLSearchParams(window.location.search).get('filter')).filter((id) => allowed.has(id));
  });
  const [sort, setSort] = useState(USUAL_TEST_SORT);
  const [deleting, setDeleting] = useState(null);
  // Quizzes they created (run with every admin tool), or tests they sat
  // themselves (?view=taken) - a colleague's or their own tried out - which
  // open just as they would for a student.
  const [view, setView] = useState(() => (isResults && new URLSearchParams(window.location.search).get('view') === 'taken' ? 'taken' : 'created'));
  const sat = useCached(isResults ? '/api/me/results' : null);
  const taken = sat.data ? sat.data.results || [] : sat.error ? [] : null;
  const choose = (next) => { setView(next); if (next === 'taken') loadCached('/api/me/results', { force: true }).catch(() => {}); };

  // A primary-nav click can revisit the same URL after this page's local
  // switch changed it with replaceState. Follow that navigation explicitly.
  useEffect(() => {
    if (!navigation) return;
    const allowed = new Set(groups.flatMap((group) => group.options.map((option) => option.id)));
    setView(isResults && navigation.view === 'taken' ? 'taken' : 'created');
    setFilters(testFiltersFrom(navigation.filter).filter((id) => allowed.has(id)));
    setQuery('');
  }, [navigation, isResults, groups]);

  // Written back as it changes - replaced, not added, so Back still leaves the page - and a reload keeps it.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('admin', area);
    if (filters.length) url.searchParams.set('filter', filters.join(','));
    else url.searchParams.delete('filter');
    if (view === 'taken') url.searchParams.set('view', 'taken');
    else url.searchParams.delete('view');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [area, filters, view]);

  const load = useCallback(async () => {
    try { await loadCached('/api/admin/tests', { force: true }); }
    catch (error) { showToast(error.message, 'error'); }
  }, [showToast]);
  // A first load that failed says so once (the page offers Try again).
  const firstFailure = view !== 'taken' && !created.data && created.error;
  useEffect(() => { if (firstFailure) showToast(firstFailure.message, 'error'); }, [firstFailure, showToast]);
  // Registration and submission counts stay current without a reload.
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) loadCached('/api/admin/tests', { force: true }).catch(() => {}); }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const { pool, visible, counts } = useMemo(() => {
    if (!tests) return { pool: [], visible: [], counts: {} };
    const needle = query.trim().toLowerCase();
    const searched = needle ? tests.filter((test) => `${test.title} ${test.code}`.toLowerCase().includes(needle)) : tests;
    const pool = unlessArchivedTicked(searched, filters);
    return {
      pool,
      visible: sortTests(applyFilters(pool, groups, filters), sort),
      // Archived counts what ticking it would bring back, even while it is not ticked.
      counts: { ...optionCounts(pool, groups), [ARCHIVED]: searched.filter((test) => test.archivedAt).length }
    };
  }, [tests, query, filters, sort, groups]);

  const act = async (run, success) => {
    try { await run(); showToast(success, 'success'); await load(); } catch (error) { showToast(error.message, 'error'); }
  };
  const path = (test, rest = '') => `/api/admin/tests/${encodeURIComponent(test.code)}${rest}`;
  const remove = async (exportFirst) => {
    const test = deleting;
    try {
      if (exportFirst) await downloadSpreadsheet(test.code);
      await api(path(test), { method: 'DELETE' });
      setDeleting(null);
      showToast(`“${test.title}” was deleted${exportFirst ? '; its results were downloaded' : ''}.`, 'success');
      load();
    } catch (error) { showToast(error.message, 'error'); }
  };
  const clearFilters = () => { setQuery(''); setFilters([]); };
  const filtered = query || filters.length > 0;
  // Nothing left out by a search or filter, yet nothing shown: every quiz is archived.
  const allArchived = !filtered && tests?.length > 0 && tests.every((test) => test.archivedAt);

  const header = (
    <header className="ql-head" id="my-quizzes">
      <div className="page-heading">
        <h1>{isResults ? 'Results' : 'Quizzes'}</h1>
        <InfoTip label={isResults ? 'About Results' : 'About Quizzes'}>
          {view === 'taken'
            ? 'Tests you sat yourself, a colleague\'s or your own. Each opens as it does for a student: your paper, then your marks and answers.'
            : isResults ? 'Quiz results, marking and analysis. Open a quiz to review its students, email results or download Excel.'
              : 'Create and manage your quizzes. Open one to run it and follow its students, or use View results for scores and analysis.'}
        </InfoTip>
      </div>
      <div className="ql-controls">
        {isResults && <div className="segmented ql-switch ql-results-switch" role="radiogroup" aria-label="Which results">
          {[['created', 'Quiz results', tests ? tests.filter((test) => !test.archivedAt).length : undefined], ['taken', 'My attempts', taken?.length]].map(([id, label, count]) => (
            <button key={id} type="button" role="radio" aria-checked={view === id} className={view === id ? 'is-on' : ''} onClick={() => choose(id)}>
              {label}{known(count) && <span className="segmented-count">{count}</span>}
            </button>
          ))}
        </div>}
        {!isResults && <button className="button ql-create" type="button" onClick={() => go('/?admin=create')}><Plus size={18} aria-hidden="true"/>Create quiz</button>}
      </div>
    </header>
  );

  if (view === 'taken') {
    return <section className="ql-page ql-results-page">{header}
      {sat.error && !sat.data ? <div className="ql-error" role="alert"><strong>Your attempts could not be loaded</strong><p>{sat.error.message}</p>
        <button className="button button-secondary" type="button" onClick={() => loadCached('/api/me/results', { force: true }).catch((error) => showToast(error.message, 'error'))}>Try again</button>
      </div> : !taken ? <Skeleton rows={3} label="Loading your attempts"/> : taken.length === 0 ? <div className="ql-empty">
        <ClipboardList size={28} aria-hidden="true"/><strong>No attempts yet</strong><p>Quizzes you take yourself appear here.</p>
      </div> : <div className="ql-taken"><MyTestsList results={taken} go={go} showToast={showToast}/></div>}
    </section>;
  }

  if (!tests && failed) {
    return (
      <section className="ql-page">
        {header}
        <div className="ql-error" role="alert">
          <strong>Your {isResults ? 'results' : 'quizzes'} could not be loaded</strong>
          <p>{failed}</p>
          <button className="button button-secondary" type="button" onClick={load}>Try again</button>
        </div>
      </section>
    );
  }
  if (!tests) return <section className="ql-page">{header}<Skeleton rows={4} label={`Loading your ${isResults ? 'results' : 'quizzes'}`}/></section>;

  return (
    <section className={`ql-page${isResults ? ' ql-results-page' : ''}`}>
      {header}

      {tests.length > 0 && (
        <div className="ql-toolbar">
          <label className="ql-search">
            <Search size={17} aria-hidden="true"/>
            <input className="text-input" type="search" name="tests-search" aria-label="Search quizzes" placeholder="Search name or code…" value={query} onChange={(event) => setQuery(event.target.value)}/>
          </label>
          <FilterMenu groups={groups} rows={pool} selected={filters} onChange={setFilters} icons={ICONS} counts={counts}
            total={tests.length} title={isResults ? 'Sort & filter results' : 'Filter quizzes'} allLabel={isResults ? 'All results' : 'All quizzes'} sorts={SORTS} sort={sort} onSort={setSort}/>
        </div>
      )}

      {tests.length === 0 ? (
        <div className="ql-empty">
          <ClipboardList size={28} aria-hidden="true"/>
          <strong>{isResults ? 'No results yet' : 'No quizzes yet'}</strong>
          <p>{isResults ? 'Quizzes appear here after a submission or when the quiz ends.' : 'Create your first quiz, then show its QR code in class so students can register.'}</p>
          {isResults ? <button className="button button-secondary" type="button" onClick={() => go('/?admin=quizzes')}>Browse quizzes</button>
            : <button className="button ql-create" type="button" onClick={() => go('/?admin=create')}><Plus size={18} aria-hidden="true"/>Create quiz</button>}
        </div>
      ) : allArchived ? (
        <div className="ql-empty">
          <Archive size={26} aria-hidden="true"/>
          <strong>Every quiz is archived</strong>
          <p>Archived quizzes are kept, just out of the way.</p>
          <button className="button button-secondary" type="button" onClick={() => setFilters([ARCHIVED])}>Show archived</button>
        </div>
      ) : visible.length === 0 ? (
        <div className="ql-empty">
          <Search size={26} aria-hidden="true"/>
          <strong>No quizzes match</strong>
          <p>{filters.length === 1 && filters[0] === ARCHIVED && !query ? 'Nothing is archived.' : 'Try another name or code, or clear the filters.'}</p>
          {filtered && <button className="button button-secondary" type="button" onClick={clearFilters}>Clear filters</button>}
        </div>
      ) : (
        <div className="ql-list">
          {visible.map((test) => (
            isResults ? <ResultCard key={test.code} test={test}
              onOpen={() => go(`/?admin=${encodeURIComponent(test.code)}&tab=analysis`)}
              onMark={() => go(`/?admin=${encodeURIComponent(test.code)}&tab=responses&results=marking:awaiting`)}
              onResults={() => go(`/?admin=${encodeURIComponent(test.code)}&tab=responses`)}
              onManage={() => go(`/?admin=${encodeURIComponent(test.code)}`)}/>
            : <QuizCard
              key={test.code}
              test={test}
              onOpen={() => go(`/?admin=${encodeURIComponent(test.code)}`)}
              onResults={() => go(`/?admin=${encodeURIComponent(test.code)}&tab=analysis`)}
              onMark={() => go(`/?admin=${encodeURIComponent(test.code)}&tab=responses&results=marking:awaiting`)}
              onDuplicate={() => act(() => post(path(test, '/duplicate')), `A copy of “${test.title}” was created.`)}
              onArchive={() => act(() => post(path(test, '/archive'), { archived: !test.archivedAt }), test.archivedAt ? 'Restored from the archive.' : 'Archived. Find it under Filter → Archived.')}
              onDelete={() => setDeleting(test)}
            />
          ))}
        </div>
      )}

      {deleting && <DeleteDialog test={deleting} onCancel={() => setDeleting(null)} onConfirm={remove}/>}
    </section>
  );
}
