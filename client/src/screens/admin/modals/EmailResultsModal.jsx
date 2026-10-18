import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, Download, Eye, Mail, Search, SlidersHorizontal } from 'lucide-react';
import { api, post } from '../../../lib/api.js';
import { clockTime, shortDateTime } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { SwitchRow } from '../../../components/FormControls.jsx';
import { allShownSelected, canChooseRecipient } from './result-mail-selection.js';

const SHOWS = [
  { value: 'all', label: 'All' },
  { value: 'not', label: 'Not emailed' },
  { value: 'sent', label: 'Emailed' },
  { value: 'failed', label: 'Failed' }
];
const PENDING = ['queued', 'sending'];

/** Where one student's email stands, in a word, and how it is coloured. */
function mailWord(row) {
  const mail = row.mail;
  if (mail?.status === 'sent') return { text: `Emailed ${sameDay(mail.at) ? clockTime(mail.at) : shortDateTime(mail.at)}`, tone: 'success' };
  if (mail?.status === 'queued') return { text: 'Waiting to send', tone: 'muted' };
  if (mail?.status === 'sending') return { text: 'Sending…', tone: 'muted' };
  if (mail?.status === 'failed') return { text: 'Failed', tone: 'danger', title: mail.error };
  if (!row.canEmail) return { text: row.reason, tone: 'muted' };
  return { text: 'Not emailed', tone: 'muted' };
}
const sameDay = (value) => value && new Date(value).toDateString() === new Date().toDateString();
const shownIn = (row, show) => (show === 'all' ? true
  : show === 'sent' ? row.mail?.status === 'sent'
    : show === 'failed' ? row.mail?.status === 'failed'
      : row.canEmail && !row.mail);

/**
 * Email results, once the marks are out (services/result-mail-service.js on
 * the server): the class who handed in, to search and filter, each with a
 * tick - those not emailed yet start ticked, and any can be taken off or put
 * back - what the email holds, a preview of one student's, and Send. Emails
 * go out in the background; the list follows them as they do. Today's
 * allowance is shared with sign-in codes, so who does not fit today stays
 * "Not emailed" for another day.
 */
export function EmailResultsModal({ code, onClose, showToast }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [show, setShow] = useState('all');
  const [options, setOptions] = useState({ answers: true, correct: true, classStats: false, analysisImage: false });
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const path = `/api/admin/tests/${encodeURIComponent(code)}/result-mails`;

  const load = useCallback(() => api(path).then((reply) => {
    setData(reply);
    // Those not emailed yet, ticked to begin with.
    setSelected((current) => current ?? new Set(reply.students.filter((row) => row.canEmail && !row.mail).map((row) => row.id)));
  }, (error) => showToast(error.message)), [path, showToast]);
  useEffect(() => { load(); }, [load]);

  // While emails are on their way, the list follows them.
  const sendingNow = Boolean(data?.students.some((row) => PENDING.includes(row.mail?.status)));
  useEffect(() => {
    if (!sendingNow) return undefined;
    const timer = window.setInterval(load, 2500);
    return () => window.clearInterval(timer);
  }, [sendingNow, load]);

  const rows = data?.students || [];
  const counts = useMemo(() => Object.fromEntries(SHOWS.map(({ value }) => [value, rows.filter((row) => shownIn(row, value)).length])), [rows]);
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase();
    return rows.filter((row) => shownIn(row, show)
      && (!words || [row.name, row.email, row.sapId].some((field) => String(field || '').toLowerCase().includes(words))));
  }, [rows, query, show]);
  const choosable = canChooseRecipient;
  const allShown = allShownSelected(visible, selected);
  const picked = rows.filter((row) => selected?.has(row.id) && choosable(row));
  const left = data?.allowance.left ?? 0;

  const toggle = (id) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectShown = () => setSelected((current) => new Set([...current, ...visible.filter(choosable).map((row) => row.id)]));
  const clearShown = () => setSelected((current) => new Set([...current].filter((id) => !visible.some((row) => row.id === id))));
  const option = (name) => (value) => setOptions((current) => ({ ...current, [name]: value, ...(name === 'answers' && !value ? { correct: false } : {}) }));

  const openPreview = async (row) => {
    setBusy(true);
    try {
      const mail = await post(`${path}/preview`, { registrationId: row.id, options });
      setPreview({ ...mail, name: row.name });
    } catch (error) { showToast(error.message); }
    setBusy(false);
  };

  const send = async () => {
    const count = picked.length;
    const later = Math.max(0, count - left);
    if (!window.confirm(`Email ${count} student${count === 1 ? '' : 's'} their results${options.analysisImage ? ' and the class analysis PNG' : ''}?${later ? ` Only ${left} can go today; the other ${later} stay "Not emailed" for another day.` : ''}`)) return;
    setBusy(true);
    try {
      const reply = await post(path, { registrationIds: picked.map((row) => row.id), options });
      const parts = [`${reply.queued} email${reply.queued === 1 ? '' : 's'} on the way`, reply.overLimit && `${reply.overLimit} left for another day (today's emails are used up)`, reply.skipped && `${reply.skipped} skipped`].filter(Boolean);
      showToast(`${parts.join('; ')}.`, reply.queued ? 'success' : undefined);
      setSelected(new Set());
      await load();
    } catch (error) { showToast(error.message); }
    setBusy(false);
  };

  return (
    <Modal label="Email results" onClose={onClose} className={`result-mail-sheet${preview ? ' is-preview' : ''}`}>
      {preview ? (
        <div className="result-mail-preview">
          <button type="button" className="button button-secondary button-small" onClick={() => setPreview(null)}>
            <ArrowLeft size={15} aria-hidden="true"/>Back to the list
          </button>
          <dl className="result-mail-head">
            <div><dt>To</dt><dd>{preview.to ? `${preview.name} · ${preview.to}` : `${preview.name} (no email)`}</dd></div>
            <div><dt>Subject</dt><dd>{preview.subject}</dd></div>
          </dl>
          {(preview.attachments || []).filter((file) => file.name?.endsWith('.png') && file.content).map((file) => (
            <figure className="result-mail-attachment" key={file.name}>
              <figcaption>
                <span>Class analysis · PNG attachment</span>
                <a className="button button-secondary button-small" href={`data:image/png;base64,${file.content}`} download={file.name}>
                  <Download size={15} aria-hidden="true"/>Download
                </a>
              </figcaption>
              <img src={`data:image/png;base64,${file.content}`} alt="Whole-class analysis: attempted and absent counts, average, median, highest and lowest marks, papers still to mark, score bands and marks distribution" width="1400" height="914"/>
            </figure>
          ))}
          {/* As the student will see it - in a frame of its own, with nothing able to run; its link opens in a new tab. */}
          <iframe className="result-mail-frame" title={`Email preview for ${preview.name}`} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={preview.html}/>
          <p className="help">See your full result opens the student&apos;s own result page; they sign in to see it.</p>
        </div>
      ) : (
        <>
          <header className="result-mail-header">
            <div className="page-heading result-mail-title"><h1>Email results</h1></div>
            <button type="button" className="button button-secondary button-small result-mail-options-toggle"
              aria-expanded={settingsOpen} aria-controls="result-mail-settings" onClick={() => setSettingsOpen((open) => !open)}>
              <SlidersHorizontal size={16} aria-hidden="true"/><span>Email options</span><ChevronDown size={15} aria-hidden="true"/>
            </button>
          </header>
          {!data ? <p className="help result-mail-loading">Loading the class…</p> : (
            <>
              <div className="result-mail-body">
                {(data.problem || data.mail === 'off' || data.mail === 'log') && <div className="result-mail-notices">
                  {data.problem && <p className="notice result-mail-notice">{data.problem}</p>}
                  {data.mail === 'off' && <p className="notice result-mail-notice">Email is not set up on this server yet (the Brevo key), so nothing can be sent.</p>}
                  {data.mail === 'log' && <p className="notice result-mail-notice">Test server without email: each email is written to the server's log instead of being sent.</p>}
                </div>}
                <div className={`result-mail-layout${settingsOpen ? ' is-options-open' : ''}`}>
                  <section className="result-mail-settings" id="result-mail-settings" aria-labelledby="result-mail-settings-title">
                    <h2 id="result-mail-settings-title">Include in email</h2>
                    <div className="switch-list result-mail-options">
                      <SwitchRow checked={options.answers} onChange={option('answers')} title="Their answers" infoOnHover
                        description="Questions, their answers and marks."/>
                      <SwitchRow checked={options.correct} onChange={option('correct')} title="The correct answers" disabled={!options.answers} infoOnHover
                        description="Correct answers for mistakes. Turn off to reuse questions."/>
                      <SwitchRow checked={options.classStats} onChange={option('classStats')} title="How the class did" infoOnHover
                        description="Class average and highest mark; no names."/>
                      <SwitchRow checked={options.analysisImage} onChange={option('analysisImage')} title="Class analysis image" infoOnHover
                        description="Whole-class summary and charts as a PNG; no student names."/>
                    </div>
                  </section>
                  <section className="result-mail-recipients" aria-label="Students">
                    <div className="result-mail-recipient-head">
                      <h2>Students</h2><span>{visible.length} of {rows.length} shown</span>
                    </div>

                    <div className="result-mail-tools">
                      <label className="result-mail-search">
                        <Search size={16} aria-hidden="true"/>
                        <input className="text-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                          placeholder="Search name, email or SAP ID" aria-label="Search students"/>
                      </label>
                      <div className="segmented result-mail-show" role="group" aria-label="Show">
                        {SHOWS.map((item) => (
                          <button key={item.value} type="button" className={show === item.value ? 'is-on' : undefined} aria-pressed={show === item.value} onClick={() => setShow(item.value)}>
                            {item.label} <span className="result-mail-count">{counts[item.value]}</span>
                          </button>
                        ))}
                      </div>
                      <select className="select result-mail-status-filter" aria-label="Filter by email status" value={show}
                        onChange={(event) => setShow(event.target.value)}>
                        {SHOWS.map((item) => (
                          <option key={item.value} value={item.value}>{item.value === 'all' ? 'All students' : item.label} ({counts[item.value]})</option>
                        ))}
                      </select>
                    </div>

                    <div className="result-mail-bulk">
                      <span><strong>{picked.length}</strong> selected</span>
                      <button type="button" className={`button button-small ${allShown ? 'button-primary is-selected' : 'button-secondary'}`} onClick={selectShown} disabled={!visible.some(choosable)} aria-pressed={allShown} aria-label="Select all shown" title="Select all students matching the search and filter">
                        <span className="result-mail-bulk-long">Select all shown</span><span className="result-mail-bulk-short" aria-hidden="true">Select all</span>
                      </button>
                      <button type="button" className="button button-secondary button-small" onClick={clearShown} disabled={!visible.some((row) => selected?.has(row.id))} aria-label="Clear shown" title="Clear students matching the search and filter">
                        <span className="result-mail-bulk-long">Clear shown</span><span className="result-mail-bulk-short" aria-hidden="true">Clear</span>
                      </button>
                    </div>

                    {visible.length ? (
                      <ul className="result-mail-list" aria-label="Student recipients">
                        {visible.map((row) => {
                          const state = mailWord(row);
                          const can = choosable(row);
                          return (
                            <li key={row.id} className={`result-mail-row${can ? '' : ' is-off'}`}>
                              <label className="result-mail-pick">
                                <input type="checkbox" checked={can && Boolean(selected?.has(row.id))} disabled={!can} onChange={() => toggle(row.id)}
                                  aria-label={`Email ${row.name}`}/>
                                <span className="result-mail-who">
                                  <strong title={row.name}>{row.name}</strong>
                                  <small title={[row.email, row.sapId].filter(Boolean).join(' · ') || 'Guest'}>{[row.email, row.sapId].filter(Boolean).join(' · ') || 'Guest'}</small>
                                </span>
                              </label>
                              <span className="result-mail-marks">{row.score === null ? '–' : `${row.score} / ${row.totalMarks}`}{row.percent !== null && <small>{row.percent}%</small>}</span>
                              <span className={`pill result-mail-state ${state.tone}`} title={state.title || state.text}>{state.text}</span>
                              <button type="button" className="button icon-button result-mail-eye" onClick={() => openPreview(row)} disabled={busy}
                                aria-label={`Preview ${row.name}'s email`} title="Preview the email">
                                <Eye size={16} aria-hidden="true"/>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : <p className="help result-mail-empty">No student matches.</p>}
                  </section>
                </div>
              </div>

              <footer className="modal-actions result-mail-foot">
                <span className={`result-mail-left${picked.length > left ? ' is-short' : ''}`}>
                  {left} email{left === 1 ? '' : 's'} left today{picked.length > left ? ` - ${picked.length - left} will wait for another day` : ''}
                </span>
                <button type="button" className="button button-primary" onClick={send}
                  disabled={busy || !picked.length || !left || Boolean(data.problem) || data.mail === 'off'}>
                  <Mail size={16} aria-hidden="true"/>{busy ? 'Working…' : `Email ${picked.length} student${picked.length === 1 ? '' : 's'}`}
                </button>
              </footer>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
