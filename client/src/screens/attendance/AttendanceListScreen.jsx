import { useEffect, useMemo, useState } from 'react';
import { ArrowDownAZ, BookOpen, CalendarDays, CircleDot, Download, Lock, Search, ShieldCheck, Smartphone, Users } from 'lucide-react';
import { api, post } from '../../lib/api.js';
import { shortDateTime } from '../../lib/format.js';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
import { applyFilters } from '../../lib/filters.js';
import { sessionFilters, sortSessions } from './attendance-filters.js';
import { plural, sessionUrl } from './attendance-paths.js';
import { SessionForm } from './SessionForm.jsx';
import { AttendanceExportModal } from './AttendanceExportModal.jsx';

const SORTS = [
  { id: 'date', label: 'Date', icon: CalendarDays, directions: [{ id: 'desc', label: 'Newest first' }, { id: 'asc', label: 'Oldest first' }] },
  { id: 'title', label: 'Class', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'present', label: 'Present', icon: Users, directions: [{ id: 'desc', label: 'Most first' }, { id: 'asc', label: 'Fewest first' }] }
];
const USUAL_SORT = 'date-desc';

const iconsFor = (groups) => ({
  open: { icon: CircleDot, tone: 'ok' },
  closed: { icon: Lock, tone: 'muted' },
  'when:today': { icon: CalendarDays, tone: 'info' },
  'when:week': { icon: CalendarDays, tone: 'info' },
  'when:month': { icon: CalendarDays, tone: 'muted' },
  'when:older': { icon: CalendarDays, tone: 'muted' },
  flagged: { icon: Smartphone, tone: 'bad' },
  unflagged: { icon: ShieldCheck, tone: 'ok' },
  ...Object.fromEntries((groups.find((group) => group.id === 'class')?.options || []).map((option) => [option.id, { icon: BookOpen, tone: 'muted' }]))
});

export function AttendanceListScreen({ go, showToast }) {
  const [data, setData] = useState(null);
  // ?new=1 (the home page's "Take attendance") opens straight on the form.
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get('new') === '1');
  const [exporting, setExporting] = useState(false);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState(USUAL_SORT);
  useEffect(() => {
    api('/api/admin/attendance').then(setData).catch((error) => showToast(error.message));
  }, [showToast]);

  const sessions = data?.sessions;
  const groups = useMemo(() => sessionFilters(sessions || []), [sessions]);
  const icons = useMemo(() => iconsFor(groups), [groups]);
  if (!sessions) return <Skeleton rows={3} label="Loading attendance"/>;

  const showForm = creating || sessions.length === 0;
  const text = search.trim().toLowerCase();
  const searched = text ? sessions.filter((session) => session.title.toLowerCase().includes(text) || session.code.toLowerCase().includes(text)) : sessions;
  const shown = sortSessions(applyFilters(searched, groups, filters), sort);
  const narrowed = shown.length !== sessions.length;
  const open = (event, code) => { event.preventDefault(); go(sessionUrl(code)); };

  return (
    <section className="min-page att-page">
      <header className="min-head">
        <div>
          <h1>Attendance</h1>
          <p>Show a QR in class. Students scan it to mark themselves.</p>
        </div>
        {!showForm && (
          <div className="min-head-actions">
            <button className="button button-secondary" type="button" onClick={() => setExporting(true)} disabled={!shown.length}
              title={narrowed ? `Download the ${plural(shown.length, 'session')} shown as one Excel register` : 'Download your sessions as one Excel register'}>
              <Download size={16} aria-hidden="true"/>Download Excel
            </button>
            <button className="button button-primary" type="button" onClick={() => setCreating(true)}>New attendance</button>
          </div>
        )}
      </header>
      {exporting && <AttendanceExportModal sessions={shown} filtered={narrowed} onClose={() => setExporting(false)} showToast={showToast}/>}

      {showForm && (
        <SessionForm lastVenue={data.lastVenue} showToast={showToast} onCancel={sessions.length ? () => setCreating(false) : null} onSave={async (body) => {
          const created = await post('/api/admin/attendance', body);
          go(sessionUrl(created.session.code));
        }}/>
      )}

      {sessions.length > 0 && (
        <div className="card att-sessions">
          <div className="att-toolbar">
            <label className="search-field">
              <Search size={16} aria-hidden="true"/>
              <input className="text-input" type="search" aria-label="Search sessions" placeholder="Search class or code"
                value={search} onChange={(event) => setSearch(event.target.value)}/>
            </label>
            <FilterMenu groups={groups} rows={searched} selected={filters} onChange={setFilters} icons={icons} title="Filter sessions" allLabel="All sessions"
              sorts={SORTS} sort={sort} onSort={setSort}/>
          </div>
          {shown.length === 0 ? (
            <div className="att-empty">
              <p>No session matches this search or filter.</p>
              <button className="link-button" type="button" onClick={() => { setSearch(''); setFilters([]); }}>Clear search and filters</button>
            </div>
          ) : (
            <ul className="min-list">
              {shown.map((session) => (
                <li key={session.code}>
                  <a href={sessionUrl(session.code)} onClick={(event) => open(event, session.code)}>
                    <span className="min-list-main">
                      <strong>{session.title}</strong>
                      <small>{shortDateTime(session.createdAt)}{session.round > 1 ? ` · ${session.round} rounds` : ''}</small>
                    </span>
                    <span className="min-list-side">
                      {session.flaggedCount > 0 && (
                        <span className="att-list-flag" title={`${plural(session.flaggedCount, 'mark')} flagged by the phone check`}>
                          <Smartphone size={13} aria-hidden="true"/>{session.flaggedCount}
                        </span>
                      )}
                      <span className="att-list-count">{session.presentCount} present{session.pendingCount ? ` · ${session.pendingCount} pending` : ''}</span>
                      <span className={`min-state${session.isOpen ? ' is-open' : ''}`}>{session.isOpen ? 'Open' : 'Closed'}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
