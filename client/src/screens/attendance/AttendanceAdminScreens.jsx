import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile, post } from '../../lib/api.js';
import { dateTime, shortDateTime } from '../../lib/format.js';
import {
  AlertTriangle, ArrowLeft, BadgeCheck, Check, CircleCheck, CircleX, Clock, Download, Pencil, QrCode, Search, Trash2, UserMinus, UserPlus, UserRound
} from 'lucide-react';
import { Modal } from '../../components/Modal.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { applyFilters } from '../../lib/filters.js';
import { ATTENDANCE_FILTERS } from './attendance-filters.js';
import { Skeleton } from '../../components/Skeleton.jsx';
import { usePageTitle } from '../../brand.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { SwitchRow } from '../../components/FormControls.jsx';
import { VenueFields } from '../../components/VenueFields.jsx';

const LIST_URL = '/?admin=attendance';
const sessionUrl = (code) => `${LIST_URL}&session=${encodeURIComponent(code)}`;
const apiPath = (code, rest = '') => `/api/admin/attendance/${encodeURIComponent(code)}${rest}`;
const timeOnly = (value) => (value ? new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '');

const venueBody = (values) => ({
  locationRequired: values.locationRequired,
  locationRadiusMeters: Number(values.locationRadiusMeters),
  locationLatitude: values.locationLatitude === '' ? null : Number(values.locationLatitude),
  locationLongitude: values.locationLongitude === '' ? null : Number(values.locationLongitude)
});

function BackLink({ go }) {
  return <a className="min-back" href={LIST_URL} onClick={(event) => { event.preventDefault(); go(LIST_URL); }}><ArrowLeft size={16} aria-hidden="true"/>Attendance</a>;
}

/* ------------------------------------------------------------ the list */

const formValues = (session) => ({
  title: session?.title || '',
  allowGuests: Boolean(session?.allowGuests),
  locationRequired: Boolean(session?.locationRequired),
  locationRadiusMeters: session?.locationRadiusMeters ?? 100,
  locationLatitude: session?.locationLatitude ?? '',
  locationLongitude: session?.locationLongitude ?? ''
});

/** A new session, or - given `session` - changing one already made. */
function SessionForm({ session = null, onSave, onCancel, showToast }) {
  const [values, setValues] = useState(() => formValues(session));
  const [busy, setBusy] = useState(false);
  const set = (name, value) => setValues((current) => ({ ...current, [name]: value }));
  const idPrefix = session ? 'att-edit' : 'att';

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      await onSave({ title: values.title, allowGuests: values.allowGuests, ...venueBody(values) });
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  return (
    <form className="card min-card att-create" onSubmit={save}>
      <label className="field-label" htmlFor={`${idPrefix}-title`}>Class name</label>
      <input id={`${idPrefix}-title`} className="text-input" required minLength="2" maxLength="120" autoFocus value={values.title}
        onChange={(event) => set('title', event.target.value)} placeholder="e.g. DBMS · CSE-B · Lecture 12"/>
      <div className="att-create-options">
        <SwitchRow checked={values.allowGuests} onChange={(value) => set('allowGuests', value)}
          title="Allow guests" description="Mark with a name and SAP ID, without a college account."/>
        <SwitchRow checked={values.locationRequired} onChange={(value) => set('locationRequired', value)}
          title="Check distance" description="Only students near the classroom can mark."/>
      </div>
      {values.locationRequired && <VenueFields values={values} onChange={set} idPrefix={idPrefix} showToast={showToast}/>}
      <div className="min-actions">
        {onCancel && <button className="button button-quiet" type="button" onClick={onCancel}>Cancel</button>}
        <button className="button button-primary" type="submit" disabled={busy}>
          {session ? (busy ? 'Saving…' : 'Save changes') : (busy ? 'Opening…' : 'Start & show QR')}
        </button>
      </div>
    </form>
  );
}

export function AttendanceListScreen({ go, showToast }) {
  const [sessions, setSessions] = useState(null);
  // ?new=1 (the home page's "Take attendance") opens straight on the form.
  const [creating, setCreating] = useState(() => new URLSearchParams(window.location.search).get('new') === '1');
  useEffect(() => {
    api('/api/admin/attendance').then((data) => setSessions(data.sessions)).catch((error) => showToast(error.message));
  }, [showToast]);

  if (!sessions) return <Skeleton rows={3} label="Loading attendance"/>;
  const showForm = creating || sessions.length === 0;

  return (
    <section className="min-page att-page">
      <header className="min-head">
        <div>
          <h1>Attendance</h1>
          <p>Show a QR in class. Students scan it to mark themselves.</p>
        </div>
        {!showForm && <button className="button button-primary" type="button" onClick={() => setCreating(true)}>New attendance</button>}
      </header>

      {showForm && (
        <SessionForm showToast={showToast} onCancel={sessions.length ? () => setCreating(false) : null} onSave={async (body) => {
          const data = await post('/api/admin/attendance', body);
          go(sessionUrl(data.session.code));
        }}/>
      )}

      {sessions.length > 0 && (
        <ul className="min-list">
          {sessions.map((session) => (
            <li key={session.code}>
              <a href={sessionUrl(session.code)} onClick={(event) => { event.preventDefault(); go(sessionUrl(session.code)); }}>
                <span className="min-list-main">
                  <strong>{session.title}</strong>
                  <small>{shortDateTime(session.createdAt)}{session.round > 1 ? ` · ${session.round} rounds` : ''}</small>
                </span>
                <span className="min-list-side">
                  <span>{session.presentCount} present{session.pendingCount ? ` · ${session.pendingCount} pending` : ''}</span>
                  <span className={`min-state${session.isOpen ? ' is-open' : ''}`}>{session.isOpen ? 'Open' : 'Closed'}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------- one session */

/**
 * The QR changes every few seconds (the server says how often). Its image is
 * fetched again at each change, timed on the server's clock so every screen
 * swaps at the same moment.
 */
function LiveQr({ session }) {
  const [, setClock] = useState(0);
  const [big, setBig] = useState(false);
  const offset = useRef(0);
  useEffect(() => { offset.current = Date.parse(session.serverTime) - Date.now(); }, [session.serverTime]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 500);
    return () => window.clearInterval(timer);
  }, []);
  // Full screen closes with a click anywhere, or Escape.
  useEffect(() => {
    if (!big) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setBig(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [big]);

  const stepMs = session.qrStepMs || 10_000;
  const step = Math.floor((Date.now() + offset.current) / stepMs);
  const src = `${apiPath(session.code, '/qr.svg')}?s=${step}`;
  return (
    <div className="att-qr">
      <button className="att-qr-button" type="button" onClick={() => setBig(true)} aria-label="Show the QR full screen">
        <img src={src} alt="Attendance QR code"/>
      </button>
      {/* What the class sees on the projector: the class, the day, the QR - nothing else. */}
      {big && (
        <div className="att-qr-full" role="dialog" aria-label="Attendance QR" onClick={() => setBig(false)}>
          <h1>{session.title}</h1>
          <p>{new Date(session.createdAt).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <img src={src} alt="Attendance QR code"/>
        </div>
      )}
    </div>
  );
}

function MarkRow({ mark, index, isNew, showDistance, onAction }) {
  const removed = mark.status === 'rejected';
  return (
    <tr className={[removed && 'is-removed', isNew && 'is-new'].filter(Boolean).join(' ') || undefined}>
      <td className="att-num">{index + 1}</td>
      <td className="att-who">
        <span className="att-name">{mark.name}</span>
        <span className="att-sub">
          {mark.sapId || 'No SAP ID'}
          {mark.isGuest && ' · Guest'}
          {mark.late && ` · Late (round ${mark.round})`}
          {mark.addedByTeacher && ' · Added by you'}
        </span>
        {mark.sameDeviceAs.length > 0 && <span className="att-flag"><AlertTriangle size={13} aria-hidden="true"/>Same phone as {mark.sameDeviceAs.join(', ')}</span>}
      </td>
      <td className="att-time" title={dateTime(mark.markedAt)}>{timeOnly(mark.markedAt)}</td>
      {showDistance && (
        <td className="att-time att-distance">
          {!mark.location ? '—' : mark.location.status === 'inside'
            ? `${mark.location.distanceMeters} m`
            : <span className="att-flag" title={`GPS accurate to ±${mark.location.accuracyMeters} m`}>{mark.location.distanceMeters} m?</span>}
        </td>
      )}
      <td className="att-status-cell"><span className={`att-status is-${mark.status}`}>{removed ? 'Removed' : mark.status === 'present' ? 'Present' : 'Pending'}</span></td>
      <td className="att-row-action">
        <button className="link-button" type="button" onClick={() => onAction(mark, removed ? 'restore' : 'reject')}>{removed ? 'Restore' : 'Remove'}</button>
      </td>
    </tr>
  );
}

/** Each filter option's icon, coloured by what it means (filters.css). */
const FILTER_ICONS = {
  present: { icon: CircleCheck, tone: 'ok' },
  pending: { icon: Clock, tone: 'info' },
  rejected: { icon: CircleX, tone: 'bad' },
  college: { icon: BadgeCheck, tone: 'info' },
  guest: { icon: UserRound, tone: 'muted' },
  self: { icon: QrCode, tone: 'info' },
  teacher: { icon: UserPlus, tone: 'muted' }
};
const matchesSearch = (mark, text) => !text || [mark.name, mark.sapId, mark.email].some((value) => value && value.toLowerCase().includes(text));
const sapDigits = (value) => value.replace(/\D/g, '').slice(0, 9);

/** Over the list: search it, filter it, or add someone by hand. */
function ListToolbar({ search, onSearch, filters, onFilters, pool, onAdd }) {
  return (
    <div className="att-toolbar">
      <label className="search-field">
        <Search size={16} aria-hidden="true"/>
        <input className="text-input" type="search" aria-label="Search the list" placeholder="Search name, SAP ID or email"
          value={search} onChange={(event) => onSearch(event.target.value)}/>
      </label>
      <FilterMenu groups={ATTENDANCE_FILTERS} rows={pool} selected={filters} onChange={onFilters} icons={FILTER_ICONS} title="Filter the list" allLabel="Everyone"/>
      <button className="button button-primary" type="button" aria-label="Add student" title="Add student" onClick={onAdd}>
        <UserPlus size={16} aria-hidden="true"/><span className="toolbar-text">Add student</span>
      </button>
    </div>
  );
}

const ADD_KINDS = [['registered', 'Registered user'], ['guest', 'Guest']];

/**
 * Adding someone whose phone would not scan, or who has none. A registered
 * user is found by name, SAP ID or email and brings their own details; a
 * guest is added with a name and SAP ID. It stays open for the next one.
 */
function AddStudentDialog({ code, onAdded, onClose, showToast }) {
  const [kind, setKind] = useState('registered');
  const [query, setQuery] = useState('');
  // null: nothing typed yet. Otherwise the search as it stands - still
  // running, failed (said so right under the box), or its results.
  const [found, setFound] = useState(null);
  const people = found?.people || null;
  const [sapId, setSapId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(null);
  const searchInput = useRef(null);
  const sapInput = useRef(null);

  // Searched a moment after the teacher stops typing.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) { setFound(null); return undefined; }
    setFound({ searching: true });
    let current = true;
    const timer = window.setTimeout(() => {
      api(apiPath(code, `/people?q=${encodeURIComponent(text)}`))
        .then((data) => { if (current) setFound({ people: data.people }); })
        .catch((error) => { if (current) setFound({ error: error.message }); });
    }, 250);
    return () => { current = false; window.clearTimeout(timer); };
  }, [code, query]);

  const add = async (body, key) => {
    setBusy(key);
    try {
      const data = await post(apiPath(code, '/marks'), body);
      onAdded(data.session);
      showToast(`${data.added.name} marked present${data.added.isGuest ? ' as a guest' : ''}.`, 'success');
      return true;
    } catch (error) {
      showToast(error.message, 'error');
      return false;
    } finally { setBusy(null); }
  };
  // After each one the box is cleared and ready for the next - the toast
  // (drawn above this dialog) says who went in. A failed add keeps what was typed.
  const addPerson = async (person) => {
    if (!(await add({ as: 'college', lookup: person.email }, person.email))) return;
    setQuery('');
    searchInput.current?.focus();
  };
  const addGuest = async (event) => {
    event.preventDefault();
    if (!(await add({ as: 'guest', sapId, name }, 'guest'))) return;
    setSapId('');
    setName('');
    sapInput.current?.focus();
  };

  return (
    <Modal label="Add a student" onClose={onClose} className="att-add-dialog">
      <h1>Add a student</h1>
      <p className="att-add-intro">They are marked present straight away.</p>
      <div className="segmented" role="group" aria-label="Add a">
        {ADD_KINDS.map(([id, label]) => (
          <button key={id} type="button" className={kind === id ? 'is-on' : ''} aria-pressed={kind === id} onClick={() => setKind(id)}>{label}</button>
        ))}
      </div>

      {/* One fixed height for both, so switching between them does not resize the dialog. */}
      <div className="att-add-body">
      {kind === 'registered' ? (
        <div className="att-add-registered">
          <label className="search-field">
            <Search size={16} aria-hidden="true"/>
            <input ref={searchInput} className="text-input" type="search" aria-label="Search registered users" autoFocus
              placeholder="Search by name, SAP ID or email" value={query} onChange={(event) => setQuery(event.target.value)}/>
          </label>
          {found === null ? <p className="help">Type at least two letters or digits.</p>
            : found.searching ? <p className="help">Searching…</p>
              : found.error ? <p className="help att-search-error">Search failed: {found.error}</p>
                : people.length === 0 ? <p className="help">No registered user matches. Add them as a guest instead.</p>
              : (
                <ul className="att-people">
                  {people.map((person) => (
                    <li key={person.email}>
                      <span className="att-person">
                        <strong>{person.name}</strong>
                        <small>{[person.sapId, person.email].filter(Boolean).join(' · ')}</small>
                      </span>
                      {person.marked
                        ? <span className="att-person-done"><Check size={15} aria-hidden="true"/>Marked</span>
                        : (
                          <button className="button button-secondary button-small" type="button" disabled={busy !== null} onClick={() => addPerson(person)}>
                            {busy === person.email ? 'Adding…' : 'Add'}
                          </button>
                        )}
                    </li>
                  ))}
                </ul>
              )}
        </div>
      ) : (
        <form className="att-add-guest" onSubmit={addGuest}>
          <label className="field-label" htmlFor="att-guest-sap">SAP ID</label>
          <input ref={sapInput} id="att-guest-sap" className="text-input" required autoFocus inputMode="numeric" pattern="[0-9]{9}" maxLength="9"
            placeholder="e.g. 500123456" value={sapId} onChange={(event) => setSapId(sapDigits(event.target.value))}/>
          <label className="field-label" htmlFor="att-guest-name">Name</label>
          <input id="att-guest-name" className="text-input" required minLength="2" maxLength="120"
            placeholder="e.g. Asha Verma" value={name} onChange={(event) => setName(event.target.value)}/>
          <button className="button button-primary button-wide" type="submit" disabled={busy !== null || sapId.length !== 9 || name.trim().length < 2}>
            {busy ? 'Adding…' : 'Add guest'}
          </button>
        </form>
      )}
      </div>

      <div className="min-actions">
        <button className="button button-quiet" type="button" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}

export function AttendanceSessionScreen({ code, go, showToast }) {
  const [session, setSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [filters, setFilters] = useState([]);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
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
  // New marks appear while the QR is up.
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
    return () => window.clearTimeout(timer);
  }, [load, session?.isOpen]);

  const act = async (run) => {
    setBusy(true);
    try { const data = await run(); if (data?.session) setSession(data.session); } catch (error) { showToast(error.message); }
    finally { setBusy(false); }
  };

  if (!session) return <Skeleton rows={6} label="Loading attendance"/>;

  const round = session.rounds.at(-1);
  const marked = session.presentCount + session.pendingCount;
  const searchText = search.trim().toLowerCase();
  const searched = session.marks.filter((mark) => matchesSearch(mark, searchText));
  const shown = applyFilters(searched, ATTENDANCE_FILTERS, filters);
  const close = () => {
    if (session.pendingCount && !window.confirm(`Close attendance and mark ${session.pendingCount} student${session.pendingCount === 1 ? '' : 's'} present?`)) return;
    act(() => post(apiPath(code, '/close')));
  };
  const reopen = () => act(() => post(apiPath(code, '/reopen')));
  const onAction = (mark, action) => {
    if (action === 'reject' && !window.confirm(`Remove ${mark.name}?`)) return;
    act(() => post(apiPath(code, `/marks/${encodeURIComponent(mark.id)}/${action}`)));
  };
  const setGuests = (value) => act(() => api(apiPath(code), { method: 'PATCH', body: JSON.stringify({ allowGuests: value }) }));
  const saveDetails = async (body) => {
    const data = await api(apiPath(code), { method: 'PATCH', body: JSON.stringify(body) });
    setSession(data.session);
    setEditing(false);
    showToast('Changes saved.');
  };
  const exportSheet = () => downloadFile(apiPath(code, '/export.xlsx'), `${code}-attendance.xlsx`).catch((error) => showToast(error.message));
  const remove = async () => {
    if (!window.confirm('Download the attendance sheet, then delete this session for good?')) return;
    try {
      await downloadFile(apiPath(code, '/export.xlsx'), `${code}-attendance.xlsx`);
      await api(apiPath(code), { method: 'DELETE' });
      go(LIST_URL);
    } catch (error) { showToast(error.message); }
  };

  const facts = [
    session.isOpen
      ? `${round.number > 1 ? `Round ${round.number} · ` : ''}Open since ${timeOnly(round.openedAt)}`
      : `Closed at ${timeOnly(round.closedAt)}`,
    new Date(session.createdAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }),
    session.locationRequired ? `Within ${session.locationRadiusMeters} m` : null
  ].filter(Boolean);

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
          { label: 'Download Excel', icon: Download, onSelect: exportSheet },
          { label: session.allowGuests ? 'Stop allowing guests' : 'Allow guests', icon: session.allowGuests ? UserMinus : UserPlus, onSelect: () => setGuests(!session.allowGuests) },
          { label: 'Delete…', icon: Trash2, onSelect: remove, danger: true }
        ]}/>
      </header>

      {editing && <SessionForm session={session} onSave={saveDetails} onCancel={() => setEditing(false)} showToast={showToast}/>}
      {adding && <AddStudentDialog code={code} onAdded={show} onClose={closeAdding} showToast={showToast}/>}

      {/* The list on the left scrolls inside itself; the QR on the right stays in view. */}
      <div className="att-board">
        <div className="card min-card att-table">
          <ListToolbar search={search} onSearch={setSearch} filters={filters} onFilters={setFilters} pool={searched} onAdd={() => setAdding(true)}/>
          <div className="att-table-scroll">
            {shown.length === 0 ? (
              <p className="att-empty">{session.marks.length ? 'No one matches this search or filter.' : 'Nobody yet. Names appear here as students scan.'}</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th className="att-num">#</th><th>Student</th><th>Time</th>
                    {session.locationRequired && <th>Distance</th>}
                    <th>Status</th><th/>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((mark, index) => (
                    <MarkRow key={mark.id} mark={mark} index={index} isNew={fresh.has(mark.id)} showDistance={session.locationRequired} onAction={onAction}/>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <aside className="att-board-side">
          {session.isOpen ? <LiveQr session={session}/> : (
            <div className="att-qr att-qr-closed">
              <strong>Attendance closed</strong>
              <p>Someone came late? Take it again: a new QR opens and everyone already present stays present.</p>
            </div>
          )}
          <div className="att-side">
            <div className="att-count">
              <strong>{marked}</strong>
              <span>marked</span>
            </div>
            <p className="att-breakdown">
              <span><i className="dot is-present"/>{session.presentCount} present</span>
              <span><i className="dot is-pending"/>{session.pendingCount} pending</span>
              {session.rejectedCount > 0 && <span><i className="dot is-rejected"/>{session.rejectedCount} removed</span>}
            </p>
            {session.isOpen
              ? <button className="button button-primary button-wide" type="button" disabled={busy} onClick={close}>Close attendance</button>
              : <button className="button button-primary button-wide" type="button" disabled={busy} onClick={reopen}>Take attendance again</button>}
            <p className="att-hint">
              {session.isOpen ? 'Pending students become present when you close.' : `${session.rounds.length} round${session.rounds.length === 1 ? '' : 's'} taken.`}
            </p>
          </div>
        </aside>
      </div>
    </section>
  );
}
