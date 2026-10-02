import { useMemo, useState } from 'react';
import { Download } from 'lucide-react';
import { downloadFile } from '../../lib/api.js';
import { Modal } from '../../components/Modal.jsx';
import { plural } from './attendance-paths.js';

const dayOf = (value) => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const niceDay = (value) => new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

// The minimum is the teacher's own habit: remembered in this browser.
const MIN_KEY = 'attendance-register-min';
const savedMin = () => {
  try { return Number(window.localStorage.getItem(MIN_KEY)) || 75; } catch { return 75; }
};

/**
 * Many sessions as one Excel register (src/export/attendance-sheet.js): one
 * row per student, one column per session, their totals, and who is under
 * the minimum. Choose the classes - sessions with the same title - and, if
 * you like, the dates. Opened from a filtered list, it starts from the
 * sessions shown (`filtered`).
 */
export function AttendanceExportModal({ sessions, filtered = false, onClose, showToast }) {
  const classes = useMemo(() => {
    const byTitle = new Map();
    for (const session of sessions) byTitle.set(session.title, (byTitle.get(session.title) || 0) + 1);
    return [...byTitle].map(([title, count]) => ({ title, count }));
  }, [sessions]);
  const [chosen, setChosen] = useState(() => new Set(classes.map((entry) => entry.title)));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [min, setMin] = useState(savedMin);
  const [busy, setBusy] = useState(false);

  const picked = sessions.filter((session) => chosen.has(session.title)
    && (!from || dayOf(session.createdAt) >= from) && (!to || dayOf(session.createdAt) <= to));
  const dates = picked.map((session) => Date.parse(session.createdAt)).sort((a, b) => a - b);
  const everything = !filtered && picked.length === sessions.length;
  const minOk = Number.isInteger(Number(min)) && Number(min) >= 1 && Number(min) <= 100;
  const toggle = (title) => setChosen((current) => {
    const next = new Set(current);
    if (next.has(title)) next.delete(title); else next.add(title);
    return next;
  });

  const download = async () => {
    setBusy(true);
    try { window.localStorage.setItem(MIN_KEY, String(min)); } catch { /* private window: not remembered */ }
    try {
      const query = new URLSearchParams({ min: String(Number(min)) });
      if (!everything) query.set('codes', picked.map((session) => session.code).join(','));
      await downloadFile(`/api/admin/attendance-register.xlsx?${query}`, 'attendance-register.xlsx');
      onClose();
    } catch (error) { showToast(error.message); setBusy(false); }
  };

  return (
    <Modal label="Download attendance" onClose={onClose}>
      <div className="dialog att-export">
        <h1>Download attendance</h1>
        <p>
          One Excel register: a row for each student, a column for each session, their totals, and a sheet of everyone under the minimum.
          {filtered && ` Starting from the ${plural(sessions.length, 'session')} in your filtered list.`}
        </p>
        {classes.length > 1 && (
          <fieldset className="att-export-classes">
            <legend className="field-label">Classes</legend>
            {classes.map((entry) => (
              <label className="check-row" key={entry.title}>
                <input type="checkbox" checked={chosen.has(entry.title)} onChange={() => toggle(entry.title)}/>
                <span>{entry.title}</span>
                <small>{plural(entry.count, 'session')}</small>
              </label>
            ))}
          </fieldset>
        )}
        <div className="att-export-dates">
          <label>
            <span className="field-label">From</span>
            <input className="text-input" type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)}/>
          </label>
          <label>
            <span className="field-label">To</span>
            <input className="text-input" type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)}/>
          </label>
        </div>
        <label className="att-export-min">
          <span className="field-label">Minimum attendance</span>
          <span className="input-with-unit">
            <input className="text-input" type="number" min="1" max="100" step="1" inputMode="numeric" value={min}
              onChange={(event) => setMin(event.target.value)} aria-describedby="att-export-min-help"/>
            <span aria-hidden="true">%</span>
          </span>
          <small id="att-export-min-help" className="help">Totals under it show in red, and those students get a sheet of their own.</small>
        </label>
        <p className="help att-export-summary">
          {picked.length
            ? `${plural(picked.length, 'session')} · ${niceDay(dates[0])}${niceDay(dates[0]) === niceDay(dates.at(-1)) ? '' : ` to ${niceDay(dates.at(-1))}`}`
            : 'No sessions match.'}
        </p>
        <div className="dialog-actions">
          <button className="button button-primary" type="button" disabled={busy || !picked.length || !minOk} onClick={download}>
            <Download size={16} aria-hidden="true"/>{busy ? 'Preparing…' : 'Download Excel'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
