import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, downloadFile, post } from '../../../lib/api.js';
import { durationLabel, shortDateTime } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { Ban, ChevronRight, CircleCheck, Download, Pencil, Trash2 } from 'lucide-react';
import { StudentAnalysisModal } from './StudentAnalysisModal.jsx';
import { InfoPill, StatusPill } from '../../../components/StatusPill.jsx';

const userPath = (email) => `/api/admin/users/${encodeURIComponent(email)}`;

function attemptLabel(result) {
  if (result.registrationStatus === 'rejected') return 'rejected';
  if (result.registrationStatus === 'pending') return 'pending';
  return result.attemptStatus || 'not_started';
}

// The date input is expressed in the administrator's local calendar day.
// Converting the stored ISO time the same way prevents an evening test from
// appearing under tomorrow's date just because the API stores UTC.
function localDateKey(value) {
  if (!value || Number.isNaN(new Date(value).getTime())) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

/**
 * Admins may correct anyone's name. It changes on every test, attendance mark
 * and export, and Microsoft sign-in no longer replaces it.
 */
function NameEditor({ user, onSaved, showToast }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user.name || '');
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      onSaved(await post(`${userPath(user.email)}/name`, { name }));
      showToast('Name updated everywhere it appears.', 'success');
      setEditing(false);
    } catch (error) { showToast(error.message, 'error'); }
    setBusy(false);
  };

  if (!editing) {
    return (
      <span className="user-name">
        <h1>{user.name}</h1>
        {user.hasAccount !== false && (
          <button className="link-button" type="button" aria-label="Edit name" title="Edit name" onClick={() => { setName(user.name || ''); setEditing(true); }}>
            <Pencil size={15} aria-hidden="true"/>Edit
          </button>
        )}
      </span>
    );
  }
  return (
    <form className="user-sap-form user-name-form" onSubmit={save}>
      <input className="text-input" required autoFocus minLength="2" maxLength="120" aria-label="Name" value={name} onChange={(event) => setName(event.target.value)}/>
      <button className="button button-primary button-small" disabled={busy || name.trim().length < 2}>{busy ? 'Saving…' : 'Save'}</button>
      <button className="button button-secondary button-small" type="button" onClick={() => setEditing(false)}>Cancel</button>
    </form>
  );
}

/** Admins may set or correct a student's SAP ID; the student cannot once it is saved. */
function SapIdEditor({ user, onSaved, showToast }) {
  const [editing, setEditing] = useState(false);
  const [sapId, setSapId] = useState(user.sapId || '');
  const [busy, setBusy] = useState(false);

  const save = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      onSaved(await post(`${userPath(user.email)}/sap-id`, { sapId }));
      showToast('SAP ID updated on the profile and every test registration.');
      setEditing(false);
    } catch (error) { showToast(error.message); }
    setBusy(false);
  };

  if (!editing) {
    return (
      <span className="user-sap">
        <strong>{user.sapId || 'Not set'}</strong>
        <button className="link-button" type="button" onClick={() => setEditing(true)}>{user.sapId ? 'Edit' : 'Set'}</button>
      </span>
    );
  }
  return (
    <form className="user-sap-form" onSubmit={save}>
      <input
        className="text-input" required autoFocus inputMode="numeric" pattern="[0-9]{9}" minLength="9" maxLength="9"
        value={sapId} onChange={(event) => setSapId(event.target.value.replace(/\D/g, '').slice(0, 9))}
      />
      <button className="button button-primary button-small" disabled={busy || sapId.length !== 9}>{busy ? 'Saving…' : 'Save'}</button>
      <button className="button button-secondary button-small" type="button" onClick={() => { setEditing(false); setSapId(user.sapId || ''); }}>Cancel</button>
    </form>
  );
}

/**
 * One person from the Users page: who they are, what can be done about them,
 * and every test they registered for. A test opens their paper on it.
 */
export function UserDetailModal({ account, currentEmail, isSelf, isBlocked, busy, onBlock, onUnblock, onDelete, onClose, onChanged, showToast }) {
  const email = account.email;
  const [data, setData] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [downloading, setDownloading] = useState('');
  const [paper, setPaper] = useState(null);
  const [testQuery, setTestQuery] = useState('');
  const [testDate, setTestDate] = useState('');
  const closePaper = useCallback(() => setPaper(null), []);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError('');
    try {
      setData(await api(userPath(email)));
      setLoadState('ready');
    } catch (error) {
      // Do not leave a skeleton on screen forever or close the person card:
      // a manager needs the error and a direct way to try the request again.
      setLoadError(error.message);
      setLoadState('error');
    }
  }, [email]);

  useEffect(() => { void load(); }, [load, isBlocked]);

  const download = async (event, result) => {
    event.stopPropagation();
    const downloadKey = `${result.code}-${result.registrationId}`;
    setDownloading(downloadKey);
    try {
      await downloadFile(
        `${userPath(email)}/tests/${encodeURIComponent(result.code)}/registrations/${encodeURIComponent(result.registrationId)}/responses.xlsx`,
        `${result.code}-${result.sapId || 'student'}-audit.xlsx`
      );
    } catch (error) { showToast(error.message); }
    setDownloading('');
  };

  // Name, email and role come from the list, so the pop-up opens with them at once.
  const user = data?.user || { ...account, blocked: isBlocked, hasAccount: true };
  const results = data?.results || [];
  const blocked = data ? user.blocked : isBlocked;
  const submittedCount = results.filter((result) => result.attemptStatus === 'submitted').length;
  const visibleResults = useMemo(() => {
    const query = testQuery.trim().toLowerCase();
    return results.filter((result) => {
      const matchesQuery = !query || `${result.title} ${result.code} ${attemptLabel(result)}`.toLowerCase().includes(query);
      return matchesQuery && (!testDate || localDateKey(result.testDate) === testDate);
    });
  }, [results, testDate, testQuery]);
  const hasTestFilters = Boolean(testQuery || testDate);

  return (
    <Modal label={`Details for ${user.name}`} onClose={onClose}>
      <header className="user-head">
        <div className="user-who">
          {data ? <NameEditor user={user} showToast={showToast} onSaved={(next) => { setData(next); onChanged(); }}/> : <h1>{user.name}</h1>}
          <p>
            {user.role === 'faculty' ? 'Faculty' : 'Student'} · {user.email}
            {blocked && <InfoPill tone="danger">Blocked</InfoPill>}
            {user.hasAccount === false && <InfoPill>Account deleted</InfoPill>}
          </p>
        </div>
        <div className="user-actions">
          {blocked
            ? <button className="button button-success button-small swap-button" type="button" disabled={busy} onClick={onUnblock}><CircleCheck size={15} aria-hidden="true"/>Unblock</button>
            : <button className="button button-warning button-small swap-button" type="button" disabled={busy || isSelf} onClick={onBlock} title={isSelf ? 'You cannot block yourself' : undefined}><Ban size={15} aria-hidden="true"/>Block</button>}
          {user.hasAccount !== false && (
            <button className="button button-danger button-small" type="button" disabled={busy || isSelf} onClick={onDelete} title={isSelf ? 'You cannot delete yourself' : undefined}><Trash2 size={15} aria-hidden="true"/>Delete</button>
          )}
        </div>
      </header>

      <div className="user-facts">
        {user.role === 'student' && (
          <span className="user-fact">SAP ID {data ? <SapIdEditor user={user} showToast={showToast} onSaved={(next) => { setData(next); onChanged(); }}/> : <strong>{account.sapId || '—'}</strong>}</span>
        )}
        <span className="user-fact"><strong>{data ? submittedCount : '—'}</strong> submitted</span>
        <span className="user-fact">Last login <strong>{shortDateTime(user.lastSignInAt)}</strong></span>
      </div>

      {!data && loadState === 'loading' ? (
        <div className="user-loading" role="status" aria-label="Loading their tests">
          <span className="user-loading-row"/><span className="user-loading-row"/>
        </div>
      ) : !data ? (
        <div className="user-load-error" role="alert">
          <p>Could not load this person’s test records. {loadError}</p>
          <button className="button button-secondary button-small" type="button" onClick={() => { void load(); }}>Try again</button>
        </div>
      ) : results.length === 0 ? (
        <p className="user-empty">No tests yet.</p>
      ) : (
        <>
          <div className="user-tests-toolbar">
            <input
              className="text-input" type="search" value={testQuery}
              placeholder="Search test or code" aria-label="Search this person's tests"
              onChange={(event) => setTestQuery(event.target.value)}
            />
            <label className="user-test-date">
              <span>Test date</span>
              <input className="text-input" type="date" value={testDate} onChange={(event) => setTestDate(event.target.value)}/>
            </label>
            {hasTestFilters && <button className="link-button" type="button" onClick={() => { setTestQuery(''); setTestDate(''); }}>Clear</button>}
          </div>
          {loadState === 'error' && <p className="user-refresh-error" role="alert">Could not refresh the latest records. {loadError}</p>}
          <p className="user-tests-count">{hasTestFilters ? `${visibleResults.length} of ${results.length} tests` : `${results.length} test${results.length === 1 ? '' : 's'}`}</p>
          {visibleResults.length === 0 ? <p className="user-empty">No tests match this search.</p> : (
          <ul className="user-tests">
          {visibleResults.map((result) => (
            <li key={`${result.code}-${result.registrationId}`}>
              <button type="button" className="user-test" onClick={() => setPaper(result)} title="Open their paper">
                <span className="user-test-name">
                  <strong>{result.title}</strong>
                  <small>{result.code}{result.testDate ? ` · Test ${shortDateTime(result.testDate)}` : ''}{result.submittedAt ? ` · Submitted ${shortDateTime(result.submittedAt)}` : ''}{result.timeTakenSeconds ? ` · ${durationLabel(result.timeTakenSeconds)}` : ''}</small>
                </span>
                <StatusPill status={attemptLabel(result)}/>
                <span className="user-test-score">
                  {result.score === null ? '—' : `${result.score}/${result.totalQuestions}`}
                  {result.pendingManual > 0 && <small>{result.pendingManual} to mark</small>}
                </span>
                <ChevronRight size={16} className="user-test-go" aria-hidden="true"/>
              </button>
              {result.attemptStatus === 'submitted' && (
                <button className="button icon-button user-test-download" type="button" disabled={downloading === `${result.code}-${result.registrationId}`}
                  onClick={(event) => download(event, result)} title="Download full response and audit data (Excel)" aria-label={`Download ${result.title} response and audit data`}>
                  <Download size={15} aria-hidden="true"/>
                </button>
              )}
            </li>
          ))}
          </ul>
          )}
        </>
      )}

      {paper && (
        <StudentAnalysisModal
          code={paper.code}
          registration={{ id: paper.registrationId, name: user.name }}
          // Your own test: the full view, short answers can be marked. Someone else's: read-only.
          readOnly={paper.ownerEmail !== currentEmail}
          analysisPath={paper.ownerEmail !== currentEmail ? `${userPath(email)}/tests/${encodeURIComponent(paper.code)}/registrations/${encodeURIComponent(paper.registrationId)}/analysis` : null}
          onClose={closePaper}
          onSaved={() => load().catch(() => {})}
          showToast={showToast}
        />
      )}
    </Modal>
  );
}
