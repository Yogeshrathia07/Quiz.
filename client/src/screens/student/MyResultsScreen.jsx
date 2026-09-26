import { useEffect, useState } from 'react';
import { Clock, Hourglass, PenLine } from 'lucide-react';
import { api, downloadMyResponses } from '../../lib/api.js';
import { durationLabel, shortDateTime } from '../../lib/format.js';
import { StatusPill } from '../../components/StatusPill.jsx';
import { SapIdPrompt } from './SapIdPrompt.jsx';
import { Skeleton } from '../../components/Skeleton.jsx';

function MarksCell({ result }) {
  if (result.attemptStatus !== 'submitted') return <span className="table-subtext">—</span>;
  if (!result.released) {
    // A short word and an icon; the full sentence is in the tooltip.
    const waiting = {
      after_quiz: { icon: Hourglass, text: 'After the test ends' },
      manual: { icon: PenLine, text: 'Being marked' }
    }[result.waitingFor] || { icon: Clock, text: 'Not released yet' };
    return (
      <span className="marks-waiting" title={result.message || 'Marks are not released yet.'}>
        <waiting.icon size={14} aria-hidden="true"/>{waiting.text}
      </span>
    );
  }
  return <strong>{result.score}/{result.totalQuestions}</strong>;
}

function attemptLabel(result) {
  if (result.registrationStatus === 'rejected') return 'rejected';
  if (result.registrationStatus === 'pending') return 'pending';
  return result.attemptStatus || 'not_started';
}

const percentOf = (result) => (result.totalQuestions ? (result.score / result.totalQuestions) * 100 : 0);

/** How the student has done overall, from the marks released to them so far. */
function ScoreSummary({ results }) {
  const submitted = results.filter((result) => result.attemptStatus === 'submitted');
  const marked = submitted.filter((result) => result.released);
  const average = marked.length ? marked.reduce((total, result) => total + percentOf(result), 0) / marked.length : null;
  const best = marked.length ? marked.reduce((top, result) => (percentOf(result) > percentOf(top) ? result : top)) : null;
  return (
    <section className="card my-summary">
      <div className="analysis-summary">
        <div><span>Tests taken</span><strong>{submitted.length}</strong></div>
        <div><span>Marks released</span><strong>{marked.length}</strong></div>
        <div><span>Average</span><strong>{average === null ? '—' : `${Math.round(average * 10) / 10}%`}</strong></div>
        <div><span>Best</span><strong>{best ? `${best.score}/${best.totalQuestions} · ${best.title}` : '—'}</strong></div>
      </div>
    </section>
  );
}

/** The student's SAP ID: shown once saved, asked for while missing. */
function SapIdCard({ profile, onAdd }) {
  if (profile === undefined) return null;
  if (profile?.sapId) {
    return <p className="my-sap-id">SAP ID <strong>{profile.sapId}</strong> <span>· only an administrator can change it</span></p>;
  }
  return (
    <div className="notice my-sap-missing">
      <span>Your account has no SAP ID yet. Add it before you register for a test.</span>
      <button className="button button-secondary button-small" type="button" onClick={onAdd}>Add SAP ID</button>
    </div>
  );
}

function DownloadButton({ result, showToast }) {
  const [busy, setBusy] = useState(false);
  if (!result.canDownload) return null;
  const download = async () => {
    setBusy(true);
    try { await downloadMyResponses(result.code); } catch (error) { showToast(error.message); }
    setBusy(false);
  };
  return (
    <button
      className="button button-secondary button-small" type="button" disabled={busy} onClick={download}
      title={result.pendingManual ? 'Some short answers are not marked yet. Download again after marking for the updated sheet.' : 'Your answers, the correct answers and your marks'}
    >
      {busy ? 'Preparing…' : result.pendingManual ? 'Responses (ungraded)' : 'Download responses'}
    </button>
  );
}

/** Every test this account has registered for, with marks where they have been released. */
export function MyResultsScreen({ go, showToast, isStudent = false }) {
  const [results, setResults] = useState(null);
  // undefined while loading; null when the student has no SAP ID yet.
  const [profile, setProfile] = useState(undefined);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    api('/api/me/results').then((data) => setResults(data.results)).catch((error) => showToast(error.message));
  }, [showToast]);

  useEffect(() => {
    if (!isStudent) return;
    api('/api/student/profile')
      .then((data) => { setProfile(data.profile); if (!data.profile) setAsking(true); })
      .catch((error) => showToast(error.message));
  }, [isStudent, showToast]);

  return (
    <section className="admin-list">
      <header className="page-title-row">
        <div>
          <h1>My results</h1>
          <p>Marks appear here once your teacher releases them.</p>
          {isStudent && <SapIdCard profile={profile} onAdd={() => setAsking(true)}/>}
        </div>
      </header>
      {!results ? (
        <Skeleton rows={3} label="Loading your results"/>
      ) : results.length === 0 ? (
        <div className="card empty empty-state">
          <strong>No tests yet</strong>
          <p>When your teacher shows a QR code in class, scan it with your phone to join the test. Your results will appear here.</p>
        </div>
      ) : (
        <>
          <ScoreSummary results={results}/>
          <section className="card students-card results-card">
            <div className="table-scroll">
              <table className="live-table results-table">
                <thead>
                  <tr>
                    <th>Test</th>
                    <th>Status</th>
                    <th>Submitted</th>
                    <th className="col-time">Time taken</th>
                    <th className="col-left">Times left</th>
                    <th>Marks</th>
                    <th className="column-actions"></th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={`${result.code}-${result.startedAt || result.registrationStatus}`}>
                      <td data-label="Test">
                        <strong>{result.title}</strong>
                        <span className="table-subtext">{result.code}</span>
                      </td>
                      <td data-label="Status"><StatusPill status={attemptLabel(result)}/></td>
                      <td data-label="Submitted">{shortDateTime(result.submittedAt)}</td>
                      <td data-label="Time taken" className="col-time">{result.timeTakenSeconds === null ? '—' : durationLabel(result.timeTakenSeconds)}</td>
                      <td data-label="Times left" className="col-left">{result.attemptStatus ? result.timesLeft : '—'}</td>
                      <td data-label="Marks"><MarksCell result={result}/></td>
                      <td data-label="">
                        <div className="table-actions">
                          <DownloadButton result={result} showToast={showToast}/>
                          <button className="button button-secondary button-small" type="button" onClick={() => go(`/?test=${encodeURIComponent(result.code)}`)}>
                            Open
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {asking && (
        <SapIdPrompt
          showToast={showToast}
          onClose={() => setAsking(false)}
          onSaved={(saved) => { setProfile(saved); setAsking(false); }}
        />
      )}
    </section>
  );
}
