import { useEffect, useMemo, useState } from 'react';
import { ArrowDownAZ, ArrowLeft, CalendarDays, CircleDot, Lock, Plus, Search, Smartphone, Users } from 'lucide-react';
import { post } from '../../lib/api.js';
import { dropCached, useCached } from '../../lib/cache.js';
import { shortDateTime } from '../../lib/format.js';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
import { applyFilters } from '../../lib/filters.js';
import { sessionFilters, sortSessions } from './attendance-filters.js';
import { LIST_URL, plural, sessionUrl } from './attendance-paths.js';
import { SessionForm } from './SessionForm.jsx';
import { SessionDateFilter } from './SessionDateFilter.jsx';
import { EMPTY_SESSION_DATES, sessionDateFilter } from './session-dates.js';

const SORTS = [
  { id: 'date', label: 'Date', icon: CalendarDays, directions: [{ id: 'desc', label: 'Newest first' }, { id: 'asc', label: 'Oldest first' }] },
  { id: 'title', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'present', label: 'Present', icon: Users, directions: [{ id: 'desc', label: 'Most first' }, { id: 'asc', label: 'Fewest first' }] }
];
const USUAL_SORT = 'date-desc';

const FILTER_ICONS = {
  open: { icon: CircleDot, tone: 'ok' },
  closed: { icon: Lock, tone: 'muted' }
};
const GROUPS = sessionFilters();

export function AttendanceListScreen({ go, showToast }) {
  // Shown at once when seen before (lib/cache.js), and asked again behind.
  const register = useCached('/api/admin/attendance');
  const data = register.data || null;
  // Keep the form in the address so the navbar, Back and browser history agree.
  const creating = new URLSearchParams(window.location.search).get('new') === '1';
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState([]);
  const [dates, setDates] = useState(EMPTY_SESSION_DATES);
  const [sort, setSort] = useState(USUAL_SORT);
  const firstFailure = !register.data && register.error;
  useEffect(() => { if (firstFailure) showToast(firstFailure.message); }, [firstFailure, showToast]);

  const sessions = data?.sessions;
  const calendar = useMemo(() => sessionDateFilter(dates), [dates]);
  if (!sessions) return <Skeleton rows={3} label="Loading attendance"/>;

  const showForm = creating;
  const text = search.trim().toLowerCase();
  const searched = text ? sessions.filter((session) => session.title.toLowerCase().includes(text) || session.code.toLowerCase().includes(text)) : sessions;
  const dated = searched.filter(calendar.test);
  const shown = sortSessions(applyFilters(dated, GROUPS, filters), sort);
  const open = (event, code) => { event.preventDefault(); go(sessionUrl(code)); };
  const backLabel = 'Back to Attendance';
  const leaveForm = () => go(LIST_URL);

  return (
    <section className="min-page att-page">
      <header className="min-head att-list-head">
        <div className={`page-heading${showForm ? ' att-create-heading' : ''}`}>
          {showForm && (
            <button className="att-back" type="button" onClick={leaveForm} aria-label={backLabel} title={backLabel}>
              <ArrowLeft size={18} aria-hidden="true"/>
            </button>
          )}
          <h1>Attendance</h1>
          <InfoTip label="About attendance">Show a QR in class: students scan it with their phone to mark themselves present.</InfoTip>
        </div>
        {!showForm && (
          <div className="min-head-actions">
            <button className="button button-primary att-new" type="button" onClick={() => go(`${LIST_URL}&new=1`)}>
              <Plus size={16} aria-hidden="true"/>New attendance
            </button>
          </div>
        )}
      </header>

      {showForm && (
        <SessionForm lastVenue={data.lastVenue} showToast={showToast} onCancel={leaveForm} onSave={async (body) => {
          const created = await post('/api/admin/attendance', body);
          // This list and the home page are asked for fresh next time, with the new session in them.
          dropCached('/api/admin/attendance');
          dropCached('/api/admin/home');
          go(sessionUrl(created.session.code));
        }}/>
      )}

      {!showForm && sessions.length === 0 && (
        <div className="card min-card att-empty">
          <p>No attendance sessions yet. Choose New attendance to start.</p>
        </div>
      )}

      {sessions.length > 0 && (
        <div className="card att-sessions">
          <div className="att-toolbar">
            <label className="search-field">
              <Search size={16} aria-hidden="true"/>
                <input className="text-input" type="search" aria-label="Search sessions" placeholder="Search name or code"
                value={search} onChange={(event) => setSearch(event.target.value)}/>
            </label>
            <FilterMenu groups={GROUPS} rows={dated} selected={filters} onChange={setFilters} icons={FILTER_ICONS} title="Filter sessions" allLabel="All sessions"
              total={searched.length} shown={shown.length} sorts={SORTS} sort={sort} onSort={setSort}
              extraActive={calendar.active} extraLabel={calendar.label} onReset={() => setDates(EMPTY_SESSION_DATES)}
              sections={[{ id: 'dates', title: 'Dates', weight: (dates.mode === 'all' ? 4 : 9) + (calendar.error ? 2 : 0),
                content: <SessionDateFilter value={dates} onChange={setDates} error={calendar.error}/> }]}/>
          </div>
          {shown.length === 0 ? (
            <div className="att-empty">
              <p>No session matches this search or filter.</p>
              <button className="link-button" type="button" onClick={() => { setSearch(''); setFilters([]); setDates(EMPTY_SESSION_DATES); }}>Clear search and filters</button>
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
