import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ, BarChart3, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, ClipboardPaste, Clock, FileCheck2, Hash, History, Lock, LogOut,
  PenLine, RotateCw, ShieldCheck, TrendingDown, TrendingUp, X
} from 'lucide-react';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { applyFilters, sortBy } from '../../lib/filters.js';
import { RichText } from '../../components/RichText.jsx';
import { useAutoHideScrollbar } from '../../lib/useAutoHideScrollbar.js';
import { ANSWER_FILTER_LIMITS, encodeAnswerFilters, evaluateAnswerFilters } from './answer-filters.js';
import { ANSWER_ANALYSIS_OUTCOMES, answerAnalysisOf, answerConditionOf, answerOutcomePatch, updateAnswerCondition } from './answer-analysis.js';
import { flagsOf, scorePaper } from './analysis-compute.js';
import { TYPE_WORD, marksText } from './TestOverview.jsx';

const PAGE_SIZE = 50;
const SCORE_KEY = 'answer-analysis-score';
// Whether each student's score is shown: on unless this browser turned it off, kept between visits.
const scoreShown = () => { try { return window.localStorage.getItem(SCORE_KEY) !== 'off'; } catch { return true; } };
const keepScoreShown = (on) => { try { window.localStorage.setItem(SCORE_KEY, on ? 'on' : 'off'); } catch { /* storage may be blocked */ } };
// Sort & filter the students, as the rank list does: marks against the class average, whether the whole paper
// is marked, and what was recorded while it was written; in order of marks, name, SAP ID or time taken.
const MARKING_GROUP = { id: 'paper', title: 'Marking', options: [
  { id: 'paper:done', label: 'Fully marked', test: (row) => !row.score?.pending },
  { id: 'paper:pending', label: 'Still to mark', test: (row) => Boolean(row.score?.pending) }
] };
const FLAG_GROUP = { id: 'flag', title: 'While writing', options: [
  { id: 'flag:left', label: 'Left the page', test: (row) => row.flags.includes('left') },
  { id: 'flag:locked', label: 'Locked', test: (row) => row.flags.includes('locked') },
  { id: 'flag:copy', label: 'Copy or paste', test: (row) => row.flags.includes('copy') },
  { id: 'flag:none', label: 'Nothing flagged', test: (row) => row.flags.includes('none') }
] };
const FILTER_ICONS = {
  'avg:above': { icon: TrendingUp, tone: 'ok' }, 'avg:below': { icon: TrendingDown, tone: 'warn' },
  'paper:done': { icon: CheckCheck, tone: 'ok' }, 'paper:pending': { icon: PenLine, tone: 'warn' },
  'flag:left': { icon: LogOut, tone: 'warn' }, 'flag:locked': { icon: Lock, tone: 'bad' },
  'flag:copy': { icon: ClipboardPaste, tone: 'warn' }, 'flag:none': { icon: ShieldCheck, tone: 'ok' }
};
const STUDENT_SORTS = [
  { id: 'marks', label: 'Marks', icon: BarChart3, directions: [{ id: 'desc', label: 'Highest first' }, { id: 'asc', label: 'Lowest first' }] },
  { id: 'name', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'sap', label: 'SAP ID', icon: Hash, directions: [{ id: 'asc', label: 'Lowest first' }, { id: 'desc', label: 'Highest first' }] },
  { id: 'time', label: 'Time taken', icon: Clock, directions: [{ id: 'asc', label: 'Fastest first' }, { id: 'desc', label: 'Slowest first' }] }
];
const SORT_FIELDS = {
  marks: (row) => row.score?.percent ?? null,
  name: (row) => String(row.student.name || '').toLocaleLowerCase(),
  sap: (row) => row.student.sapId || '',
  time: (row) => row.student.seconds ?? null
};
const EMPTY = { mode: 'all', questions: [] };
const questionText = (question) => String(question?.prompt || 'Picture question').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
const percentText = (value) => value === null || value === undefined ? '' : `${value}%`;
const optionLetter = (index) => {
  let number = Number(index) + 1;
  let text = '';
  while (number > 0) { number -= 1; text = String.fromCharCode(65 + number % 26) + text; number = Math.floor(number / 26); }
  return text;
};
const questionNumber = (question, questions) => question?.number ?? questions.findIndex((entry) => String(entry.id) === String(question?.id)) + 1;
// MCQ (one correct answer), MSQ (several) or Short (written), as the rest of the app names them.
const typeKey = (question) => (question?.type === 'short' || question?.manualGrading ? 'short' : question?.type === 'msq' || question?.type === 'mcq' ? question.type : null);
const typeOf = (question) => TYPE_WORD[typeKey(question)] || '';
const TYPE_SPOKEN = { mcq: 'one correct answer', msq: 'several correct answers', short: 'a written answer' };
const labelOf = (state) => ANSWER_ANALYSIS_OUTCOMES.find((entry) => entry.id === state)?.label || 'Unavailable';
const toneOf = (state) => ANSWER_ANALYSIS_OUTCOMES.find((entry) => entry.id === state)?.tone || 'absent';
const listed = (items, word) => items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} ${word} ${items[items.length - 1]}`;
const initialQuestion = (questions, value) => {
  const wanted = typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('aq');
  const ruled = value.questions.some((entry) => entry.id === wanted) ? wanted : value.questions[0]?.id;
  return String(questions.find((question) => String(question.id) === (ruled ?? wanted))?.id ?? questions[0]?.id ?? '');
};
/** The options chosen on a question and how a paper must match them. "Exactly"
 * is every option ruled: the chosen ones picked and every other one not. */
function choiceOf(condition, count) {
  const rules = Object.entries(condition.options);
  const chosen = rules.filter(([, rule]) => rule === 'selected').map(([at]) => Number(at));
  const not = rules.filter(([, rule]) => rule === 'not-selected').map(([at]) => Number(at));
  const exact = count > 0 && chosen.length > 0 && chosen.length + not.length === count && condition.optionMatch === 'all';
  return { chosen: new Set(chosen), not: new Set(exact ? [] : not), match: exact ? 'exact' : condition.optionMatch === 'any' ? 'any' : 'all' };
}
function optionsFor(chosen, match, count) {
  if (!chosen.size) return { options: {}, optionMatch: 'all' };
  if (match === 'exact') return { options: Object.fromEntries(Array.from({ length: count }, (_, at) => [at, chosen.has(at) ? 'selected' : 'not-selected'])), optionMatch: 'all' };
  return { options: Object.fromEntries([...chosen].map((at) => [at, 'selected'])), optionMatch: match };
}
// The words for one option chosen, and for several.
const MATCHES = { exact: ['Only', 'Exactly'], all: ['At least', 'All of'], any: [null, 'Any of'] };

/** A paper's marks over the whole test; with answers still to mark, the most they could still add. */
function ScoreCell({ score }) {
  if (!score) return <span className="aa-score">—</span>;
  return <span className="aa-score" data-tip={score.percent === null ? undefined : `${Math.round(score.percent)}% so far`}>
    <strong>{marksText(score.secured)}<small>/{marksText(score.max)}</small></strong>
    {score.pending && <em>+ up to {marksText(score.pendingMax)} to mark</em>}
  </span>;
}

/**
 * The question on the left - its prompt, and its options to choose; on the right
 * the students who picked what is chosen (exactly these, all of these or any of
 * these), at once. It opens with the correct options chosen, exactly: the
 * students who got it right. That opening view filters nothing else - the charts
 * and Results stay whole until a choice is made. Observational only: the answer
 * key and the marks are never edited here.
 */
export function AnswerAnalysisView({ questions = [], students = [], answers, search = '', onReview, onLog, onMatching }) {
  const [selectedId, setSelectedId] = useState(() => initialQuestion(questions, answers.value));
  // Nothing chosen on arrival: the correct answer is shown without filtering anything else.
  const [preset, setPreset] = useState(() => !answers.value.questions.length && !answers.addressError);
  const [changeError, setChangeError] = useState('');
  const [page, setPage] = useState(1);
  // A long question is folded to a few lines; More shows it all (and its picture full size).
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const [showScore, setShowScore] = useState(scoreShown);
  // The list's own filters and order (not the shared answer filter): ticked option ids and 'field-direction'.
  const [ticked, setTicked] = useState([]);
  const [sort, setSort] = useState('marks-desc');
  const promptRef = useRef(null);
  const controlsId = useId();
  const questionScroll = useAutoHideScrollbar();
  const studentScroll = useAutoHideScrollbar();
  const listTop = useRef(null);
  const selected = questions.find((question) => String(question.id) === selectedId) || questions[0];
  const id = String(selected?.id ?? '');
  const index = questions.findIndex((question) => String(question.id) === id);
  const number = questionNumber(selected, questions);
  const detail = answers.details[id];
  const detailError = answers.errors[id];
  const shownQuestion = detail?.question || selected;
  const choiceQuestion = shownQuestion && shownQuestion.type !== 'short' && !shownQuestion.manualGrading && shownQuestion.options?.length > 0;
  const detailState = detail || (detailError ? { error: detailError } : { loading: true });
  const baseline = useMemo(() => answerAnalysisOf({ question: selected, detail: detailState, students }), [selected, detail, detailError, students]);
  const count = choiceQuestion && baseline.status === 'ready' ? baseline.options.length : 0;
  const keys = useMemo(() => new Set((count ? baseline.options : []).filter((option) => option.correct).map((option) => option.index)), [baseline, count]);
  const presetValue = useMemo(() => (keys.size ? { mode: 'all', questions: [{ id, states: [], ...optionsFor(keys, 'exact', count) }] } : EMPTY), [id, keys, count]);
  const shownValue = preset ? presetValue : answers.value;
  const condition = useMemo(() => answerConditionOf(shownValue, id), [shownValue, id]);
  const choice = useMemo(() => choiceOf(condition, count), [condition, count]);
  const others = shownValue.questions.filter((entry) => entry.id !== id);
  // The opening view is worked out here; anything chosen is the shared filter the rest of Analysis uses.
  const presetResult = useMemo(() => {
    if (!preset) return null;
    if (detailError) return { active: true, status: 'error', ids: null, pending: [], errors: [{ id, message: detailError }] };
    if (!presetValue.questions.length) return { active: false, status: 'idle', ids: null, pending: [], errors: [] };
    return { ...evaluateAnswerFilters(presetValue, students, answers.details), active: true };
  }, [preset, id, detailError, presetValue, students, answers.details]);
  const result = presetResult || answers.result;
  const matches = useMemo(() => answerAnalysisOf({ question: selected, detail: detailState, students, filterResult: result, search }),
    [selected, detail, detailError, students, result, search]);
  const encoded = useMemo(() => { try { return encodeAnswerFilters(shownValue, questions); } catch { return ''; } }, [shownValue, questions]);
  const ready = matches.status === 'ready';
  // Each paper's score over the whole test, as the rank list counts it: marks so far, what is still to mark.
  const columns = useMemo(() => questions.map((_, at) => at), [questions]);
  const scores = useMemo(() => new Map(students.map((student) => [String(student.id), scorePaper(student, questions, columns)])), [students, questions, columns]);
  const anyPending = useMemo(() => [...scores.values()].some((score) => score.pending), [scores]);
  // The class average over fully marked papers, as the rank list works it out.
  const average = useMemo(() => {
    const done = [...scores.values()].filter((score) => !score.pending && score.percent !== null);
    return done.length ? done.reduce((sum, score) => sum + score.percent, 0) / done.length : null;
  }, [scores]);
  const groups = useMemo(() => [
    { id: 'avg', title: `Class average${average === null ? '' : ` · ${percentText(Math.round(average * 10) / 10)}`}`, options: [
      { id: 'avg:above', label: 'At or above average', test: (row) => average !== null && !row.score?.pending && row.score?.percent !== null && row.score.percent >= average - 1e-9 },
      { id: 'avg:below', label: 'Below average', test: (row) => average !== null && !row.score?.pending && row.score?.percent !== null && row.score.percent < average - 1e-9 }
    ] },
    ...(anyPending ? [MARKING_GROUP] : []),
    FLAG_GROUP
  ], [average, anyPending]);
  const listRows = useMemo(() => (matches.rows || []).map((row) => ({ ...row, score: scores.get(String(row.student.id)), flags: flagsOf(row.student) })), [matches.rows, scores]);
  const rows = useMemo(() => sortBy(applyFilters(listRows, groups, ticked), sort, SORT_FIELDS), [listRows, groups, ticked, sort]);
  const shown = rows.length;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  const shownRows = rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const isKey = keys.size > 0 && choice.match === 'exact' && keys.size === choice.chosen.size && [...keys].every((at) => choice.chosen.has(at));
  const isCorrect = choiceQuestion ? isKey && !condition.states.length : condition.states.length === 1 && condition.states[0] === 'O';
  const isIncorrect = !Object.keys(condition.options).length && condition.states.length === 1 && condition.states[0] === 'W';
  const isAll = !Object.keys(condition.options).length && !condition.states.length;
  const matchedPercent = students.length && ready ? Math.round(shown / students.length * 1000) / 10 : null;
  const summary = [
    matchedPercent !== null && shown !== students.length && `${percentText(matchedPercent)} of ${students.length}`,
    search.trim() && `search “${search.trim()}”`
].filter(Boolean).join(' · ');
  const answerOf = (state, picks) => state === 'N' ? 'Not on paper' : state === 'B' ? 'No answer'
    : !choiceQuestion ? 'Written answer' : picks?.length ? `Picked ${picks.map(optionLetter).join(', ')}` : 'No option picked';

  // This question's answers, then the ones either side, so the arrows change at once.
  useEffect(() => {
    if (id && !detail && !detailError && !answers.loadingIds.has(id)) void answers.load(id);
  }, [id, detail, detailError, answers.load, answers.loadingIds]);
  useEffect(() => {
    if (!detail) return;
    for (const near of [questions[index + 1], questions[index - 1]]) {
      const nearId = near && String(near.id);
      if (nearId && !answers.details[nearId] && !answers.errors[nearId] && !answers.loadingIds.has(nearId)) void answers.load(nearId);
    }
  }, [detail, index, questions, answers.details, answers.errors, answers.loadingIds, answers.load]);
  useEffect(() => {
    if (!id) return;
    const address = new URL(window.location.href);
    address.searchParams.set('aq', id);
    if (address.href !== window.location.href) window.history.replaceState(window.history.state, '', address);
  }, [id]);
  useEffect(() => { setPage(1); }, [id, encoded, search, ticked, sort]);
  useEffect(() => { setExpanded(false); }, [id]);
  // Folded, the question says whether it runs past its lines (or has a picture to see full size).
  useLayoutEffect(() => {
    const element = promptRef.current;
    if (!element || expanded) return undefined;
    const check = () => setLong(element.scrollHeight > element.clientHeight + 1 || Boolean(shownQuestion?.image));
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, shownQuestion?.prompt, shownQuestion?.image, expanded]);

  const apply = (next) => {
    setChangeError('');
    try { answers.apply(next); setPreset(false); }
    catch (error) { setChangeError(error.message || 'This choice could not be applied. Please try again.'); }
  };
  // This question's choice changes; nothing else does.
  const update = (patch) => {
    if (!shownValue.questions.some((entry) => entry.id === id) && shownValue.questions.length >= ANSWER_FILTER_LIMITS.questions) {
      setChangeError(`Use up to ${ANSWER_FILTER_LIMITS.questions} questions at a time. Remove one to add another.`);
      return;
    }
    let next;
    try { next = updateAnswerCondition(shownValue, id, patch, questions); }
    catch (error) { setChangeError(error.message || 'This choice could not be applied.'); return; }
    apply(next);
  };
  // An older link's "not picked" rules stay as they are until pressed; exactly rules every option itself.
  const choose = (chosen, match) => {
    const built = optionsFor(chosen, match, count);
    const kept = match === 'exact' ? {} : Object.fromEntries([...choice.not].filter((at) => !chosen.has(at)).map((at) => [at, 'not-selected']));
    update({ options: { ...kept, ...built.options }, optionMatch: built.optionMatch });
  };
  const toggleOption = (at) => {
    if (choice.not.has(at)) { const options = { ...condition.options }; delete options[at]; update({ options }); return; }
    const chosen = new Set(choice.chosen);
    if (chosen.has(at)) chosen.delete(at); else chosen.add(at);
    // A first option chosen from nothing: who picked it (and maybe others).
    choose(chosen, choice.chosen.size ? choice.match : 'all');
  };
  // Options belong to their own question: the next one opens on its correct answer.
  const openQuestion = (nextId) => {
    nextId = String(nextId);
    setChangeError('');
    setSelectedId(nextId);
    if (preset || nextId === id) return;
    const rest = answers.value.questions.filter((entry) => entry.id !== id);
    if (rest.length) apply({ ...answers.value, questions: rest });
    else { answers.clear(); setPreset(true); }
  };
  const removeOther = (questionId) => {
    let next;
    try { next = updateAnswerCondition(answers.value, questionId, { states: [], options: {} }, questions); }
    catch (error) { setChangeError(error.message || 'This choice could not be removed.'); return; }
    apply(next);
  };
  const reset = () => { setChangeError(''); answers.clear(); setPreset(true); };
  const retry = () => {
    const ids = new Set([id, ...(result.pending || []), ...(result.errors || []).map((entry) => entry.id)].filter(Boolean));
    for (const questionId of ids) void answers.load(questionId, { force: true });
  };
  const turnPage = (next) => { setPage(next); listTop.current?.scrollTo?.({ top: 0 }); };
  const toggleScore = () => setShowScore((on) => { keepScoreShown(!on); return !on; });

  if (!selected) return <section className="card answer-analysis-empty"><h2>Answer analysis</h2><p>No questions are available.</p></section>;

  return <section className="answer-analysis" aria-label="Answer analysis">
    {changeError && <p className="aa-error" role="alert">{changeError}</p>}

    <div className="aa-body">
      <section className="aa-question" aria-labelledby={`${controlsId}-question-head`}>
        {/* Fixed at the top of the panel: which question (arrows, or the list under its name), Correct | All, how a
            paper must match, and the question itself - folded to a few lines when long, More to read it all. */}
        <div className={`aa-qtop${expanded ? ' is-expanded' : ''}`}>
          <div className="aa-head">
            <div className="aa-nav">
              <button type="button" className="aa-arrow" disabled={index <= 0} onClick={() => openQuestion(questions[index - 1].id)} aria-label="Previous question"><ChevronLeft size={16} aria-hidden="true"/></button>
              <h2 className="aa-pick" id={`${controlsId}-question-head`}>
                <span aria-hidden="true">Question {number}</span>
                {typeOf(shownQuestion) && <span className="aa-type" aria-hidden="true">{typeOf(shownQuestion)}</span>}
                <ChevronDown size={15} aria-hidden="true"/>
                <select value={id} onChange={(event) => openQuestion(event.target.value)}
                  aria-label={`Question ${number} of ${questions.length}${typeOf(shownQuestion) ? `, ${TYPE_SPOKEN[typeKey(shownQuestion)]}` : ''}. Choose another question`}>
                  {questions.map((question) => <option key={question.id} value={String(question.id)}>Q{questionNumber(question, questions)}{typeOf(question) ? ` · ${typeOf(question)}` : ''} · {questionText(question).slice(0, 100)}</option>)}
                </select>
              </h2>
              <button type="button" className="aa-arrow" disabled={index < 0 || index >= questions.length - 1} onClick={() => openQuestion(questions[index + 1].id)} aria-label="Next question"><ChevronRight size={16} aria-hidden="true"/></button>
            </div>
            {detail && <span className="aa-seg" role="group" aria-label="Show">
              <button type="button" aria-pressed={isCorrect} onClick={() => update(answerOutcomePatch(shownQuestion, 'correct'))}
                data-tip={choiceQuestion ? 'Who picked exactly the correct options' : 'Answers recorded as correct'}>Correct</button>
              <button type="button" aria-pressed={isIncorrect} onClick={() => update(answerOutcomePatch(shownQuestion, 'incorrect'))}
                data-tip="Answers recorded as incorrect">Incorrect</button>
              <button type="button" aria-pressed={isAll} onClick={() => update(answerOutcomePatch(shownQuestion, 'all'))}
                data-tip="Every submitted student, whatever they picked">All</button>
            </span>}
          </div>
          {/* Once options are chosen: how a paper must match them, one joined switch. */}
          {detail && choiceQuestion && choice.chosen.size > 0 && <div className="aa-bar">
            <span className="aa-bar-label" aria-hidden="true">Picked</span>
            <span className="aa-seg" role="group" aria-label="Students who picked">
              {Object.entries(MATCHES).filter(([, words]) => words[choice.chosen.size === 1 ? 0 : 1]).map(([value, words]) => (
                <button key={value} type="button" aria-pressed={choice.match === value} onClick={() => choose(choice.chosen, value)}>{words[choice.chosen.size === 1 ? 0 : 1]}</button>
              ))}
            </span>
          </div>}
          <div className={`aa-prompt${expanded ? '' : ' is-folded'}${long && !expanded ? ' is-long' : ''}`} id={`${controlsId}-prompt`} ref={promptRef}>
            <RichText text={shownQuestion?.prompt || 'Picture question'}/>
          </div>
          {shownQuestion?.image && <img className={`aa-image${expanded ? '' : ' is-small'}`} src={shownQuestion.image.url} alt={`Picture for question ${number}`} width={shownQuestion.image.width} height={shownQuestion.image.height}/>}
          {(long || expanded) && <button type="button" className="aa-more" aria-expanded={expanded} aria-controls={`${controlsId}-prompt`} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Less' : 'More'}</button>}
        </div>

        <div className="aa-qlist auto-hide-scrollbar" {...questionScroll}>
          {detailError ? <div className="aa-message is-error" role="alert"><p>{detailError}</p>
            <button type="button" className="button button-secondary button-small" onClick={() => void answers.load(id, { force: true })}><RotateCw size={15} aria-hidden="true"/>Try again</button></div>
            : !detail ? <p className="aa-message" role="status">Loading answers…</p>
              : !choiceQuestion ? <p className="aa-hint">Written answers: choose Correct, Incorrect or All above.</p>
                : <fieldset className="aa-options">
                  <legend className="sr-only">Options</legend>
                  <ul role="list">
                    {(baseline.options || []).map((option) => {
                      const on = choice.chosen.has(option.index);
                      const not = choice.not.has(option.index);
                      return <li key={option.index}><label className={`aa-option${on ? ' is-ticked' : ''}${not ? ' is-not' : ''}`}>
                        <input className="sr-only" type="checkbox" checked={on} onChange={() => toggleOption(option.index)}/>
                        <span className={`aa-letter${option.correct ? ' is-key' : ''}`} data-tip={option.correct ? 'Correct answer' : undefined}><span className="sr-only">Option </span>{optionLetter(option.index)}{option.correct && <span className="sr-only"> (correct answer)</span>}</span>
                        <span className="aa-option-text"><RichText text={option.text}/>
                          {not && <span className="aa-not">Not picked</span>}
                        </span>
                        <span className="aa-figure"><strong>{option.count}</strong><span className="sr-only"> picked it,</span> <span>{percentText(option.percent)}</span></span>
                      </label></li>;
                    })}
                  </ul>
                </fieldset>}
        </div>
      </section>

      <section className="aa-students" aria-labelledby={`${controlsId}-students`} aria-busy={!ready}>
        <h2 className="sr-only" id={`${controlsId}-students`}>Students</h2>
        <div className="aa-summary">
          <p role="status" aria-live="polite" aria-atomic="true">
            {ready ? <><strong>{shown} {shown === 1 ? 'student' : 'students'}</strong>{summary && ` · ${summary}`}</> : matches.status === 'error' ? 'Answers unavailable' : 'Finding students…'}
          </p>
          <div className="aa-tools">
            <FilterMenu groups={groups} rows={listRows} selected={ticked} onChange={setTicked} icons={FILTER_ICONS}
              title="Sort & filter the students" allLabel="Everyone" total={listRows.length} shown={shown}
              sorts={STUDENT_SORTS} sort={sort} onSort={setSort} autoHideScrollbar/>
            <button type="button" className="aa-toggle" role="switch" aria-checked={showScore} onClick={toggleScore} data-tip="Each student's marks for the whole test">
              <span className="aa-toggle-track" aria-hidden="true"/>Score
            </button>
            {onMatching && <button type="button" className="aa-link" disabled={!ready || !shown} onClick={() => onMatching('responses', encoded, { search })}
              data-tip={ticked.length ? 'Open the answer matches in Results; student-list filters stay here' : 'These answer matches on the Results tab'}><FileCheck2 size={15} aria-hidden="true"/>Open in Results</button>}
          </div>
        </div>
        {(others.length > 0 || condition.states.length > 0) && <div className="aa-others" aria-label="Also matching">
          {condition.states.length > 0 && <span className="aa-other">
            <span>Only {listed(condition.states.map(labelOf), 'or')}</span>
            <button type="button" onClick={() => update({ states: [] })} aria-label={`Show every outcome, not only ${listed(condition.states.map(labelOf), 'or')}`}><X size={14} aria-hidden="true"/></button>
          </span>}
          {others.map((entry) => {
            const question = questions.find((item) => String(item.id) === entry.id);
            const count = Object.keys(entry.options).length;
            return <span className="aa-other" key={entry.id}>
              <span>Also Q{questionNumber(question, questions)}: {[entry.states.map(labelOf).join(' or '), count ? `${count} option ${count === 1 ? 'rule' : 'rules'}` : ''].filter(Boolean).join(' · ')}</span>
              <button type="button" onClick={() => removeOther(entry.id)} aria-label={`Remove the choice on question ${questionNumber(question, questions)}`}><X size={14} aria-hidden="true"/></button>
            </span>;
          })}
        </div>}

        {!ready ? <div className={`aa-message${matches.status === 'error' ? ' is-error' : ''}`} role={matches.status === 'error' ? 'alert' : 'status'}>
          <p>{matches.status === 'error' ? (matches.errors || []).map((error) => error.message || error).filter(Boolean).join(' ') || 'Answers could not be loaded.' : 'Loading answers…'}</p>
          {matches.status === 'error' && !answers.addressError && <button className="button button-secondary button-small" type="button" onClick={retry}><RotateCw size={15} aria-hidden="true"/>Try again</button>}
          {answers.addressError && <button className="button button-secondary button-small" type="button" onClick={reset}>Clear</button>}
        </div> : !shown ? <div className="aa-message"><p>No student {search.trim() ? 'matches this and the search' : ticked.length && matches.shown ? 'matches these filters' : 'picked this'}.</p></div>
          : <div className="aa-student-scroll auto-hide-scrollbar" role="region" aria-label="Matching students" tabIndex={0} ref={listTop} {...studentScroll}>
            <ul className={`aa-student-list${showScore ? ' has-score' : ''}`} role="list">
              {shownRows.map(({ student, state, picks, score }) => <li key={student.id}>
                <div className="aa-person">
                  <button className="aa-name" type="button" onClick={() => onReview?.(student.id, selected.id)} data-tip="Review this answer">{student.name || 'Student'}</button>
                  <span>{student.sapId || student.email || 'No SAP ID'}</span>
                </div>
                <div className="aa-answer"><span className={`answer-analysis-state is-${toneOf(state)}`}>{labelOf(state)}</span><span>{answerOf(state, picks)}</span></div>
                {showScore && <ScoreCell score={score}/>}
                {onLog && <button type="button" className="aa-icon" onClick={() => onLog(student.id, { name: student.name, sapId: student.sapId })} aria-label={`Open ${student.name || 'student'}’s activity log`} data-tip="Activity log"><History size={16} aria-hidden="true"/></button>}
              </li>)}
            </ul>
          </div>}
        {ready && shown > PAGE_SIZE && <footer className="aa-pages"><span>{(currentPage - 1) * PAGE_SIZE + 1}–{Math.min(currentPage * PAGE_SIZE, shown)} of {shown}</span><div>
          <button className="aa-arrow" type="button" disabled={currentPage <= 1} onClick={() => turnPage(currentPage - 1)} aria-label="Previous students"><ChevronLeft size={16} aria-hidden="true"/></button>
          <button className="aa-arrow" type="button" disabled={currentPage >= pages} onClick={() => turnPage(currentPage + 1)} aria-label="Next students"><ChevronRight size={16} aria-hidden="true"/></button>
        </div></footer>}
      </section>
    </div>
  </section>;
}
