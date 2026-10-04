import { useEffect, useState } from 'react';
import { api, post } from '../../../lib/api.js';
import { Modal } from '../../../components/Modal.jsx';

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/**
 * Release marks while papers still have short answers to mark: who is waiting
 * first, then the choice - mark them first, or release anyway, the unmarked
 * answers showing as not marked yet (and counting nothing) until they are
 * marked. Each mark given later shows straight away.
 */
export function ReleaseMarksModal({ code, waiting, onClose, onSaved, onMarkFirst, onReleaseMarked = null, showToast }) {
  // undefined while loading; the first 100 papers waiting, by name.
  const [list, setList] = useState(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const params = new URLSearchParams({ section: 'responses', page: '1', pageSize: '100', filters: 'marking:awaiting', sort: 'name-asc' });
    api(`/api/admin/tests/${encodeURIComponent(code)}?${params}`)
      .then((data) => { if (alive) setList({ rows: data.registrations || [], total: data.pagination?.total ?? (data.registrations || []).length }); })
      .catch(() => { if (alive) setList(null); });
    return () => { alive = false; };
  }, [code]);

  const release = async () => {
    setBusy(true);
    try {
      onSaved(await post(`/api/admin/tests/${encodeURIComponent(code)}/results/unmarked`, { show: true }));
      showToast('Marks released. Answers you have not marked show as not marked yet.', 'success');
      onClose();
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  const count = list?.total ?? waiting;
  return (
    <Modal label="Release marks" onClose={onClose} className="release-dialog">
      <h1>Release marks?</h1>
      <p className="reopen-note"><strong>{plural(count, 'paper')}</strong> still {count === 1 ? 'has' : 'have'} short answers to mark:</p>

      {list === undefined ? <p className="help">Loading who is waiting…</p> : list && list.rows.length > 0 && (
        <ul className="release-waiting" aria-label="Papers waiting to be marked">
          {list.rows.map((row) => (
            <li key={row.id}>
              <span className="release-waiting-who">
                <strong>{String(row.name || '').replace(/^Guest:\s*/, '')}</strong>
                {row.sapId && <span>{row.sapId}</span>}
              </span>
              <span className="release-waiting-count">{row.manualTotal - row.manualGraded} to mark</span>
            </li>
          ))}
          {list.total > list.rows.length && <li className="release-waiting-more">and {list.total - list.rows.length} more</li>}
        </ul>
      )}

      <p className="help">
        Release anyway and students see their marks now. Their unmarked answers show as <em>not marked yet</em> and
        count nothing until you mark them; each mark you give then shows straight away.
      </p>

      <div className="modal-actions">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => { onClose(); onMarkFirst(); }}>Mark them first</button>
        {/* Marks held for the teacher's release: the fully marked papers can go out now, the rest still waiting. */}
        {onReleaseMarked && (
          <button className="button button-secondary" type="button" disabled={busy} title="Fully marked papers show their marks now; the others show Being marked until you mark them"
            onClick={() => { onReleaseMarked(); onClose(); }}>Release marked only</button>
        )}
        <button className="button button-primary" type="button" disabled={busy} onClick={release}>{busy ? 'Releasing…' : 'Release anyway'}</button>
      </div>
    </Modal>
  );
}
