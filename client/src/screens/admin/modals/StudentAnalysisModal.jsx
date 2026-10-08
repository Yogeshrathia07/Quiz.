import { useCallback, useEffect, useState } from 'react';
import { api, post } from '../../../lib/api.js';
import { dateTime, durationLabel } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { PersonLink } from '../../../components/PersonLink.jsx';
import { InfoTip } from '../../../components/InfoTip.jsx';
import { RichText } from '../../../components/RichText.jsx';
import { QuestionImage } from '../../../components/QuestionImage.jsx';
import { Flag, LogOut, PenLine, Search, ShieldAlert, WifiOff } from 'lucide-react';
import { FilterMenu } from '../../../components/FilterMenu.jsx';
import { applyFilters } from '../../../lib/filters.js';

const markValue = (answer) => (answer.marks === null || answer.marks === undefined ? '' : String(answer.marks));

function AnswerCard({ answer, mark, onMark, readOnly }) {
  return (
    <article className="analysis-answer">
      <div className="analysis-answer-head">
        <div>
          <p className="eyebrow">Question {answer.questionNumber} · {answer.type.toUpperCase()}</p>
          <RichText className="analysis-prompt" text={answer.prompt}/>
          {answer.image && <QuestionImage image={answer.image} label={`Picture for question ${answer.questionNumber}`} compact/>}
        </div>
        {answer.manualGrading && !readOnly ? (
          // Any mark from 0 to what the question is worth; 0 and full marks one tap away.
          <div className="analysis-mark-input">
            <label>
              <span>Marks</span>
              <input className="text-input" type="number" min="0" max={answer.maxMarks} step="any" inputMode="decimal" placeholder="—"
                value={mark ?? ''} onChange={(event) => onMark(event.target.value)} aria-label={`Marks out of ${answer.maxMarks}`}/>
              <span className="analysis-mark-of">/ {answer.maxMarks}</span>
            </label>
            <div className="analysis-mark-quick">
              <button type="button" className={mark === '0' ? 'is-on' : undefined} onClick={() => onMark('0')}>0</button>
              <button type="button" className={mark === String(answer.maxMarks) ? 'is-on' : undefined} onClick={() => onMark(String(answer.maxMarks))}>Full</button>
            </div>
          </div>
        ) : (
          <span className={`analysis-mark ${answer.isCorrect ? 'success' : answer.partial ? 'warn' : answer.isCorrect === null ? 'warn' : 'danger'}`}>
            {answer.isCorrect === null ? (answer.manualGrading ? 'Not marked' : 'Not answered') : `${answer.marks} / ${answer.maxMarks}`}
          </span>
        )}
      </div>
      <div className="analysis-response-grid">
        <div><span>Student answer</span><p>{answer.selectedAnswer || 'No answer submitted.'}</p></div>
        <div><span>Answer key</span><p>{answer.manualGrading ? 'Manual review required' : answer.correctAnswer}</p></div>
      </div>
      {answer.late && (
        <p className="analysis-answer-burst analysis-answer-late">
          <span>Arrived late — made {clock(answer.late.madeAt)}, received {clock(answer.late.arrivedAt)}</span>
          <InfoTip label="About late answers">
            Made on the student's device before its time ran out (by the device's clock) and held there by a lost connection,
            then sent once it was back. Check it against the offline periods in the activity log.
          </InfoTip>
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
const duration = (ms) => {
  const total = Math.round((Number(ms) || 0) / 1000);
  return total >= 60 ? `${Math.floor(total / 60)}m ${total % 60}s` : `${total}s`;
};

const clock = (value) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
const KIND_LABEL = {
  join: 'Joined', start: 'Start', answer: 'Answer', exit: 'Left', return: 'Back', flag: 'Blocked', lock: 'Lock', restart: 'Restart', submit: 'Submit',
  offline: 'Offline', late: 'Late', other: ''
};

/**
 * What the log can be narrowed to - the portal's own Filter button, a tick
 * box for each kind of event. Late answers count both as answers and as
 * offline: they were made offline.
 */
const LOG_GROUPS = [{
  id: 'kind',
  title: 'Show',
  options: [
    { id: 'answers', label: 'Answers and changes', test: (entry) => entry.kind === 'answer' || entry.kind === 'late' },
    { id: 'exits', label: 'Left and came back', test: (entry) => entry.kind === 'exit' || entry.kind === 'return' },
    { id: 'blocked', label: 'Blocked actions and locks', test: (entry) => entry.kind === 'flag' || entry.kind === 'lock' },
    { id: 'offline', label: 'Offline and late answers', test: (entry) => entry.kind === 'offline' || entry.kind === 'late' },
    { id: 'steps', label: 'Joined, started, submitted', test: (entry) => !['answer', 'late', 'exit', 'return', 'flag', 'lock', 'offline'].includes(entry.kind) }
  ]
}];
const LOG_ICONS = {
  answers: { icon: PenLine, tone: 'info' },
  exits: { icon: LogOut, tone: 'bad' },
  blocked: { icon: ShieldAlert, tone: 'bad' },
  offline: { icon: WifiOff, tone: 'warn' },
  steps: { icon: Flag, tone: 'muted' }
};
const searchText = (entry) => `${entry.label} ${entry.detail || ''} ${KIND_LABEL[entry.kind] || ''}`.toLowerCase();

/**
 * The student's whole test in order: joining, every answer and change, every
 * exit and return, submitting - with a search and a Filter button above it.
 * `bare` leaves out its own fold-away heading, where the page around it
 * already says what it is (the student's window); `extra` sits at the end of
 * the search line (the download).
 */
export function ActivityLog({ entries, bare = false, extra = null }) {
  const [filters, setFilters] = useState([]);
  const [query, setQuery] = useState('');
  if (!entries.length) {
    return <div className="activity-tools"><p className="help">No activity recorded yet.</p>{extra}</div>;
  }
  const Wrapper = bare ? 'div' : 'details';
  const needle = query.trim().toLowerCase();
  const shown = applyFilters(entries, LOG_GROUPS, filters).filter((entry) => !needle || searchText(entry).includes(needle));
  const narrowed = filters.length > 0 || Boolean(needle);
  return (
    <Wrapper className={`activity-log${bare ? ' is-bare' : ''}`} open={bare ? undefined : true}>
      {!bare && <summary>Activity log ({entries.length} events)</summary>}
      <div className="activity-tools">
        <label className="activity-search">
          <Search size={15} aria-hidden="true"/>
          <input className="text-input" type="search" placeholder="Search the log" aria-label="Search the log" value={query} onChange={(event) => setQuery(event.target.value)}/>
        </label>
        <FilterMenu groups={LOG_GROUPS} rows={entries} selected={filters} onChange={setFilters} icons={LOG_ICONS} title="Filter the log" allLabel="Everything"/>
        <span className="activity-count">{narrowed ? `${shown.length} of ${entries.length}` : `${entries.length} events`}</span>
        {extra}
      </div>
      {shown.length === 0 ? (
        <p className="help activity-none">
          Nothing matches.{' '}
          <button type="button" className="link-button" onClick={() => { setFilters([]); setQuery(''); }}>Show everything</button>
        </p>
      ) : (
        <ol>
          {shown.map((entry, index) => (
            <li key={`${entry.at}-${index}`} className={`is-${entry.kind}`}>
              <time title={dateTime(entry.at)}>{clock(entry.at)}</time>
              <span className="activity-kind">{KIND_LABEL[entry.kind] ?? ''}</span>
              <span className="activity-text">
                {entry.label}
                {/* An offline period says its length in its own words. */}
                {entry.kind !== 'offline' && entry.durationMs !== null && entry.durationMs !== undefined ? ` · ${seconds(entry.durationMs)} away` : ''}
                {entry.late ? ` · received ${clock(entry.late.arrivedAt)}` : ''}
                {entry.detail ? <small>{entry.detail}</small> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Wrapper>
  );
}

/**
 * A line of numbers that fills its row - four, three or two across, so no
 * row ends in a gap - each value level with its neighbours'. `tiles`:
 * [label, value] pairs.
 */
function Tiles({ tiles }) {
  return (
    <div className="analysis-summary" style={{ '--tiles': tiles.length }}>
      {tiles.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </div>
  );
}

/** Why they left, in the words the leaving count is made of; only the reasons that happened are listed. */
const LEAVE_WORDS = {
  fullscreen: 'Left fullscreen',
  tab_switch: 'Switched app or tab',
  focus_lost: 'Another window or pop-up',
  reload: 'Reloaded the page',
  not_fullscreen: 'Not in fullscreen',
  split_screen: 'Split screen',
  // Papers from before going offline stopped counting as leaving.
  offline: 'Went offline (older paper)'
};

/**
 * What the integrity monitor saw, so a mark can be judged with it: how often
 * and how long they left, and why; then what is noted without counting.
 * Only what a browser can really see - no guesses (see RETIRED_FLAGS in
 * src/domain/integrity.js).
 */
function IntegrityReport({ integrity, location }) {
  if (!integrity) return null;
  const { leaves = {}, limits, flags = {}, offline } = integrity;
  const reasons = Object.entries(LEAVE_WORDS).filter(([key]) => leaves[key] > 0);
  return (
    <section className="integrity-report">
      <h2>Integrity</h2>
      {integrity.isLocked && <p className="notice danger">Locked: {integrity.lockReason}</p>}
      <Tiles tiles={[
        ['Left the test', `${integrity.leaveCount}×${limits.exits ? ` (limit ${limits.exits})` : ''}`],
        ['Time away', duration(integrity.awayMs)],
        ['Longest away', `${duration(integrity.longestAwayMs)}${limits.awaySeconds ? ` (limit ${limits.awaySeconds}s)` : ''}`],
        ['Times locked', integrity.lockCount]
      ]}/>
      {reasons.length > 0 && (
        <p className="integrity-why">
          <span className="integrity-why-label">Why they left</span>
          {reasons.map(([key, label]) => <span key={key} className="integrity-reason">{label} <strong>{leaves[key]}×</strong></span>)}
        </p>
      )}
      <Tiles tiles={[
        ['Went offline (not counted)', offline ? `${offline.count}×${offline.ms ? ` · ${duration(offline.ms)}` : ''}` : `${leaves.offline || 0}×`],
        ['Answers arrived late', integrity.lateAnswers || 0],
        ['Copy / paste / drag tries', (flags.copy || 0) + (flags.cut || 0) + (flags.paste || 0) + (flags.drop || 0)],
        ['Print tries', flags.print || 0]
      ]}/>
      {location && (location.outsideCount || location.submit) && (
        <Tiles tiles={[['Left the venue', `${location.outsideCount || 0}×`], ['Time outside venue', duration(location.outsideMs || 0)]]}/>
      )}
      <ActivityLog entries={integrity.activity || []}/>
    </section>
  );
}

/**
 * One student's paper, answer by answer, with their integrity record. From the
 * test's own dashboard the short answers can be marked; opened from the Users
 * page (`analysisPath`, `readOnly`) it only shows. Their name opens them under
 * Users - except from Users itself (`linkPerson` false), where they already are.
 */
export function StudentAnalysisModal({ code, registration, onClose, onSaved, showToast, analysisPath = null, readOnly = false, showIntegrity = true, linkPerson = true }) {
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
    // Checked here first, so a save is all of the marks or none of them.
    const byId = new Map((data?.answers || []).map((answer) => [answer.questionId, answer]));
    const outOfRange = entries.map(([questionId, value]) => ({ answer: byId.get(Number(questionId)), value: Number(value) }))
      .find(({ answer, value }) => answer && !(Number.isFinite(value) && value >= 0 && value <= answer.maxMarks));
    if (outOfRange) return showToast(`Question ${outOfRange.answer.questionNumber}: give a mark from 0 to ${outOfRange.answer.maxMarks}.`);
    setSaving(true);
    try {
      await Promise.all(entries.map(([questionId, value]) => post(`${basePath}/manual-grade`, {
        questionId: Number(questionId),
        marks: Number(value)
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
      <h1>{linkPerson ? <PersonLink email={data.registration.email}>{data.registration.name}</PersonLink> : data.registration.name}</h1>
      <p>{data.test ? `${data.test.title} · ` : ''}{data.registration.sapId} · {data.registration.email}</p>

      <Tiles tiles={[
        ['Attempt', { submitted: 'Submitted', in_progress: 'In progress' }[data.attempt?.status] || 'Not started'],
        ['Score', data.attempt ? `${data.attempt.score} / ${data.attempt.total}` : '—'],
        ['Answered', data.attempt ? `${data.attempt.answered} / ${data.attempt.questions ?? data.attempt.total}` : '—'],
        ['Time taken', typeof data.attempt?.timeTakenSeconds === 'number' ? durationLabel(data.attempt.timeTakenSeconds) : '—']
      ]}/>

      {showIntegrity && <IntegrityReport integrity={data.integrity} location={data.location}/>}

      {showIntegrity && data.location && (
        <section className="integrity-report">
          <h2>
            Location checks{' '}
            <InfoTip label="About location checks">Uncertain GPS readings are recorded separately and are not treated as outside the venue.</InfoTip>
          </h2>
          <Tiles tiles={[['In range', data.location.inRange || 0], ['Out of range', data.location.outOfRange || 0], ['Inconclusive', data.location.inconclusive || 0]]}/>
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
