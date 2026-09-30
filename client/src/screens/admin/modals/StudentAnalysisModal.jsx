import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../../../lib/api.js';
import { dateTime } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { RichText } from '../../../components/RichText.jsx';

const markValue = (answer) => (answer.isCorrect === null ? '' : answer.isCorrect ? '1' : '0');

function AnswerCard({ answer, mark, onMark, readOnly }) {
  return (
    <article className="analysis-answer">
      <div className="analysis-answer-head">
        <div>
          <p className="eyebrow">Question {answer.questionNumber} · {answer.type.toUpperCase()}</p>
          <RichText className="analysis-prompt" text={answer.prompt}/>
        </div>
        {answer.manualGrading && !readOnly ? (
          <label className="analysis-mark-input">
            Mark
            <select className="select" value={mark ?? ''} onChange={(event) => onMark(event.target.value)}>
              <option value="">Not marked</option>
              <option value="1">Correct (1)</option>
              <option value="0">Incorrect (0)</option>
            </select>
          </label>
        ) : (
          <span className={`analysis-mark ${answer.isCorrect ? 'success' : answer.isCorrect === null ? 'warn' : 'danger'}`}>
            {answer.isCorrect === null ? (answer.manualGrading ? 'Not marked' : 'Not answered') : answer.isCorrect ? '1 / 1' : '0 / 1'}
          </span>
        )}
      </div>
      <div className="analysis-response-grid">
        <div><span>Student answer</span><p>{answer.selectedAnswer || 'No answer submitted.'}</p></div>
        <div><span>Answer key</span><p>{answer.manualGrading ? 'Manual review required' : answer.correctAnswer}</p></div>
      </div>
      {answer.textBursts?.length > 0 && (
        <p className="analysis-answer-burst">
          Text appeared all at once: {answer.textBursts.map((chars) => `${chars} characters`).join(', ')} — pasted (a phone keyboard's clipboard) or voice typing.
        </p>
      )}
      <p className="analysis-answer-meta">
        {answer.answeredAt ? `Answered ${dateTime(answer.answeredAt)}` : 'Not answered'}
        {answer.timeSpentSeconds !== undefined && answer.timeSpentSeconds !== null && (
          ` · on screen ${answer.timeSpentSeconds}s${answer.timeAllowedSeconds ? ` of ${answer.timeAllowedSeconds}s` : ''}${answer.timedOut ? ' — time ran out' : ''}`
        )}
      </p>
    </article>
  );
}

const seconds = (ms) => `${Math.round((Number(ms) || 0) / 1000)}s`;

const clock = (value) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const KIND_LABEL = { join: 'Joined', start: 'Start', answer: 'Answer', exit: 'Left', return: 'Back', flag: 'Blocked', lock: 'Lock', restart: 'Restart', submit: 'Submit', other: '' };

/** The student's whole test in order: joining, every answer and change, every exit and return, submitting. */
function ActivityLog({ entries }) {
  const [filter, setFilter] = useState('all');
  if (!entries.length) return <p className="help">No activity recorded yet.</p>;
  const shown = filter === 'all' ? entries
    : filter === 'answers' ? entries.filter((entry) => entry.kind === 'answer')
      : entries.filter((entry) => ['exit', 'return', 'flag', 'lock'].includes(entry.kind));
  return (
    <details className="activity-log" open>
      <summary>Activity log ({entries.length} events)</summary>
      <div className="activity-filter" role="group" aria-label="Show">
        {[['all', 'Everything'], ['answers', 'Answers'], ['integrity', 'Exits & blocked']].map(([id, label]) => (
          <button key={id} type="button" className={filter === id ? 'is-on' : ''} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      <ol>
        {shown.map((entry, index) => (
          <li key={`${entry.at}-${index}`} className={`is-${entry.kind}`}>
            <time title={dateTime(entry.at)}>{clock(entry.at)}</time>
            <span className="activity-kind">{KIND_LABEL[entry.kind] ?? ''}</span>
            <span className="activity-text">
              {entry.label}
              {entry.durationMs !== null && entry.durationMs !== undefined ? ` · ${seconds(entry.durationMs)} away` : ''}
              {entry.detail ? <small>{entry.detail}</small> : null}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** Everything the integrity monitor saw, so a mark can be judged with it. */
function IntegrityReport({ integrity, location }) {
  if (!integrity) return null;
  const { leaves, limits } = integrity;
  return (
    <section className="integrity-report">
      <h2>Integrity</h2>
      {integrity.isLocked && <p className="notice danger">Locked: {integrity.lockReason}</p>}
      <div className="analysis-summary">
        <div><span>Left the test</span><strong>{integrity.leaveCount}×{limits.exits ? ` (limit ${limits.exits})` : ''}</strong></div>
        <div><span>Time away</span><strong>{seconds(integrity.awayMs)}</strong></div>
        <div><span>Longest away</span><strong>{seconds(integrity.longestAwayMs)}{limits.awaySeconds ? ` (limit ${limits.awaySeconds}s)` : ''}</strong></div>
        <div><span>Times locked</span><strong>{integrity.lockCount}</strong></div>
        <div><span>Left fullscreen</span><strong>{leaves.fullscreen}</strong></div>
        <div><span>Switched app / tab</span><strong>{leaves.tab_switch}</strong></div>
        <div><span>Other window or pop-up</span><strong>{leaves.focus_lost}</strong></div>
        <div><span>Went offline</span><strong>{leaves.offline}</strong></div>
        <div><span>Split screen</span><strong>{leaves.split_screen}</strong></div>
        <div><span>Copy / paste / drag tries</span><strong>{(integrity.flags?.copy || 0) + (integrity.flags?.cut || 0) + (integrity.flags?.paste || 0) + (integrity.flags?.drop || 0)}</strong></div>
        <div><span>Text all at once</span><strong>{integrity.flags?.text_burst || 0}</strong></div>
        <div><span>Keyboard app while typing (not counted)</span><strong>{integrity.flags?.keyboard_app || 0}</strong></div>
        <div><span>Screenshot / print tries</span><strong>{(integrity.flags?.screenshot || 0) + (integrity.flags?.print || 0)}</strong></div>
        <div><span>Developer tools tries</span><strong>{integrity.flags?.devtools || 0}</strong></div>
        <div><span>Browser extension seen</span><strong>{integrity.flags?.extension || 0}</strong></div>
        {location && (location.outsideCount || location.submit) && (
          <>
            <div><span>Left the venue</span><strong>{location.outsideCount || 0}×</strong></div>
            <div><span>Time outside venue</span><strong>{seconds(location.outsideMs || 0)}</strong></div>
          </>
        )}
      </div>
      <ActivityLog entries={integrity.activity || []}/>
    </section>
  );
}

/**
 * One student's paper, answer by answer, with their integrity record. From the
 * test's own dashboard the short answers can be marked; opened from the Users
 * page (`analysisPath`, `readOnly`) it only shows.
 */
export function StudentAnalysisModal({ code, registration, onClose, onSaved, showToast, analysisPath = null, readOnly = false, showIntegrity = true }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [marks, setMarks] = useState({});
  const [saving, setSaving] = useState(false);
  const basePath = `/api/admin/tests/${encodeURIComponent(code)}/registrations/${encodeURIComponent(registration.id)}`;
  const readPath = analysisPath || `${basePath}/analysis`;

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const response = await api(readPath);
      setData(response);
      setMarks(Object.fromEntries(response.answers.filter((answer) => answer.manualGrading).map((answer) => [answer.questionId, markValue(answer)])));
    } catch (error) {
      // The dialog must explain an unavailable paper instead of showing a
      // permanent placeholder; the User page remains usable underneath.
      setLoadError(error.message);
    }
  }, [readPath]);

  useEffect(() => { void load(); }, [load]);

  const save = async (event) => {
    event.preventDefault();
    const entries = Object.entries(marks).filter(([, value]) => value !== '');
    if (!entries.length) return showToast('Choose at least one short-answer mark.');
    setSaving(true);
    try {
      await Promise.all(entries.map(([questionId, value]) => post(`${basePath}/manual-grade`, {
        questionId: Number(questionId),
        isCorrect: Number(value)
      })));
      showToast('Short-answer marks saved.');
      onSaved();
      onClose();
    } catch (error) { setSaving(false); showToast(error.message); }
  };

  if (!data) {
    return (
      <Modal label="Student analysis" onClose={onClose}>
        <h1>{registration.name}</h1>
        {loadError ? (
          <div className="user-load-error" role="alert">
            <p>Could not load this test paper. {loadError}</p>
            <button className="button button-secondary button-small" type="button" onClick={() => { void load(); }}>Try again</button>
          </div>
        ) : <div className="user-loading" role="status" aria-label="Loading their paper"><span className="user-loading-row"/><span className="user-loading-row"/><span className="user-loading-row"/></div>}
      </Modal>
    );
  }
  const hasManual = !readOnly && data.answers.some((answer) => answer.manualGrading);

  return (
    <Modal label={`Student analysis for ${data.registration.name}`} onClose={onClose}>
      <h1>{data.registration.name}</h1>
      <p>{data.test ? `${data.test.title} · ` : ''}{data.registration.sapId} · {data.registration.email}</p>

      <div className="analysis-summary">
        <div><span>Attempt</span><strong>{{ submitted: 'Submitted', in_progress: 'In progress' }[data.attempt?.status] || 'Not started'}</strong></div>
        <div><span>Score</span><strong>{data.attempt ? `${data.attempt.score} / ${data.attempt.total}` : '—'}</strong></div>
        <div><span>Answered</span><strong>{data.attempt ? `${data.attempt.answered} / ${data.attempt.total}` : '—'}</strong></div>
      </div>

      {showIntegrity && <IntegrityReport integrity={data.integrity} location={data.location}/>}

      {showIntegrity && data.location && (
        <section className="integrity-report">
          <h2>Location checks</h2>
          <div className="analysis-summary">
            <div><span>In range</span><strong>{data.location.inRange || 0}</strong></div>
            <div><span>Out of range</span><strong>{data.location.outOfRange || 0}</strong></div>
            <div><span>Inconclusive</span><strong>{data.location.inconclusive || 0}</strong></div>
          </div>
          <p className="help">Uncertain GPS readings are recorded separately and are not treated as outside the venue.</p>
        </section>
      )}

      <form onSubmit={save}>
        {data.answers.map((answer) => (
          <AnswerCard
            key={answer.questionId}
            answer={answer}
            mark={marks[answer.questionId]}
            onMark={(value) => setMarks((current) => ({ ...current, [answer.questionId]: value }))}
            readOnly={readOnly}
          />
        ))}
        {hasManual && (
          <div className="modal-actions">
            <button className="button button-primary" disabled={saving}>{saving ? 'Saving…' : 'Save short-answer marks'}</button>
          </div>
        )}
      </form>
    </Modal>
  );
}
