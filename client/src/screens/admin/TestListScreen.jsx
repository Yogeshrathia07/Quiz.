import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive, ArchiveRestore, BarChart3, ClipboardList, Copy, Download, MoreVertical, Plus, Search,
  Settings2, SlidersHorizontal, Trash2, X
} from 'lucide-react';
import { api, downloadSpreadsheet, post } from '../../lib/api.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { Modal } from '../../components/Modal.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';

/* ------------------------------------------------------------ helpers */

/** Where a quiz stands, in the words and colours of its badge. */
function statusOf(test) {
  if (test.archivedAt) return { id: 'archived', label: 'Archived', tone: 'neutral' };
  if (test.isClosed) return { id: 'completed', label: 'Completed', tone: 'success' };
  if (test.isStarted) return { id: 'live', label: 'Live', tone: 'live' };
  if (test.startMode === 'scheduled') return { id: 'scheduled', label: 'Scheduled', tone: 'info' };
  return { id: 'waiting', label: 'Not started', tone: 'neutral' };
}

const STATUS_FILTERS = [
  ['all', 'All statuses'], ['live', 'Live'], ['scheduled', 'Scheduled'], ['waiting', 'Not started'], ['completed', 'Completed'], ['archived', 'Archived']
];
const SORTS = [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['title', 'Title A–Z'], ['score', 'Highest score']];

function Select({ label, value, options, onChange }) {
  return (
    <label className="ql-select">
      <span className="sr-only">{label}</span>
      <select className="select" value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        {options.map(([id, text]) => <option key={id} value={id}>{text}</option>)}
      </select>
    </label>
  );
}

/* ---------------------------------------------------------- the pieces */

/** A number, or nothing: a missing value shows as a dash, never "undefined" or "NaN". */
const known = (value) => typeof value === 'number' && Number.isFinite(value);

function QuizCard({ test, onOpen, onResults, onExport, onDuplicate, onArchive, onDelete }) {
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
      </div>
      <span className={`badge is-${status.tone}`}>{status.label}</span>
      <p className="ql-progress-text">
        <strong>{submitted === null ? '—' : submitted}</strong> / {registered} submitted
        {test.pendingCount > 0 && <em>{test.pendingCount} waiting</em>}
      </p>
      <div className="ql-actions">
        <button className="button button-tinted" type="button" onClick={onResults}><BarChart3 size={16} aria-hidden="true"/>Results</button>
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
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('newest');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [deleting, setDeleting] = useState(null);

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

  const visible = useMemo(() => {
    if (!tests) return [];
    const needle = query.trim().toLowerCase();
    const rows = tests.filter((test) => {
      const state = statusOf(test).id;
      if (status === 'all' ? state === 'archived' : state !== status) return false;
      if (needle && !`${test.title} ${test.code}`.toLowerCase().includes(needle)) return false;
      return true;
    });
    const by = {
      newest: (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0),
      oldest: (a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
      title: (a, b) => a.title.localeCompare(b.title),
      score: (a, b) => (known(b.averageScore) ? b.averageScore : -1) - (known(a.averageScore) ? a.averageScore : -1)
    }[sort];
    return [...rows].sort(by);
  }, [tests, query, status, sort]);

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
  const clearFilters = () => { setQuery(''); setStatus('all'); };
  const filtered = query || status !== 'all';

  const header = (
    <header className="ql-head">
      <div>
        <p className="page-kicker">Admin portal</p>
        <h1>My quizzes</h1>
        <p>Create, manage and view the performance of your quizzes.</p>
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
        <div className={`ql-toolbar${filtersOpen ? ' is-open' : ''}`}>
          <label className="ql-search">
            <Search size={17} aria-hidden="true"/>
            <input className="text-input" type="search" placeholder="Search quizzes by name or code…" value={query} onChange={(event) => setQuery(event.target.value)}/>
          </label>
          <button className="button button-secondary ql-filter-toggle" type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)}>
            {filtersOpen ? <X size={17} aria-hidden="true"/> : <SlidersHorizontal size={17} aria-hidden="true"/>}Filters
          </button>
          <div className="ql-filters">
            <Select label="Status" value={status} options={STATUS_FILTERS} onChange={setStatus}/>
            <Select label="Sort" value={sort} options={SORTS} onChange={setSort}/>
          </div>
        </div>
      )}

      {tests.length === 0 ? (
        <div className="ql-empty">
          <ClipboardList size={28} aria-hidden="true"/>
          <strong>No quizzes yet</strong>
          <p>Create your first quiz, then show its QR code in class so students can register.</p>
          <button className="button button-primary" type="button" onClick={() => go('/?admin=create')}><Plus size={18} aria-hidden="true"/>Create quiz</button>
        </div>
      ) : visible.length === 0 ? (
        <div className="ql-empty">
          <Search size={26} aria-hidden="true"/>
          <strong>No quizzes match</strong>
          <p>{status === 'archived' ? 'Nothing is archived.' : 'Try another name or code, or clear the filters.'}</p>
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
              onExport={() => downloadSpreadsheet(test.code).then(() => showToast('Excel download started.', 'success'), (error) => showToast(error.message, 'error'))}
              onDuplicate={() => act(() => post(path(test, '/duplicate')), `A copy of “${test.title}” was created.`)}
              onArchive={() => act(() => post(path(test, '/archive'), { archived: !test.archivedAt }), test.archivedAt ? 'Restored from the archive.' : 'Archived. Find it under Status → Archived.')}
              onDelete={() => setDeleting(test)}
            />
          ))}
        </div>
      )}

      {deleting && <DeleteDialog test={deleting} onCancel={() => setDeleting(null)} onConfirm={remove}/>}
    </section>
  );
}
