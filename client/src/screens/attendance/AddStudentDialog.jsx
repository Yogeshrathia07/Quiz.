import { useEffect, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { api, post } from '../../lib/api.js';
import { Modal } from '../../components/Modal.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { apiPath } from './attendance-paths.js';

const sapDigits = (value) => value.replace(/\D/g, '').slice(0, 9);
const ADD_KINDS = [['registered', 'Registered user'], ['guest', 'Guest']];

/**
 * Adding someone whose phone would not scan, or who has none. A registered
 * user is found by name, SAP ID or email and brings their own details; a
 * guest is added with a name and SAP ID. It stays open for the next one.
 */
export function AddStudentDialog({ code, onAdded, onClose, showToast }) {
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
      <div className="page-heading">
        <h1>Add a student</h1>
        <InfoTip label="About adding a student">For someone whose phone would not scan, or who has none. They are marked present straight away.</InfoTip>
      </div>
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

