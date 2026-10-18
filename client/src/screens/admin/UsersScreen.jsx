import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, BadgeCheck, CalendarDays, Check, ChevronLeft, ChevronRight, CircleCheck, GraduationCap, KeyRound, MoreVertical, Search, Trash2, Users } from 'lucide-react';
import { api, post } from '../../lib/api.js';
import { loadCached, setCached, useCached } from '../../lib/cache.js';
import { shortDateTime } from '../../lib/format.js';
import { InfoPill } from '../../components/StatusPill.jsx';
import { UserDetailModal } from './modals/UserDetailModal.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { applyFilters } from '../../lib/filters.js';
import { openedFromName } from '../../lib/people.js';
import { USER_FILTERS } from './user-filters.js';
import { mergeUserRows, sortUsers, USER_SORTS, USUAL_USER_SORT, userEmail } from './user-list.js';
import { useAutoHideScrollbar } from '../../lib/useAutoHideScrollbar.js';
import { Modal } from '../../components/Modal.jsx';

/** People per page on the Users list. */
const PAGE_SIZE = 20;

const userPath = (email) => `/api/admin/users/${encodeURIComponent(email)}`;

/** Each filter option's icon, coloured by what it means (filters.css). */
const FILTER_ICONS = {
  student: { icon: GraduationCap, tone: 'info' },
  faculty: { icon: BadgeCheck, tone: 'ok' },
  password: { icon: KeyRound, tone: 'muted' },
  microsoft: { icon: Check, tone: 'muted' },
  'no-account': { icon: Users, tone: 'muted' },
  'no-signin': { icon: KeyRound, tone: 'muted' },
  allowed: { icon: CircleCheck, tone: 'ok' },
  blocked: { icon: Ban, tone: 'bad' }
};
const SORT_ICONS = { created: CalendarDays, login: KeyRound, name: Users };
const SORTS = USER_SORTS.map((sort) => ({ ...sort, icon: SORT_ICONS[sort.id] }));

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
      <input className="text-input" type="email" name="block-email" required aria-label="College email to block" placeholder="Their college email" value={email} onChange={(event) => setEmail(event.target.value)}/>
      <input className="text-input" name="block-reason" maxLength="200" aria-label="Reason for blocking (optional)" placeholder="Reason (optional)" value={reason} onChange={(event) => setReason(event.target.value)}/>
      <button className="button button-warning" disabled={busy} type="submit"><Ban size={16} aria-hidden="true"/>Block email</button>
    </form>
  );
}

/**
 * One display list of accounts and blocked emails. The server still keeps
 * blocks separately, so deleting an account never lifts its block.
 */
export function UsersScreen({ currentEmail, canManage, showToast }) {
  // Shown at once when seen before (lib/cache.js), and asked again behind.
  const users = useCached(canManage ? '/api/admin/users' : null);
  const data = users.data || null;
  const people = useMemo(() => mergeUserRows(data?.accounts, data?.blocked), [data]);
  const setData = (next) => setCached('/api/admin/users', next);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState(USUAL_USER_SORT);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [blockingEmail, setBlockingEmail] = useState(false);
  const list = useRef(null);
  const listScroll = useAutoHideScrollbar();
  const summaryScroll = useAutoHideScrollbar();
  const [opened, setOpened] = useState(null); // the account row, shown at once while its details load
  // A person named in the address (?admin=users&user=<email>) - a name clicked
  // elsewhere (components/PersonLink.jsx) - opens once the list is here.
  const named = new URLSearchParams(window.location.search).get('user');
  useEffect(() => {
    if (!named || !data) return;
    const email = named.trim().toLowerCase();
    // Someone with no account any more still has their tests: their details fill in once loaded.
    setOpened((current) => (current?.email === email ? current
      : data.accounts.find((account) => account.email.toLowerCase() === email) || { email, name: email }));
  }, [named, data]);
  // Closing a person opened from their name goes back to where the name was;
  // opened by its address, it stays on Users, without the person in the address.
  const closeDetail = useCallback(() => {
    setOpened(null);
    if (!new URLSearchParams(window.location.search).get('user')) return;
    if (openedFromName()) { window.history.back(); return; }
    const url = new URL(window.location.href);
    url.searchParams.delete('user');
    window.history.replaceState(window.history.state, '', url);
  }, []);

  const load = useCallback(() => loadCached('/api/admin/users', { force: true }), []);
  const firstFailure = !users.data && users.error;
  useEffect(() => { if (firstFailure) showToast(firstFailure.message); }, [firstFailure, showToast]);

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
  const blockedEmails = useMemo(() => new Set(people.filter((entry) => entry.blocked).map((entry) => entry.email)), [people]);

  // Searched first; the filter's counts are taken from that.
  const searched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return people.filter((account) => `${account.name} ${account.email} ${account.sapId || ''}`.toLowerCase().includes(needle));
  }, [people, query]);
  const accounts = useMemo(() => sortUsers(applyFilters(searched, USER_FILTERS, filters), sort), [searched, filters, sort]);
  const filtered = query.trim() || filters.length > 0;

  // The numbers at a glance, from the list already loaded.
  const stats = useMemo(() => {
    return {
      total: people.length,
      students: people.filter((account) => account.hasAccount && account.role === 'student').length,
      faculty: people.filter((account) => account.hasAccount && account.role !== 'student').length,
      blocked: blockedEmails.size
    };
  }, [people, blockedEmails]);
  const showGroup = (selected) => {
    setFilters(selected); setQuery(''); setPage(0);
    list.current?.scrollTo({ top: 0 });
  };
  const tiles = [
    { id: 'total', label: 'All users', value: stats.total, icon: Users, tone: 'info', filters: [] },
    { id: 'student', label: 'Students', value: stats.students, icon: GraduationCap, tone: 'info', filters: ['student'] },
    { id: 'faculty', label: 'Faculty', value: stats.faculty, icon: BadgeCheck, tone: 'ok', filters: ['faculty'] },
    { id: 'blocked', label: 'Blocked', value: stats.blocked, icon: Ban, tone: stats.blocked ? 'bad' : 'muted', filters: ['blocked'] }
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
    list.current?.scrollTo({ top: 0 });
  };

  if (!canManage) {
    return <section className="card empty"><h1>Not available</h1><p>Your account is not allowed to manage users.</p></section>;
  }
  if (!data) return <Skeleton rows={6} label="Loading users"/>;

  return (
    <section className="admin-list users-workspace">
      <aside className="users-sidebar" aria-label="Users overview">
        <header className="users-sidebar-heading">
          <div className="page-heading">
            <h1>Users</h1>
            <InfoTip label="About Users">Accounts and blocked emails share one list. Open an account for its tests; the Blocked badge has its block details.</InfoTip>
          </div>
        </header>
        <nav className="users-summary auto-hide-scrollbar" aria-label="Users at a glance" {...summaryScroll}>
          {tiles.map((tile) => {
            const active = !query.trim() && filters.length === tile.filters.length && tile.filters.every((id) => filters.includes(id));
            return (
              <button key={tile.id} type="button" className={'users-summary-button is-' + tile.tone + (active ? ' is-selected' : '')}
                aria-controls="users-list" aria-pressed={active} onClick={() => showGroup(tile.filters)} title={'Show ' + tile.label.toLowerCase()}>
                <tile.icon className="users-summary-icon" size={18} aria-hidden="true"/>
                <span>{tile.label}</span><strong>{tile.value}</strong>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="users-content">
        <section className="card students-card users-accounts-card" aria-label="User accounts">
          <header className="students-toolbar" id="users-accounts">
            <div>
              <h2>Accounts</h2>
              <p>{filtered ? 'Showing ' + accounts.length + ' of ' + people.length + ' entries' : people.length + ' users'}</p>
            </div>
            <div className="controls">
              <label className="search-field">
                <Search size={16} aria-hidden="true"/>
                <input className="text-input" type="search" name="users-search" aria-label="Search" placeholder="Name, email or SAP ID"
                  value={query} onChange={(event) => setQuery(event.target.value)}/>
              </label>
              <FilterMenu groups={USER_FILTERS} rows={searched} selected={filters} onChange={setFilters} icons={FILTER_ICONS}
                title="Sort and filter users" allLabel="Sort & filter" sorts={SORTS} sort={sort} onSort={setSort} autoHideScrollbar/>
              <button type="button" className="button button-secondary users-block-toggle" aria-label="Block an email" title="Block an email" onClick={() => setBlockingEmail(true)}>
                <Ban size={16} aria-hidden="true"/><span className="toolbar-text">Block email</span>
              </button>
            </div>
          </header>

          <div className="table-scroll users-list-scroll auto-hide-scrollbar" ref={list} id="users-list" role="region" aria-label="Users list" tabIndex={0} {...listScroll}>
            <table className="live-table users-table">
              <thead>
                <tr><th>Person</th><th>Role</th><th className="col-created">Created</th><th>Last login</th><th className="column-actions">Actions</th></tr>
              </thead>
              <tbody>
                {shown.map((account) => {
                  const self = account.email === userEmail(currentEmail);
                  const name = account.hasAccount ? account.name : 'Blocked email';
                  return (
                    <tr key={account.email} className={'users-row-open' + (account.blocked ? ' is-blocked' : '') + (!account.hasAccount ? ' is-email-only' : '')}
                      title={account.hasAccount ? 'Open to see tests, scores and SAP ID' : 'No account. Unblock to allow this email again.'}
                      onClick={account.hasAccount ? () => setOpened(account) : undefined}
                      tabIndex={account.hasAccount ? 0 : undefined} aria-label={account.hasAccount ? account.name + ': open' : account.email + ': blocked email, no account'}
                      onKeyDown={(event) => {
                        if (account.hasAccount && (event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                          event.preventDefault(); setOpened(account);
                        }
                      }}>
                      <td data-label="Person">
                        <div className="user-card-head">
                          <span className="user-card-who">
                            <span className="user-card-name">
                              <strong>{name}</strong>
                              {account.blocked && <span className="users-block-marker" onClick={(event) => event.stopPropagation()}>
                                <InfoPill tone="danger">Blocked</InfoPill>
                                <InfoTip label={'Block details for ' + account.email}>
                                  <span className="info-tip-list">
                                    <span>{account.block?.reason || 'No reason given.'}</span>
                                    {account.block?.blockedAt && <span><strong>Blocked</strong>{shortDateTime(account.block.blockedAt)}</span>}
                                    {account.block?.blockedBy && <span><strong>By</strong>{account.block.blockedBy}</span>}
                                  </span>
                                </InfoTip>
                              </span>}
                            </span>
                            <span className="table-subtext"><span className="user-email">{account.email}</span>{account.sapId && <span className="user-sap-inline">{account.sapId}</span>}</span>
                          </span>
                          <span className="user-card-menu" onClick={(event) => event.stopPropagation()}>
                            <ActionMenu label={<MoreVertical size={18} aria-label={'More for ' + account.email}/>} trigger="icon" items={[
                              !self && !busy && { label: account.blocked ? 'Unblock' : 'Block', icon: account.blocked ? CircleCheck : Ban, tone: account.blocked ? 'ok' : 'warn',
                                onSelect: () => account.blocked ? unblock(account.email) : block(account.email) },
                              account.hasAccount && !self && !busy && { label: 'Delete', icon: Trash2, danger: true, onSelect: () => remove(account) }
                            ]}/>
                          </span>
                        </div>
                      </td>
                      <td data-label="Role"><InfoPill tone={account.hasAccount && account.role === 'faculty' ? 'success' : 'muted'}>{!account.hasAccount ? 'No account' : account.role === 'faculty' ? 'Faculty' : 'Student'}</InfoPill></td>
                      <td data-label="Created" className="col-created">{shortDateTime(account.createdAt)}</td>
                      <td data-label="Last login">
                        {shortDateTime(account.lastSignInAt)}
                        {account.hasAccount && !account.hasPassword && <span className="table-subtext">No password (Microsoft only)</span>}
                      </td>
                      <td data-label="Actions" onClick={(event) => event.stopPropagation()}>
                        <div className="table-actions user-buttons">
                          {account.blocked
                            ? <button className="button button-unblock button-small" type="button" title="Unblock" disabled={busy || self} onClick={() => unblock(account.email)}><CircleCheck size={16} aria-hidden="true"/><span className="button-label">Unblock</span></button>
                            : <button className="button button-warning button-small" type="button" title="Block" disabled={busy || self} onClick={() => block(account.email)}><Ban size={16} aria-hidden="true"/><span className="button-label">Block</span></button>}
                          {account.hasAccount && <button className="button button-danger button-small" type="button" title="Delete" disabled={busy || self} onClick={() => remove(account)}><Trash2 size={16} aria-hidden="true"/><span className="button-label">Delete</span></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {accounts.length === 0 && <p className="empty">{people.length ? 'Nobody matches these filters.' : 'No users yet.'}</p>}
          </div>

          {accounts.length > PAGE_SIZE && (
            <nav className="pager users-pager" aria-label="Pages">
              <span className="pager-status">Showing {firstShown}–{lastShown} of {accounts.length}</span>
              <div className="pager-buttons">
                <button className="button button-secondary button-small" type="button" disabled={current === 0} onClick={() => turnTo(current - 1)} aria-label="Previous" title="Previous page">
                  <ChevronLeft size={16} aria-hidden="true"/><span className="pager-button-text">Previous</span>
                </button>
                <span className="pager-page">Page {current + 1} of {pageCount}</span>
                <button className="button button-secondary button-small" type="button" disabled={current >= pageCount - 1} onClick={() => turnTo(current + 1)} aria-label="Next" title="Next page">
                  <span className="pager-button-text">Next</span><ChevronRight size={16} aria-hidden="true"/>
                </button>
              </div>
            </nav>
          )}
        </section>
      </div>

      {blockingEmail && <Modal label="Block an email" className="users-block-modal" onClose={() => setBlockingEmail(false)}>
        <h1>Block an email</h1>
        <BlockForm busy={busy} onBlock={async (email, reason) => {
          const done = await block(email, reason);
          if (done) setBlockingEmail(false);
          return done;
        }}/>
      </Modal>}
      {opened && (
        <UserDetailModal
          account={opened}
          currentEmail={currentEmail}
          isSelf={userEmail(opened.email) === userEmail(currentEmail)}
          isBlocked={blockedEmails.has(userEmail(opened.email))}
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
