import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, ArrowDownUp, Ban, BadgeCheck, Check, ChevronLeft, ChevronRight, GraduationCap, KeyRound, Search, Users } from 'lucide-react';
import { api, post } from '../../lib/api.js';
import { shortDateTime } from '../../lib/format.js';
import { InfoPill } from '../../components/StatusPill.jsx';
import { UserDetailModal } from './modals/UserDetailModal.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { applyFilters } from '../../lib/filters.js';
import { USER_FILTERS } from './user-filters.js';

/** People per page on the Users list. */
const PAGE_SIZE = 20;

const userPath = (email) => `/api/admin/users/${encodeURIComponent(email)}`;

/** Each filter option's icon, coloured by what it means (filters.css). */
const FILTER_ICONS = {
  student: { icon: GraduationCap, tone: 'info' },
  faculty: { icon: BadgeCheck, tone: 'ok' },
  password: { icon: KeyRound, tone: 'muted' },
  microsoft: { icon: Check, tone: 'muted' }
};
const SORTS = {
  newest: ['Newest first', (a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)],
  oldest: ['Oldest first', (a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)],
  recent: ['Last login', (a, b) => Date.parse(b.lastSignInAt || 0) - Date.parse(a.lastSignInAt || 0)],
  name: ['Name A–Z', (a, b) => String(a.name || '').localeCompare(String(b.name || ''))]
};

function BlockForm({ busy, onBlock }) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  return (
    <form
      className="users-block-form"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await onBlock(email, reason)) { setEmail(''); setReason(''); }
      }}
    >
      <input className="text-input" type="email" required placeholder="Your college email" value={email} onChange={(event) => setEmail(event.target.value)}/>
      <input className="text-input" maxLength="200" placeholder="Reason (optional)" value={reason} onChange={(event) => setReason(event.target.value)}/>
      <button className="button button-warning" disabled={busy} type="submit">Block email</button>
    </form>
  );
}

/**
 * Every account, plus the blocked list, which lasts until lifted.
 */
export function UsersScreen({ currentEmail, canManage, showToast }) {
  const [data, setData] = useState(null);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState(null); // the account row, shown at once while its details load
  const closeDetail = useCallback(() => setOpened(null), []);

  const load = useCallback(() => api('/api/admin/users').then(setData), []);
  useEffect(() => { if (canManage) load().catch((error) => showToast(error.message)); }, [canManage, load, showToast]);

  const run = async (request, message) => {
    setBusy(true);
    try {
      setData(await request());
      showToast(message);
      return true;
    } catch (error) {
      showToast(error.message);
      return false;
    } finally { setBusy(false); }
  };

  const remove = (account) => {
    if (!window.confirm(`Delete ${account.email}? Their account, password and saved SAP ID are removed and they are signed out. Their test marks are kept, and they can create a new account.`)) return false;
    run(() => api(userPath(account.email), { method: 'DELETE' }), 'Account deleted.');
    return true;
  };
  const block = (email, reason = '') => {
    if (!window.confirm(`Block ${email}? They are signed out and cannot log in or take any test until you unblock them.`)) return false;
    return run(() => post(`${userPath(email)}/block`, { reason }), `${email} is blocked.`);
  };
  const unblock = (email) => run(() => post(`${userPath(email)}/unblock`), `${email} is unblocked.`);
  const blockedEmails = useMemo(() => new Set((data?.blocked || []).map((entry) => entry.email)), [data]);

  // Searched first; the filter's counts are taken from that.
  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data?.accounts || []).filter((account) => `${account.name} ${account.email} ${account.sapId || ''}`.toLowerCase().includes(needle));
  }, [data, query]);
  const accounts = useMemo(() => [...applyFilters(searched, USER_FILTERS, filters)].sort(SORTS[sort][1]), [searched, filters, sort]);
  const filtered = query.trim() || filters.length > 0;

  // The numbers at a glance, from the list already loaded.
  const stats = useMemo(() => {
    const list = data?.accounts || [];
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return {
      total: list.length,
      students: list.filter((account) => account.role === 'student').length,
      faculty: list.filter((account) => account.role !== 'student').length,
      active: list.filter((account) => (Date.parse(account.lastSignInAt || 0) || 0) >= weekAgo).length,
      blocked: (data?.blocked || []).length
    };
  }, [data]);
  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  // Each count opens what it counts: the list filtered to them, or the blocked list.
  const tiles = [
    { id: 'total', label: 'Accounts', value: stats.total, icon: Users, tone: 'info', open: () => { setFilters([]); setQuery(''); scrollTo('users-accounts'); } },
    { id: 'students', label: 'Students', value: stats.students, icon: GraduationCap, tone: 'info', open: () => { setFilters(['student']); scrollTo('users-accounts'); } },
    { id: 'faculty', label: 'Faculty', value: stats.faculty, icon: BadgeCheck, tone: 'ok', open: () => { setFilters(['faculty']); scrollTo('users-accounts'); } },
    { id: 'active', label: 'Active this week', value: stats.active, icon: Activity, tone: 'ok', open: () => { setSort('recent'); scrollTo('users-accounts'); } },
    { id: 'blocked', label: 'Blocked', value: stats.blocked, icon: Ban, tone: stats.blocked ? 'bad' : 'muted', open: () => scrollTo('users-blocked') }
  ];

  // One page at a time. Any new search, filter or sort starts again from page 1.
  useEffect(() => { setPage(0); }, [query, filters, sort]);
  const pageCount = Math.max(1, Math.ceil(accounts.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const shown = accounts.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const firstShown = accounts.length ? current * PAGE_SIZE + 1 : 0;
  const lastShown = current * PAGE_SIZE + shown.length;
  // Turning the page starts at the top of the list, not where the buttons were.
  const turnTo = (next) => {
    setPage(next);
    document.getElementById('users-accounts')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };

  if (!canManage) {
    return <section className="card empty"><h1>Not available</h1><p>Your account is not allowed to manage users.</p></section>;
  }
  if (!data) return <Skeleton rows={6} label="Loading users"/>;

  return (
    <section className="admin-list">
      <header className="page-title-row">
        <div>
          <h1>Users</h1>
          <p>Open a person to see their tests and SAP ID, or to delete or block them.</p>
        </div>
      </header>

      <div className="stat-tiles" aria-label="Users at a glance">
        {tiles.map((tile) => (
          <button key={tile.id} type="button" className={`stat-tile is-${tile.tone}`} onClick={tile.open}>
            <tile.icon className="stat-tile-icon" size={18} aria-hidden="true"/>
            <strong>{tile.value}</strong>
            <span>{tile.label}</span>
          </button>
        ))}
      </div>

      <section className="card students-card">
        {/* One row, like the dashboard's lists: search, the tick-box filter, and the order. */}
        <header className="students-toolbar" id="users-accounts">
          <div>
            <h2>Accounts</h2>
            <p>{filtered ? `Showing ${accounts.length} of ${data.accounts.length}` : `${data.accounts.length} account${data.accounts.length === 1 ? '' : 's'}`}</p>
          </div>
          <div className="controls">
            <label className="search-field">
              <Search size={16} aria-hidden="true"/>
              <input className="text-input" type="search" aria-label="Search" placeholder="Search name, email or SAP ID" value={query} onChange={(event) => setQuery(event.target.value)}/>
            </label>
            <FilterMenu groups={USER_FILTERS} rows={searched} selected={filters} onChange={setFilters} icons={FILTER_ICONS} title="Filter accounts" allLabel="Everyone"/>
            <ActionMenu
              label={`Sort: ${SORTS[sort][0]}`}
              icon={ArrowDownUp}
              items={Object.entries(SORTS).map(([id, [label]]) => ({
                label, icon: id === sort ? Check : undefined, tone: id === sort ? 'info' : undefined, onSelect: () => setSort(id)
              }))}
            />
          </div>
        </header>
        <div className="table-scroll">
          <table className="live-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th className="col-created">Created</th>
                <th>Last login</th>
                <th className="column-actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((account) => {
                const self = account.email === currentEmail;
                return (
                  <tr key={account.email} className="users-row-open" title="Open to see tests, scores and SAP ID" onClick={() => setOpened(account)}>
                    <td data-label="Person">
                      <strong>{account.name}</strong>
                      <span className="table-subtext">{account.email}{account.sapId ? ` · ${account.sapId}` : ''}</span>
                    </td>
                    <td data-label="Role"><InfoPill tone={account.role === 'faculty' ? 'success' : 'muted'}>{account.role === 'faculty' ? 'Faculty' : 'Student'}</InfoPill></td>
                    <td data-label="Created" className="col-created">{shortDateTime(account.createdAt)}</td>
                    <td data-label="Last login">
                      {shortDateTime(account.lastSignInAt)}
                      {!account.hasPassword && <span className="table-subtext">No password (Microsoft only)</span>}
                    </td>
                    <td data-label="Actions" onClick={(event) => event.stopPropagation()}>
                      <div className="table-actions">
                        <button className="button button-secondary button-small" onClick={() => setOpened(account)}>View</button>
                        <button className="button button-warning button-small" disabled={busy || self} onClick={() => block(account.email)}>Block</button>
                        <button className="button button-danger button-small" disabled={busy || self} onClick={() => remove(account)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {accounts.length === 0 && <p className="empty">{data.accounts.length ? 'Nobody matches these filters.' : 'No accounts yet.'}</p>}
          {accounts.length > PAGE_SIZE && (
            <nav className="pager" aria-label="Pages">
              <span className="pager-status">Showing {firstShown}–{lastShown} of {accounts.length}</span>
              <div className="pager-buttons">
                <button className="button button-secondary button-small" type="button" disabled={current === 0} onClick={() => turnTo(current - 1)}>
                  <ChevronLeft size={16} aria-hidden="true"/>Previous
                </button>
                <span className="pager-page">Page {current + 1} of {pageCount}</span>
                <button className="button button-secondary button-small" type="button" disabled={current >= pageCount - 1} onClick={() => turnTo(current + 1)}>
                  Next<ChevronRight size={16} aria-hidden="true"/>
                </button>
              </div>
            </nav>
          )}
        </div>
      </section>

      <section className="card students-card users-blocked">
        <div className="users-toolbar" id="users-blocked">
          <div>
            <h2>Blocked</h2>
            <p className="table-subtext">Blocked people cannot log in, so they cannot take any test.</p>
          </div>
        </div>
        <BlockForm busy={busy} onBlock={block}/>
        <div className="table-scroll">
          <table className="live-table">
            <thead>
              <tr><th>Email</th><th>Reason</th><th>Blocked</th><th className="column-actions">Actions</th></tr>
            </thead>
            <tbody>
              {data.blocked.map((entry) => (
                <tr key={entry.email}>
                  <td data-label="Email"><strong>{entry.email}</strong></td>
                  <td data-label="Reason">{entry.reason || <span className="table-subtext">—</span>}</td>
                  <td data-label="Blocked">
                    {shortDateTime(entry.blockedAt)}
                    <span className="table-subtext">by {entry.blockedBy}</span>
                  </td>
                  <td data-label="Actions">
                    <div className="table-actions">
                      <button className="button button-success button-small" disabled={busy} onClick={() => unblock(entry.email)}>Unblock</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.blocked.length === 0 && <p className="empty">Nobody is blocked.</p>}
        </div>
      </section>
      {opened && (
        <UserDetailModal
          account={opened}
          currentEmail={currentEmail}
          isSelf={opened.email === currentEmail}
          isBlocked={blockedEmails.has(opened.email)}
          busy={busy}
          onBlock={() => block(opened.email)}
          onUnblock={() => unblock(opened.email)}
          onDelete={() => { if (remove(opened)) closeDetail(); }}
          onClose={closeDetail}
          onChanged={() => load().catch(() => {})}
          showToast={showToast}
        />
      )}
    </section>
  );
}
