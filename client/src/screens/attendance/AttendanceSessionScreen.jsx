import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlarmClock, AlarmClockCheck, AlertTriangle, ArrowDownAZ, ArrowLeft, BadgeCheck, CalendarClock, Check, CircleCheck, CircleX, Clock, Download, Hash,
  MapPin, MapPinOff, MapPinned, Minus, Pencil, Percent, QrCode, Search, ShieldCheck, Smartphone, Trash2, TrendingDown, TrendingUp, UserMinus,
  UserPlus, UserRound, X
} from 'lucide-react';
import { api, downloadFile, post } from '../../lib/api.js';
import { dateTime } from '../../lib/format.js';
import { applyFilters } from '../../lib/filters.js';
import { usePageTitle } from '../../brand.js';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { PersonLink } from '../../components/PersonLink.jsx';
import {
  ABSENT_FILTERS, MIN_SHARE, PHONE_FLAG_IDS, absentees, attendanceFilters, sortAbsent, sortMarks
} from './attendance-filters.js';
import { LIST_URL, apiPath, plural, timeOnly } from './attendance-paths.js';
import { SessionForm } from './SessionForm.jsx';
import { LiveQr } from './LiveQr.jsx';
import { AddStudentDialog } from './AddStudentDialog.jsx';

function BackLink({ go }) {
  return <a className="min-back" href={LIST_URL} onClick={(event) => { event.preventDefault(); go(LIST_URL); }}><ArrowLeft size={16} aria-hidden="true"/>Attendance</a>;
}

/** Each filter option's icon, coloured by what it means (filters.css). */
const FILTER_ICONS = {
  present: { icon: CircleCheck, tone: 'ok' },
  pending: { icon: Clock, tone: 'info' },
  rejected: { icon: CircleX, tone: 'bad' },
  ontime: { icon: AlarmClockCheck, tone: 'ok' },
  late: { icon: AlarmClock, tone: 'warn' },
  inside: { icon: MapPin, tone: 'ok' },
  uncertain: { icon: MapPinned, tone: 'warn' },
  unchecked: { icon: MapPinOff, tone: 'muted' },
  shared: { icon: Smartphone, tone: 'bad' },
  similar: { icon: Smartphone, tone: 'warn' },
  clear: { icon: ShieldCheck, tone: 'ok' },
  college: { icon: BadgeCheck, tone: 'info' },
  guest: { icon: UserRound, tone: 'muted' },
  self: { icon: QrCode, tone: 'info' },
  teacher: { icon: UserPlus, tone: 'muted' },
  'absent:college': { icon: BadgeCheck, tone: 'info' },
  'absent:guest': { icon: UserRound, tone: 'muted' },
  'record:regular': { icon: TrendingUp, tone: 'ok' },
  'record:short': { icon: TrendingDown, tone: 'bad' }
};

const MARK_SORTS = [
  { id: 'time', label: 'Time marked', icon: Clock, directions: [{ id: 'asc', label: 'Earliest first' }, { id: 'desc', label: 'Latest first' }] },
  { id: 'name', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'sap', label: 'SAP ID', icon: Hash, directions: [{ id: 'asc', label: 'Ascending' }, { id: 'desc', label: 'Descending' }] }
];
const DISTANCE_SORT = { id: 'distance', label: 'Distance', icon: MapPin, directions: [{ id: 'asc', label: 'Nearest first' }, { id: 'desc', label: 'Farthest first' }] };
const ABSENT_SORTS = [
  { id: 'sap', label: 'SAP ID', icon: Hash, directions: [{ id: 'asc', label: 'Ascending' }, { id: 'desc', label: 'Descending' }] },
  { id: 'name', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'share', label: 'Their attendance', icon: Percent, directions: [{ id: 'asc', label: 'Lowest first' }, { id: 'desc', label: 'Highest first' }] },
  { id: 'seen', label: 'Last here', icon: CalendarClock, directions: [{ id: 'desc', label: 'Most recent first' }, { id: 'asc', label: 'Longest ago first' }] }
];
const usualSort = (sorts) => `${sorts[0].id}-${sorts[0].directions[0].id}`;

const matchesSearch = (row, text) => !text || [row.name, row.sapId, row.email].some((value) => value && value.toLowerCase().includes(text));
const percent = (share) => `${Math.round(share * 100)}%`;
const shortDay = (value) => (value ? new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short' }) : '');
/** How an absentee is added back: a college student by their email, a guest by SAP ID and name. */
const addBody = (person) => (person.isGuest
  ? { as: 'guest', sapId: person.sapId, name: person.name }
  : { as: 'college', lookup: person.email, name: person.name });
const canAdd = (person) => Boolean(person.isGuest ? person.sapId : person.email);

/** "Shown on screen: Marked · Late, Guest · Search "ab" · Name: A–Z" - the line a filtered download carries. */
function describeView({ tab, groups, filters, search, sorts, sort }) {
  const parts = [tab === 'absent' ? 'Absent' : 'Marked'];
  const ticked = groups.flatMap((group) => group.options).filter((option) => filters.includes(option.id)).map((option) => option.label);
  if (ticked.length) parts.push(ticked.join(', '));
  if (search) parts.push(`Search "${search}"`);
  if (sort !== usualSort(sorts)) {
    const [fieldId, wayId] = sort.split('-');
    const field = sorts.find((entry) => entry.id === fieldId);
    const way = field?.directions.find((entry) => entry.id === wayId);
    if (field && way) parts.push(`${field.label}: ${way.label}`);
  }
  return `Shown on screen: ${parts.join(' · ')}`;
}

/** The row's tick box, over its number: shown on hover, on focus, while choosing, and always on a touch screen. */
function PickBox({ checked, mixed = false, onChange, label }) {
  return (
    <label className={`att-pick${checked || mixed ? ' is-on' : ''}`}>
      <input type="checkbox" checked={checked} aria-checked={mixed ? 'mixed' : checked} onChange={onChange} aria-label={label}/>
      <span className="att-pick-box" aria-hidden="true">{mixed ? <Minus size={12} strokeWidth={3.2}/> : checked && <Check size={12} strokeWidth={3.2}/>}</span>
    </label>
  );
}

function MarkRow({ mark, index, isNew, picked, onPick, showDistance, onAction }) {
  const removed = mark.status === 'rejected';
  return (
    <tr className={[removed && 'is-removed', isNew && 'is-new', picked && 'is-picked'].filter(Boolean).join(' ') || undefined}>
      <td className="att-num">
        <PickBox checked={picked} onChange={onPick} label={`Choose ${mark.name}`}/>
        <span className="att-index">{index + 1}</span>
      </td>
      <td className="att-who">
        <PersonLink className="att-name" email={mark.email} guest={mark.isGuest}>{mark.name}</PersonLink>
        <span className="att-sub">
          {mark.sapId || 'No SAP ID'}
          {mark.isGuest && ' · Guest'}
          {mark.late && ` · Late (round ${mark.round})`}
          {mark.addedByTeacher && ' · Added by you'}
        </span>
        {mark.sameDeviceAs.length > 0 && (
          <span className="att-flag"><AlertTriangle size={13} aria-hidden="true"/>Same phone as {mark.sameDeviceAs.join(', ')}</span>
        )}
        {mark.similarDeviceAs?.length > 0 && (
          <span className="att-flag is-soft" title="The same phone model, screen and settings. It may be one phone in a private tab - or two phones of one model.">
            <Smartphone size={13} aria-hidden="true"/>Possibly same phone as {mark.similarDeviceAs.join(', ')}
          </span>
        )}
      </td>
      <td className="att-time" title={dateTime(mark.markedAt)}>{timeOnly(mark.markedAt)}</td>
      {showDistance && (
        <td className="att-time att-distance">
          {!mark.location ? '—' : mark.location.status === 'inside'
            ? `${mark.location.distanceMeters} m`
            : <span className="att-flag is-soft" title={`GPS accurate to ±${mark.location.accuracyMeters} m`}>{mark.location.distanceMeters} m?</span>}
        </td>
      )}
      <td className="att-status-cell"><span className={`att-status is-${mark.status}`}>{removed ? 'Removed' : mark.status === 'present' ? 'Present' : 'Pending'}</span></td>
      <td className="att-row-action">
        <button className="link-button" type="button" onClick={() => onAction(mark, removed ? 'restore' : 'reject')}>{removed ? 'Restore' : 'Remove'}</button>
      </td>
    </tr>
  );
}

function AbsentRow({ person, index, sessionCount, picked, onPick, busy, onMarkPresent }) {
  const short = person.share < MIN_SHARE;
  return (
    <tr className={picked ? 'is-picked' : undefined}>
      <td className="att-num">
        <PickBox checked={picked} onChange={onPick} label={`Choose ${person.name}`}/>
        <span className="att-index">{index + 1}</span>
      </td>
      <td className="att-who">
        <PersonLink className="att-name" email={person.email} guest={person.isGuest}>{person.name}</PersonLink>
        <span className="att-sub">{person.sapId || 'No SAP ID'}{person.isGuest && ' · Guest'}</span>
      </td>
      <td className="att-share-cell" title={`Present in ${person.seen} of the class's other ${plural(sessionCount, 'session')}`}>
        <span className={short ? 'att-share is-short' : 'att-share'}>{percent(person.share)}</span>
        <span className="att-of">{person.seen}/{sessionCount}</span>
      </td>
      <td className="att-seen-cell" title={dateTime(person.lastSeenAt)}>{shortDay(person.lastSeenAt)}</td>
      <td className="att-row-action">
        <button className="link-button att-add-back" type="button" disabled={busy || !canAdd(person)} onClick={() => onMarkPresent([person])}
          title={canAdd(person) ? undefined : 'A guest without a SAP ID: add them with Add student.'}>
          Mark present
        </button>
      </td>
    </tr>
  );
}

export function AttendanceSessionScreen({ code, go, showToast }) {
  const [session, setSession] = useState(null);
  const [roster, setRoster] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState('marked');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState([]);
  const [absentFilters, setAbsentFilters] = useState([]);
  const [sort, setSort] = useState(usualSort(MARK_SORTS));
  const [absentSort, setAbsentSort] = useState(usualSort(ABSENT_SORTS));
  const [selected, setSelected] = useState(() => new Set());
  const closeAdding = useCallback(() => setAdding(false), []);

  // Marks this screen has already shown: one that arrives later slides in, so
  // the teacher sees who just scanned. Nothing animates on the first load.
  const seen = useRef(null);
  const [fresh, setFresh] = useState(() => new Set());
  const show = useCallback((next) => {
    const ids = next.marks.map((mark) => mark.id);
    setFresh(seen.current ? new Set(ids.filter((id) => !seen.current.has(id))) : new Set());
    seen.current = new Set(ids);
    setSession(next);
  }, []);
  const load = useCallback(() => api(apiPath(code)).then((data) => show(data.session)), [code, show]);
  usePageTitle(session?.title, 'Attendance');
  useEffect(() => { load().catch((error) => showToast(error.message)); }, [load, showToast]);
  // New marks appear while the QR is up - and with them the next QR codes.
  useEffect(() => {
    let timer;
    const tick = async () => {
      try { if (!document.hidden) await load().catch(() => {}); }
      finally {
        const base = session?.isOpen ? 3_000 : 15_000;
        timer = window.setTimeout(tick, base + Math.round(Math.random() * base * 0.5));
      }
    };
    timer = window.setTimeout(tick, 2_000 + Math.round(Math.random() * 2_000));
    // Back on the tab: at once, so the QR is never left on codes that ran out.
    const onVisible = () => { if (!document.hidden) load().catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load, session?.isOpen]);

  // The class roster - who to expect - fetched again only if the class is renamed.
  const title = session?.title;
  useEffect(() => {
    if (!title) return undefined;
    let live = true;
    api(apiPath(code, '/roster')).then((data) => { if (live) setRoster(data); }).catch(() => {});
    return () => { live = false; };
  }, [code, title]);

  // A choice belongs to the list it was made on.
  useEffect(() => { setSelected(new Set()); }, [tab]);

  const act = async (run) => {
    setBusy(true);
    try {
      const data = await run();
      if (data?.session) show(data.session);
      return data;
    } catch (error) {
      showToast(error.message);
      return null;
    } finally { setBusy(false); }
  };

  if (!session) return <Skeleton rows={6} label="Loading attendance"/>;

  /* What is on screen */
  const groups = attendanceFilters(session);
  const markSorts = session.locationRequired ? [...MARK_SORTS, DISTANCE_SORT] : MARK_SORTS;
  const searchText = search.trim().toLowerCase();
  const absent = absentees(roster, session.marks);
  const onAbsent = tab === 'absent';
  const view = onAbsent
    ? { groups: ABSENT_FILTERS, filters: absentFilters, setFilters: setAbsentFilters, sorts: ABSENT_SORTS, sort: absentSort, setSort: setAbsentSort, all: absent, rowId: (row) => row.key }
    : { groups, filters, setFilters, sorts: markSorts, sort, setSort, all: session.marks, rowId: (row) => row.id };
  const searched = view.all.filter((row) => matchesSearch(row, searchText));
  const filtered = applyFilters(searched, view.groups, view.filters);
  const rows = onAbsent ? sortAbsent(filtered, absentSort) : sortMarks(filtered, sort);
  const narrowed = onAbsent || Boolean(searchText) || view.filters.length > 0 || view.sort !== usualSort(view.sorts);
  const picked = rows.filter((row) => selected.has(view.rowId(row)));
  const allPicked = rows.length > 0 && picked.length === rows.length;
  const showTabs = absent.length > 0 || onAbsent;

  const pick = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const pickAll = () => setSelected(allPicked ? new Set() : new Set(rows.map(view.rowId)));
  const clearView = () => { setSearch(''); view.setFilters([]); };

  /* Doing things */
  const round = session.rounds.at(-1);
  const marked = session.presentCount + session.pendingCount;
  const close = () => {
    if (session.pendingCount && !window.confirm(`Close attendance and mark ${plural(session.pendingCount, 'student')} present?`)) return;
    act(() => post(apiPath(code, '/close')));
  };
  const reopen = () => act(() => post(apiPath(code, '/reopen')));
  const onAction = (mark, action) => {
    if (action === 'reject' && !window.confirm(`Remove ${mark.name}?`)) return;
    act(() => post(apiPath(code, `/marks/${encodeURIComponent(mark.id)}/${action}`)));
  };
  const setMany = async (action) => {
    const marks = picked.filter((mark) => (action === 'reject' ? mark.status !== 'rejected' : mark.status === 'rejected'));
    if (action === 'reject' && !window.confirm(`Remove ${marks.length === 1 ? marks[0].name : plural(marks.length, 'student')}?`)) return;
    const data = await act(() => post(apiPath(code, '/marks/status'), { ids: marks.map((mark) => mark.id), action }));
    if (data) {
      setSelected(new Set());
      showToast(`${plural(data.changed, 'student')} ${action === 'reject' ? 'removed' : 'put back'}.`, 'success');
    }
  };
  const markPresent = async (people) => {
    const data = await act(() => post(apiPath(code, '/marks'), { people: people.filter(canAdd).map(addBody) }));
    if (!data) return;
    setSelected(new Set());
    const skipped = (data.skipped || []).map((entry) => `${entry.name}: ${entry.reason}`).join(' ');
    const added = data.added ? `${plural(data.added, 'student')} marked present.` : '';
    showToast(skipped ? `${added}${added ? ' ' : ''}Not added - ${skipped}` : added, skipped ? 'error' : 'success');
  };
  const patch = (body) => act(() => api(apiPath(code), { method: 'PATCH', body: JSON.stringify(body) }));
  const saveDetails = async (body) => {
    const data = await api(apiPath(code), { method: 'PATCH', body: JSON.stringify(body) });
    show(data.session);
    setEditing(false);
    showToast('Changes saved.');
  };
  const exportAll = () => downloadFile(apiPath(code, '/export.xlsx'), `${code}-attendance.xlsx`).catch((error) => showToast(error.message));
  // What is on screen, in its order - or, with nothing narrowed, the whole session.
  const exportShown = () => {
    if (!narrowed) return exportAll();
    const note = describeView({ tab, groups: view.groups, filters: view.filters, search: search.trim(), sorts: view.sorts, sort: view.sort });
    const body = onAbsent ? { absent: rows.map((row) => row.key), note } : { ids: rows.map((row) => row.id), note };
    return downloadFile(apiPath(code, '/export.xlsx'), `${code}-attendance.xlsx`, body).catch((error) => showToast(error.message));
  };
  const remove = async () => {
    if (!window.confirm('Download the attendance sheet, then delete this session for good?')) return;
    try {
      await exportAll();
      await api(apiPath(code), { method: 'DELETE' });
      go(LIST_URL);
    } catch (error) { showToast(error.message); }
  };
  const showFlagged = () => { setTab('marked'); setSearch(''); setFilters(PHONE_FLAG_IDS); };

  const facts = [
    session.isOpen
      ? `${round.number > 1 ? `Round ${round.number} · ` : ''}Open since ${timeOnly(round.openedAt)}`
      : `Closed at ${timeOnly(round.closedAt)}`,
    new Date(session.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }),
    session.locationRequired ? `Within ${session.locationRadiusMeters} m` : null,
    session.oneMarkPerPhone ? 'One mark per phone' : null
  ].filter(Boolean);
  const downloadLabel = narrowed ? `Download the ${plural(rows.length, 'row')} shown as Excel` : 'Download everyone as Excel';
  const canRemove = picked.some((mark) => mark.status !== 'rejected');
  const canRestore = picked.some((mark) => mark.status === 'rejected');

  return (
    <section className={`min-page att-page att-session${editing ? ' is-editing' : ''}`}>
      <BackLink go={go}/>
      <header className="min-head">
        <div>
          <h1>{session.title}</h1>
          <p>{facts.join(' · ')}</p>
        </div>
        <ActionMenu label="More" items={[
          { label: 'Edit details', icon: Pencil, onSelect: () => setEditing(true) },
          { label: 'Download everything (Excel)', icon: Download, onSelect: exportAll },
          { label: session.allowGuests ? 'Stop allowing guests' : 'Allow guests', icon: session.allowGuests ? UserMinus : UserPlus, onSelect: () => patch({ allowGuests: !session.allowGuests }) },
          { label: session.oneMarkPerPhone ? 'Allow several marks per phone' : 'One mark per phone', icon: Smartphone, onSelect: () => patch({ oneMarkPerPhone: !session.oneMarkPerPhone }) },
          { label: 'Delete…', icon: Trash2, onSelect: remove, danger: true }
        ]}/>
      </header>

      {editing && <SessionForm session={session} onSave={saveDetails} onCancel={() => setEditing(false)} showToast={showToast}/>}
      {adding && <AddStudentDialog code={code} onAdded={show} onClose={closeAdding} showToast={showToast}/>}

      {/* The list on the left scrolls inside itself; the QR on the right stays in view. */}
      <div className="att-board">
        <div className={`card min-card att-table${picked.length ? ' is-selecting' : ''}`}>
          {/* Absentees are worked out from the class's other sessions: no tabs until there are some. */}
          {showTabs && (
            <div className="att-tabs" role="tablist" aria-label="Which list">
              {[['marked', 'Marked', session.marks.length], ['absent', 'Absent', absent.length]].map(([id, label, count]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : undefined} onClick={() => setTab(id)}>
                  {label}<span className="att-tab-count">{count}</span>
                </button>
              ))}
            </div>
          )}
          <div className="att-toolbar">
            {picked.length > 0 ? (
              <div className="att-selection" role="toolbar" aria-label="Chosen students">
                <strong>{picked.length} chosen</strong>
                {onAbsent ? (
                  <button className="button button-primary button-small" type="button" disabled={busy || !picked.some(canAdd)} onClick={() => markPresent(picked)}>
                    <Check size={15} aria-hidden="true"/>Mark present
                  </button>
                ) : <>
                  {canRemove && <button className="button button-reject button-small" type="button" disabled={busy} onClick={() => setMany('reject')}>Remove</button>}
                  {canRestore && <button className="button button-secondary button-small" type="button" disabled={busy} onClick={() => setMany('restore')}>Restore</button>}
                </>}
                <button className="button button-quiet button-small att-selection-clear" type="button" onClick={() => setSelected(new Set())}>
                  <X size={15} aria-hidden="true"/>Clear
                </button>
              </div>
            ) : <>
              <label className="search-field">
                <Search size={16} aria-hidden="true"/>
                <input className="text-input" type="search" aria-label="Search the list" placeholder="Search name, SAP ID or email"
                  value={search} onChange={(event) => setSearch(event.target.value)}/>
              </label>
              <FilterMenu key={tab} groups={view.groups} rows={searched} selected={view.filters} onChange={view.setFilters} icons={FILTER_ICONS}
                title={onAbsent ? 'Filter who is absent' : 'Filter the list'} allLabel={onAbsent ? 'All absent' : 'Everyone'}
                sorts={view.sorts} sort={view.sort} onSort={view.setSort}/>
              <button className="button button-secondary" type="button" aria-label={downloadLabel} title={downloadLabel} onClick={exportShown} disabled={narrowed && !rows.length}>
                <Download size={16} aria-hidden="true"/><span className="toolbar-text">Excel</span>
              </button>
              <button className="button button-primary" type="button" aria-label="Add student" title="Add student" onClick={() => setAdding(true)}>
                <UserPlus size={16} aria-hidden="true"/><span className="toolbar-text">Add student</span>
              </button>
            </>}
          </div>
          <div className="att-table-scroll">
            {rows.length === 0 ? (
              <div className="att-empty">
                {view.all.length === 0
                  ? <p>{onAbsent ? 'Everyone seen in this class before is here.' : 'Nobody yet. Names appear here as students scan.'}</p>
                  : <>
                    <p>No one matches this search or filter.</p>
                    <button className="link-button" type="button" onClick={clearView}>Clear search and filters</button>
                  </>}
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th className="att-num">
                      <PickBox checked={allPicked} mixed={picked.length > 0 && !allPicked} onChange={pickAll} label={allPicked ? 'Choose none' : 'Choose everyone shown'}/>
                      <span className="att-index">#</span>
                    </th>
                    <th>Student</th>
                    {onAbsent ? <><th>Attendance</th><th>Last here</th></> : <>
                      <th>Time</th>
                      {session.locationRequired && <th>Distance</th>}
                      <th>Status</th>
                    </>}
                    <th/>
                  </tr>
                </thead>
                <tbody>
                  {onAbsent
                    ? rows.map((person, index) => (
                      <AbsentRow key={person.key} person={person} index={index} sessionCount={roster.sessionCount} picked={selected.has(person.key)}
                        onPick={() => pick(person.key)} busy={busy} onMarkPresent={markPresent}/>
                    ))
                    : rows.map((mark, index) => (
                      <MarkRow key={mark.id} mark={mark} index={index} isNew={fresh.has(mark.id)} picked={selected.has(mark.id)} onPick={() => pick(mark.id)}
                        showDistance={session.locationRequired} onAction={onAction}/>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside className="att-board-side">
          {session.isOpen && session.qr ? <LiveQr session={session}/> : (
            <div className="att-qr att-qr-closed">
              <strong className="page-heading">
                Attendance closed
                <InfoTip label="Someone came late?">Take attendance again: a new QR opens, and everyone already present stays present.</InfoTip>
              </strong>
            </div>
          )}
          <div className="att-side">
            <div className="att-count">
              <strong>{marked}</strong>
              <span>marked</span>
            </div>
            <div className="att-breakdown">
              <span><i className="dot is-present"/>{session.presentCount} present</span>
              <span><i className="dot is-pending"/>{session.pendingCount} pending</span>
              {session.rejectedCount > 0 && <span><i className="dot is-rejected"/>{session.rejectedCount} removed</span>}
              {absent.length > 0 && (
                <button type="button" className="att-breakdown-link" onClick={() => setTab('absent')}>
                  <i className="dot is-absent"/>{absent.length} absent
                </button>
              )}
              {session.flaggedCount > 0 && (
                <button type="button" className="att-breakdown-link is-flag" onClick={showFlagged}>
                  <Smartphone size={13} aria-hidden="true"/>{plural(session.flaggedCount, 'phone flag')}
                </button>
              )}
            </div>
            {session.isOpen
              ? <button className="button button-primary button-wide" type="button" disabled={busy} onClick={close}>Close attendance</button>
              : <button className="button button-primary button-wide" type="button" disabled={busy} onClick={reopen}>Take attendance again</button>}
            <p className="att-hint">
              {session.isOpen ? 'Pending students become present when you close.' : `${plural(session.rounds.length, 'round')} taken.`}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
