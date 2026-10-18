import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Lock, ScrollText, Undo2, X } from 'lucide-react';
import { api, post } from '../../../lib/api.js';
import { shortDateTime } from '../../../lib/format.js';
import { Modal } from '../../../components/Modal.jsx';
import { RichText } from '../../../components/RichText.jsx';
import { QuestionImage } from '../../../components/QuestionImage.jsx';
import { InfoTip } from '../../../components/InfoTip.jsx';
import { PersonLink } from '../../../components/PersonLink.jsx';
import { SheetSwitch } from './SheetSwitch.jsx';
import { STATE_WORDS, answerOf, answerState, initialsOf, papersWith, reviewForRegistration } from '../review.js';

const TYPE_NAMES = { mcq: 'Single choice', msq: 'Multiple choice', short: 'Short answer' };
const clip = (text, length) => (String(text || '').length > length ? `${String(text).slice(0, length - 1)}…` : String(text || ''));
const oneLine = (text) => String(text || '').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const clamp = (value, top) => Math.max(0, Math.min(value, Math.max(0, top)));
const toTheSecond = (value) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));

/**
 * The student's answer: every option, theirs and the right ones marked - or
 * what they wrote. `packed`: the options two across, for a question too tall
 * for the window one under another.
 */
function AnswerBody({ question, answer, packed = false }) {
  if (question.manualGrading) {
    return answer.answered && answer.answerText
      ? <div className="review-written">{answer.answerText}</div>
      : <p className="review-none">No answer written.</p>;
  }
  return (
    <ul className={`review-options${packed ? ' is-packed' : ''}`}>
      {question.options.map((text, index) => {
        const id = String(index);
        const picked = answer.selectedOptions.includes(id);
        const right = question.correctOptions.includes(id);
        const tone = picked && right ? 'is-right' : picked ? 'is-wrong' : right ? 'is-key' : '';
        return (
          <li key={id} className={tone}>
            <span className="review-option-mark" aria-hidden="true">{picked ? (right ? <Check size={14}/> : <X size={14}/>) : right ? <Check size={14}/> : null}</span>
            <span className="review-option-text">{text}</span>
            {picked && <span className="review-option-tag">{right ? 'Their answer · right' : 'Their answer'}</span>}
            {!picked && right && <span className="review-option-tag">Right answer</span>}
          </li>
        );
      })}
      {!answer.answered && <li className="review-none">Not answered.</li>}
    </ul>
  );
}

/**
 * The marks for one answer: any from 0 to what the question is worth, 0 and
 * Full a tap away. A choice answer says whether it was marked automatically or
 * by you, and can go back to the automatic mark. Saved as it is given.
 */
function MarkPanel({ answer, question, frozen, saving, onSave, onNext, showToast }) {
  const shown = answer.marks === null ? '' : String(answer.marks);
  const [draft, setDraft] = useState(shown);
  useEffect(() => { setDraft(shown); }, [shown]);

  const commit = () => {
    if (draft === shown) return true;
    if (draft === '') { setDraft(shown); return true; }
    const marks = Number(draft);
    if (!Number.isFinite(marks) || marks < 0 || marks > answer.maxMarks) {
      showToast(`Give a mark from 0 to ${answer.maxMarks}.`);
      setDraft(shown);
      return false;
    }
    onSave({ marks });
    return true;
  };

  if (frozen) {
    return (
      <div className="review-mark is-frozen">
        <strong>{answer.marks ?? '—'} <span>/ {answer.maxMarks}</span></strong>
        <p><Lock size={13} aria-hidden="true"/>Results frozen - unfreeze them to change marks.</p>
      </div>
    );
  }
  return (
    <div className="review-mark">
      <label className="review-mark-box">
        <span>Marks</span>
        <input className="text-input" type="number" min="0" max={answer.maxMarks} step="any" inputMode="decimal" placeholder="—"
          value={draft} disabled={saving} aria-label={`Marks out of ${answer.maxMarks}`}
          onChange={(event) => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (commit()) onNext(); } }}/>
        <span className="review-mark-of">/ {answer.maxMarks}</span>
      </label>
      <div className="review-mark-quick">
        <button type="button" disabled={saving} className={answer.marks === 0 ? 'is-on' : undefined} onClick={() => onSave({ marks: 0 })}>0</button>
        <button type="button" disabled={saving} className={answer.marks === answer.maxMarks ? 'is-on' : undefined} onClick={() => onSave({ marks: answer.maxMarks })}>Full</button>
      </div>
      {!question.manualGrading && (
        <p className={`review-mark-source${answer.overridden ? ' is-changed' : ''}`}>
          {answer.overridden ? (
            <>Changed by you (automatic: {answer.autoMarks})
              <button className="link-button" type="button" disabled={saving} onClick={() => onSave({ auto: true })}><Undo2 size={13} aria-hidden="true"/>Use automatic</button>
            </>
          ) : 'Marked automatically'}
        </p>
      )}
      {saving && <p className="review-mark-saving">Saving…</p>}
    </div>
  );
}

/**
 * Going through the results one by one: student by student (a paper, question
 * by question) or question by question (one question, student by student - the
 * quick way to mark a short answer across the class). Dots show where each
 * stands and jump straight there; the arrows (and ← →) move one at a time.
 * Any mark can be changed - a right or wrong choice answer's too. The paper
 * on screen has a button to its student's window, on their activity log (`onOpenLog`).
 */
export function ResultReviewModal({ code, startAt = null, startQuestion = null, startMode = 'student', onlyRegistrationId = null, onClose, onChanged, showToast, onOpenLog = null }) {
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState('');
  const [mode, setMode] = useState(startMode);
  const [student, setStudent] = useState(0);
  const [position, setPosition] = useState(0);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [holder, setHolder] = useState(0);
  const [onlyToMark, setOnlyToMark] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api(`/api/admin/tests/${encodeURIComponent(code)}/review`)
      .then((next) => {
        if (!alive) return;
        const scoped = reviewForRegistration(next, onlyRegistrationId);
        setData(scoped);
        if (onlyRegistrationId !== null && onlyRegistrationId !== undefined) {
          setStudent(0); setPosition(0); setQuestionIndex(0); setHolder(0); setOnlyToMark(false);
        }
        const at = startAt !== null && startAt !== undefined ? scoped.papers.findIndex((paper) => paper.registrationId === startAt || String(paper.registrationId ?? paper.id) === String(startAt)) : -1;
        if (at >= 0) {
          setStudent(at);
          // Opened on one answer (a tile in the Analysis rank list): that question on their paper.
          const spot = startQuestion === null || startQuestion === undefined ? -1 : scoped.papers[at].answers.findIndex((answer) => String(answer.questionId) === String(startQuestion));
          if (spot >= 0) setPosition(spot);
        }
        // By question: start on the first question with something still to mark.
        if (startMode === 'question') {
          const first = scoped.questions.findIndex((question) => papersWith(scoped.papers, question.id, true).length);
          if (first >= 0) { setQuestionIndex(first); setOnlyToMark(true); }
        }
      })
      .catch((error) => { if (alive) setFailed(error.message); });
    return () => { alive = false; };
  }, [code, startAt, startQuestion, startMode, onlyRegistrationId]);

  // Also scope before a replacement response arrives: changing the prop can
  // never leave the previous whole-class navigation visible for one render.
  const scoped = useMemo(() => reviewForRegistration(data, onlyRegistrationId), [data, onlyRegistrationId]);
  const papers = scoped?.papers || [];
  const questions = scoped?.questions || [];
  const restricted = onlyRegistrationId !== null && onlyRegistrationId !== undefined;
  const bank = useMemo(() => new Map(questions.map((question) => [question.id, question])), [questions]);
  const frozen = Boolean(data?.test.frozen);
  const question = questions[questionIndex];
  const holders = useMemo(() => (question ? papersWith(papers, question.id, onlyToMark) : []), [papers, question, onlyToMark]);

  // What is on screen: by student, one paper's answer at `position`; by question, `question` on one paper.
  const paper = mode === 'student' ? papers[student] : holders[clamp(holder, holders.length - 1)];
  const answer = mode === 'student' ? paper?.answers[clamp(position, (paper?.answers.length || 1) - 1)] : answerOf(paper, question?.id);
  const shown = answer ? bank.get(answer.questionId) : null;

  const move = useCallback((step) => {
    if (mode === 'student') {
      const count = paper?.answers.length || 0;
      const next = position + step;
      // Past either end of a paper: on to the next student's, or back to the last one's.
      if (next >= 0 && next < count) setPosition(next);
      else if (step > 0 && student < papers.length - 1) { setStudent(student + 1); setPosition(0); }
      else if (step < 0 && student > 0) { setStudent(student - 1); setPosition((papers[student - 1]?.answers.length || 1) - 1); }
    } else {
      const next = holder + step;
      if (next >= 0 && next < holders.length) setHolder(next);
      else if (step > 0 && questionIndex < questions.length - 1) { setQuestionIndex(questionIndex + 1); setHolder(0); }
      else if (step < 0 && questionIndex > 0) { setQuestionIndex(questionIndex - 1); setHolder(0); }
    }
  }, [mode, paper, position, student, papers, holder, holders.length, questionIndex, questions.length]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.target.closest?.('input, textarea, select')) return;
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [move]);

  const save = async (body) => {
    if (!paper || !answer) return;
    setSaving(true);
    try {
      const { paper: updated } = await post(`/api/admin/tests/${encodeURIComponent(code)}/registrations/${encodeURIComponent(paper.registrationId)}/marks`, { questionId: answer.questionId, ...body });
      setData((current) => ({ ...current, papers: current.papers.map((entry) => (entry.registrationId === updated.registrationId ? updated : entry)) }));
      onChanged();
    } catch (error) { showToast(error.message); }
    setSaving(false);
  };

  const switchMode = (next) => {
    if (next === mode) return;
    // Keep what is on screen: the same paper, or the same question.
    if (next === 'question' && shown) { setQuestionIndex(Math.max(0, questions.findIndex((entry) => entry.id === shown.id))); setOnlyToMark(false); setHolder(Math.max(0, papersWith(papers, shown.id).findIndex((entry) => entry.registrationId === paper?.registrationId))); }
    if (next === 'student' && paper) { setStudent(Math.max(0, papers.findIndex((entry) => entry.registrationId === paper.registrationId))); setPosition(Math.max(0, paper.answers.findIndex((entry) => entry.questionId === answer?.questionId))); }
    setMode(next);
  };

  const state = answerState(answer);
  const atStart = mode === 'student' ? student === 0 && position === 0 : questionIndex === 0 && holder === 0;
  const atEnd = mode === 'student'
    ? student === papers.length - 1 && position >= (paper?.answers.length || 1) - 1
    : questionIndex === questions.length - 1 && holder >= holders.length - 1;

  // Reset before paint, so a new question never flashes at the previous
  // answer's scroll position when picked from the strip or Previous/Next.
  const bodyRef = useRef(null);
  useLayoutEffect(() => { bodyRef.current?.scrollTo?.({ top: 0, behavior: 'auto' }); }, [mode, paper?.registrationId, answer?.questionId]);

  // A choice question fits the window without scrolling: one under another
  // where that fits, else its options two across (where the window is wide
  // enough for two). Measured before it is painted, again when the window resizes.
  const shownKey = `${paper?.registrationId}:${answer?.questionId}`;
  const [packed, setPacked] = useState(null);
  const [bodyHeight, setBodyHeight] = useState(0);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setBodyHeight(body.clientHeight));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || packed === shownKey || !body.querySelector('.review-options')) return;
    if (body.scrollHeight > body.clientHeight + 1 && body.clientWidth >= 700) setPacked(shownKey);
  }, [shownKey, packed, bodyHeight]);

  const ready = !failed && Boolean(data) && papers.length > 0;

  // The whole screen: who and where at the top, one answer in the middle (the
  // only part that scrolls), Previous and Next at the bottom.
  return (
    <Modal label="Review results" onClose={onClose} className="review-sheet">
      {/* The student on screen - by question, the one whose answer this is: on to what they did while writing. */}
      {ready && paper && onOpenLog && (
        <SheetSwitch icon={ScrollText} label="Activity log" short="Log" tip={`${paper.name}'s activity log`} who={paper.name} onClick={() => onOpenLog(paper.registrationId, { sapId: paper.sapId, name: paper.name })}/>
      )}
      <div className="review-bar">
        <div className="review-column">
          <header className="review-head">
            <div className="page-heading">
              <h1>Review results</h1>
              <InfoTip label="About reviewing results">
                Go through every handed-in paper student by student, or one question across every student - the quick way to mark a
                short answer. Dots show where each answer stands; the arrows, or ← →, move one at a time. Change any mark: a choice
                answer&apos;s mark you change stays yours, re-marking included, until you go back to the automatic one.
              </InfoTip>
            </div>
            <div className="segmented review-modes" role="radiogroup" aria-label="Review by">
              {[['student', 'By student'], ['question', 'By question']].map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={mode === id} className={mode === id ? 'is-on' : ''} onClick={() => switchMode(id)}>{label}</button>
              ))}
            </div>
          </header>

          {ready && (
            <>
              {/* Who, or which question - and where each answer stands. */}
              <div className="review-nav">
                {mode === 'student' ? (
                  <>
                    <button type="button" className="review-step" disabled={student === 0} onClick={() => { setStudent(student - 1); setPosition(0); }} aria-label="Previous student"><ChevronLeft size={18}/></button>
                    <select className="select" value={student} aria-label="Student" onChange={(event) => { setStudent(Number(event.target.value)); setPosition(0); }}>
                      {papers.map((entry, index) => <option key={entry.registrationId} value={index}>{entry.name}{entry.sapId ? ` · ${entry.sapId}` : ''} · {entry.score}/{entry.totalMarks}</option>)}
                    </select>
                    <button type="button" className="review-step" disabled={student === papers.length - 1} onClick={() => { setStudent(student + 1); setPosition(0); }} aria-label="Next student"><ChevronRight size={18}/></button>
                  </>
                ) : (
                  <>
                    <button type="button" className="review-step" disabled={questionIndex === 0} onClick={() => { setQuestionIndex(questionIndex - 1); setHolder(0); }} aria-label="Previous question"><ChevronLeft size={18}/></button>
                    <select className="select" value={questionIndex} aria-label="Question" onChange={(event) => { setQuestionIndex(Number(event.target.value)); setHolder(0); }}>
                      {questions.map((entry, index) => (
                        <option key={entry.id} value={index}>Q{entry.number} · {TYPE_NAMES[entry.type]} · {clip(oneLine(entry.prompt), 60)}</option>
                      ))}
                    </select>
                    <button type="button" className="review-step" disabled={questionIndex === questions.length - 1} onClick={() => { setQuestionIndex(questionIndex + 1); setHolder(0); }} aria-label="Next question"><ChevronRight size={18}/></button>
                  </>
                )}
              </div>
              <div className="review-strip-head">
                {mode === 'student'
                  ? <span><strong>{paper?.score}</strong> / {paper?.totalMarks} marks{paper?.submittedAt ? ` · handed in ${shortDateTime(paper.submittedAt)}` : ''}</span>
                  : <span>{holders.length} paper{holders.length === 1 ? '' : 's'}{onlyToMark ? ' still to mark' : ''}</span>}
                {mode === 'question' && question?.manualGrading && (
                  <label className="check-row review-only">
                    <input type="checkbox" checked={onlyToMark} onChange={(event) => { setOnlyToMark(event.target.checked); setHolder(0); }}/>
                    Still to mark only
                  </label>
                )}
              </div>
              <div className="review-strip" role="list">
                {mode === 'student'
                  ? paper?.answers.map((entry, index) => (
                    <button key={entry.questionId} type="button" role="listitem" onClick={() => setPosition(index)}
                      className={`review-dot is-${answerState(entry)}${index === position ? ' is-current' : ''}${entry.overridden ? ' is-changed' : ''}`}
                      title={`Question ${entry.position}: ${STATE_WORDS[answerState(entry)]}${entry.marks !== null ? ` (${entry.marks}/${entry.maxMarks})` : ''}`}>
                      {entry.position}
                    </button>
                  ))
                  : holders.map((entry, index) => {
                    const held = answerOf(entry, question.id);
                    return (
                      <button key={entry.registrationId} type="button" role="listitem" onClick={() => setHolder(index)}
                        className={`review-dot is-${answerState(held)}${index === clamp(holder, holders.length - 1) ? ' is-current' : ''}${held?.overridden ? ' is-changed' : ''}`}
                        title={`${entry.name}: ${STATE_WORDS[answerState(held)]}`}>
                        {initialsOf(entry.name)}
                      </button>
                    );
                  })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="review-body" ref={bodyRef} role="region" aria-label="Question and answer" tabIndex={0}>
        <div className="review-column">
          {failed ? <p className="notice danger">{failed}</p> : !data ? <p className="help review-empty">Loading the papers…</p> : !papers.length ? (
            <p className="help review-empty">{restricted ? "This student's submitted paper is not available." : 'No paper has been handed in yet.'}</p>
          ) : !answer || !shown ? (
            <p className="help review-empty">{onlyToMark ? 'Nothing left to mark on this question.' : 'Nothing to show here.'}</p>
          ) : (
            <article className={`review-card is-${state}`}>
              <header className="review-card-head">
                <div>
                  {mode === 'question'
                    ? <strong className="review-who"><span className="person-avatar" aria-hidden="true">{initialsOf(paper.name)}</span><PersonLink email={paper.email} guest={paper.accountType === 'guest'}>{paper.name}</PersonLink>{paper.sapId ? <span>{paper.sapId}</span> : null}</strong>
                    : <strong>Question {answer.position} <span>of {paper.answers.length}</span></strong>}
                  <span className="review-card-meta">{TYPE_NAMES[shown.type]} · out of {shown.maxMarks}{mode === 'question' ? ` · Q${shown.number}` : ''}</span>
                </div>
                <span className={`review-state is-${state}`}>{STATE_WORDS[state]}{answer.overridden ? ' · changed' : ''}</span>
              </header>
              <RichText className="review-prompt" text={shown.prompt}/>
              {shown.image && <QuestionImage image={shown.image} label="Picture for this question" compact/>}
              <AnswerBody question={shown} answer={answer} packed={packed === shownKey}/>
              {/* Held on the student's device by a lost connection, and taken after its time: theirs to judge. */}
              {answer.late && (
                <p className="notice review-late">
                  <span>Arrived late — made {toTheSecond(answer.late.madeAt)}, received {toTheSecond(answer.late.arrivedAt)}</span>
                  <InfoTip label="About late answers">
                    Made on the student's device before its time ran out (by the device's clock) and held there by a lost connection,
                    then sent once it was back. Check it against the offline periods in their activity log.
                  </InfoTip>
                </p>
              )}
              <MarkPanel key={`${paper.registrationId}:${answer.questionId}`} answer={answer} question={shown} frozen={frozen} saving={saving}
                onSave={save} onNext={() => move(1)} showToast={showToast}/>
            </article>
          )}
        </div>
      </div>

      {ready && (
        <footer className="review-foot">
          <div className="review-column">
            <button type="button" className="button button-secondary" disabled={atStart} onClick={() => move(-1)}><ChevronLeft size={16} aria-hidden="true"/>Previous</button>
            <span className="review-count">
              {mode === 'student'
                ? <><span className="review-count-noun">Student </span>{student + 1} of {papers.length}</>
                : `${clamp(holder, holders.length - 1) + (holders.length ? 1 : 0)} of ${holders.length}`}
            </span>
            <button type="button" className="button button-primary" disabled={atEnd} onClick={() => move(1)}>Next<ChevronRight size={16} aria-hidden="true"/></button>
          </div>
        </footer>
      )}
    </Modal>
  );
}
