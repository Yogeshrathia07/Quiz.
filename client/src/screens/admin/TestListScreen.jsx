import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, ArrowDownAZ, BarChart3, CalendarClock, CalendarDays, CircleCheck, ClipboardList, Copy, Download,
  Eye, EyeOff, Hourglass, Lock, MoreVertical, PenLine, Plus, Radio, Search, Settings2, Trash2, UserCheck, UserX, Users
} from 'lucide-react';
import { api, downloadSpreadsheet, post } from '../../lib/api.js';
import { shortDateTime } from '../../lib/format.js';
import { applyFilters, optionCounts } from '../../lib/filters.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
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

function QuizCard({ test, onOpen, onResults, onMark, onExport, onDuplicate, onArchive, onDelete }) {
  const status = statusOf(test);
  const registered = known(test.registrationCount) ? test.registrationCount : 0;
  const submitted = known(test.submittedCount) ? test.submittedCount : null;
  const meta = [
    known(test.questionCount) ? `${test.questionCount} question${test.questionCount === 1 ? '' : 's'}` : null,
    known(test.runMinutes) ? `${test.runMinutes} min` : null,
    test.code
  ].filter(Boolean);
  return (
    <article className={`ql-card${test.archivedAt ? ' is-archived' : ''}`}>
      <div className="ql-card-title">
        <h2><a href={`/?admin=${encodeURIComponent(test.code)}`} onClick={(event) => { event.preventDefault(); onOpen(); }}>{test.title}</a></h2>
        <p>{meta.map((part, index) => <span key={part} className="ql-meta-part">{index > 0 && ' · '}{part}</span>)}</p>
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
          <button className="button button-tinted" type="button" onClick={onResults}><BarChart3 size={16} aria-hidden="true"/>Results</button>
        )}
        <ActionMenu
          label={<MoreVertical size={18} aria-label={`More actions for ${test.title}`}/>}
          trigger="icon"
          items={[
            { label: 'Manage', icon: Settings2, onSelect: onOpen },
            { label: 'Export to Excel', icon: Download, onSelect: onExport },
            { label: 'Duplicate', icon: Copy, onSelect: onDuplicate },
            { label: test.archivedAt ? 'Restore from archive' : 'Archive', icon: test.archivedAt ? ArchiveRestore : Archive, onSelect: onArchive },
            { label: 'Delete…', icon: Trash2, danger: true, onSelect: onDelete }
          ]}
        />
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

export function TestListScreen({ go, showToast }) {
  const [tests, setTests] = useState(null);
  const [failed, setFailed] = useState('');
  const [query, setQuery] = useState('');
  // The home page links straight to a filter: ?admin=tests&filter=marking:due.
  const [filters, setFilters] = useState(() => testFiltersFrom(new URLSearchParams(window.location.search).get('filter')));
  const [sort, setSort] = useState(USUAL_TEST_SORT);
  const [deleting, setDeleting] = useState(null);

  // Written back as it changes - replaced, not added, so Back still leaves the page - and a reload keeps it.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (filters.length) url.searchParams.set('filter', filters.join(','));
    else url.searchParams.delete('filter');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [filters]);

  const load = useCallback(async () => {
    try {
      const data = await api('/api/admin/tests');
      setTests(data.tests);
      setFailed('');
    } catch (error) {
      setFailed(error.message);
      showToast(error.message, 'error');
    }
  }, [showToast]);
  useEffect(() => { load(); }, [load]);
  // Registration and submission counts stay current without a reload.
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) api('/api/admin/tests').then((data) => setTests(data.tests)).catch(() => {}); }, 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const { pool, visible, counts } = useMemo(() => {
    if (!tests) return { pool: [], visible: [], counts: {} };
    const needle = query.trim().toLowerCase();
    const searched = needle ? tests.filter((test) => `${test.title} ${test.code}`.toLowerCase().includes(needle)) : tests;
    const pool = unlessArchivedTicked(searched, filters);
    return {
      pool,
      visible: sortTests(applyFilters(pool, TEST_FILTERS, filters), sort),
      // Archived counts what ticking it would bring back, even while it is not ticked.
      counts: { ...optionCounts(pool, TEST_FILTERS), [ARCHIVED]: searched.filter((test) => test.archivedAt).length }
    };
  }, [tests, query, filters, sort]);

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
      <div>
        <p className="page-kicker">Admin portal</p>
        <div className="page-heading">
          <h1>My quizzes</h1>
          <InfoTip label="About My quizzes">
            Every quiz you created. Open one to run it, follow its students, mark short answers and see its results;
            the filter narrows to what needs you.
          </InfoTip>
        </div>
      </div>
      <button className="button button-primary" type="button" onClick={() => go('/?admin=create')}><Plus size={18} aria-hidden="true"/>Create quiz</button>
    </header>
  );

  if (!tests && failed) {
    return (
      <section className="ql-page">
        {header}
        <div className="ql-error" role="alert">
          <strong>Your quizzes could not be loaded</strong>
          <p>{failed}</p>
          <button className="button button-secondary" type="button" onClick={load}>Try again</button>
        </div>
      </section>
    );
  }
  if (!tests) return <section className="ql-page">{header}<Skeleton rows={4} label="Loading your quizzes"/></section>;

  return (
    <section className="ql-page">
      {header}

      {tests.length > 0 && (
        <div className="ql-toolbar">
          <label className="ql-search">
            <Search size={17} aria-hidden="true"/>
            <input className="text-input" type="search" aria-label="Search quizzes" placeholder="Search name or code…" value={query} onChange={(event) => setQuery(event.target.value)}/>
          </label>
          <FilterMenu groups={TEST_FILTERS} rows={pool} selected={filters} onChange={setFilters} icons={ICONS} counts={counts}
            total={tests.length} title="Filter quizzes" allLabel="All quizzes" sorts={SORTS} sort={sort} onSort={setSort}/>
        </div>
      )}

      {tests.length === 0 ? (
        <div className="ql-empty">
          <ClipboardList size={28} aria-hidden="true"/>
          <strong>No quizzes yet</strong>
          <p>Create your first quiz, then show its QR code in class so students can register.</p>
          <button className="button button-primary" type="button" onClick={() => go('/?admin=create')}><Plus size={18} aria-hidden="true"/>Create quiz</button>
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
            <QuizCard
              key={test.code}
              test={test}
              onOpen={() => go(`/?admin=${encodeURIComponent(test.code)}`)}
              onResults={() => go(`/?admin=${encodeURIComponent(test.code)}&tab=responses`)}
              onMark={() => go(`/?admin=${encodeURIComponent(test.code)}&tab=responses&results=marking:awaiting`)}
              onExport={() => downloadSpreadsheet(test.code).then(() => showToast('Excel download started.', 'success'), (error) => showToast(error.message, 'error'))}
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
