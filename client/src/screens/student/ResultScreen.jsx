import { useState } from 'react';
import { AlignLeft, Check, CircleDot, Download, ListChecks, Minus, PenLine, X } from 'lucide-react';
import { downloadMyResponses } from '../../lib/api.js';
import { useCached } from '../../lib/cache.js';
import { DownloadQuestion } from './DownloadQuestion.jsx';
import { clockTime, dateTime } from '../../lib/format.js';
import { RichText } from '../../components/RichText.jsx';
import { QuestionImage } from '../../components/QuestionImage.jsx';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { applyFilters } from '../../lib/filters.js';
import { Skeleton } from '../../components/Skeleton.jsx';
import { ClassComparison } from './ClassComparison.jsx';

/**
 * The Excel of their answers, as a round green button. Offered once the test
 * is closed and marks are released; unmarked short answers show as ungraded.
 */
export function DownloadResponses({ result }) {
  const [state, setState] = useState('');
  const [asking, setAsking] = useState(false);
  if (!result.canDownload) return null;
  const download = async () => {
    setAsking(false);
    setState('busy');
    try { await downloadMyResponses(result.code); setState(''); } catch (error) { setState(error.message); }
  };
  const label = result.pendingManual ? 'Download my answers as Excel (short answers not marked yet)' : 'Download my answers as Excel';
  return (
    <span className="result-download">
      <button className="download-round" type="button" disabled={state === 'busy'} onClick={() => setAsking(true)} aria-label={label} title={label}>
        <Download size={19} aria-hidden="true"/>
      </button>
      {asking && <DownloadQuestion result={result} onConfirm={download} onCancel={() => setAsking(false)}/>}
      {state && state !== 'busy' && <span className="help" role="alert">{state}</span>}
    </span>
  );
}

/** Why the paper was handed in, when it was not the student's own Submit. */
function HowSubmitted({ result }) {
  if (result.submittedBy === 'time') {
    // Each student's own time: theirs ran out, not the test's.
    const when = result.ownTime && result.deadlineAt ? `Your time was up at ${clockTime(result.deadlineAt)}` : "Time's up";
    return <p className="notice">⏱ {when} — your answers were submitted automatically ({result.answeredQuestionCount} of {result.totalQuestions} answered).</p>;
  }
  if (result.submittedBy === 'admin') {
    return <p className="notice">Your instructor closed the test, so your answers were submitted as they stood ({result.answeredQuestionCount} of {result.totalQuestions} answered).</p>;
  }
  if (result.submittedBy === 'teacher') {
    return <p className="notice">Your instructor handed in your paper, with your answers as they stood ({result.answeredQuestionCount} of {result.totalQuestions} answered).</p>;
  }
  return null;
}

function IntegrityLine({ result }) {
  if (!result.timesLeft && !result.timesLocked) return <p className="help">You stayed on the test the whole time.</p>;
  return (
    <p className="help">
      You left the test {result.timesLeft} time{result.timesLeft === 1 ? '' : 's'}
      {result.timesLocked ? ` and were locked ${result.timesLocked} time${result.timesLocked === 1 ? '' : 's'}` : ''}.
      Your administrator can see this.
    </p>
  );
}

/** Where one answer stands, for its colour and its sign. */
const standingOf = (answer) => (answer.marks === null ? 'pending'
  : !answer.answered ? 'blank'
    : answer.isCorrect ? 'right'
      : answer.partial ? 'part' : 'wrong');
const SIGNS = { right: Check, part: Minus, wrong: X, blank: Minus, pending: PenLine };
/** The question types, short for the filter and the tag on each question, in full on hover. */
const TYPES = [['mcq', 'MCQ', 'Single choice'], ['msq', 'MSQ', 'Multiple choice'], ['short', 'Short', 'Short answer']];
const TYPE_NAMES = Object.fromEntries(TYPES.map(([id, short, name]) => [id, { short, name }]));
const typeOf = (answer) => (TYPE_NAMES[answer.type] ? answer.type : 'mcq');
const round = (value) => Math.round(value * 100) / 100;

/**
 * How each kind of question went - MCQ, MSQ and short answers - when a paper
 * has more than one kind: marks out of the most, how many right, and how many
 * are still to be marked.
 */
export function TypeBreakdown({ answers }) {
  const rows = TYPES.map(([id, short, name]) => {
    const list = answers.filter((answer) => typeOf(answer) === id);
    const marked = list.filter((answer) => answer.marks !== null);
    return {
      id, short, name,
      total: list.length,
      marked: marked.length,
      right: marked.filter((answer) => answer.isCorrect).length,
      unmarked: list.length - marked.length,
      earned: round(marked.reduce((sum, answer) => sum + (Number(answer.marks) || 0), 0)),
      max: round(list.reduce((sum, answer) => sum + (Number(answer.maxMarks) || 0), 0))
    };
  }).filter((row) => row.total > 0);
  if (rows.length < 2) return null;
  return (
    <section className="result-types" aria-label="By question type">
      <h2>By question type</h2>
      <ul>
        {rows.map((row) => (
          <li key={row.id}>
            <span className="result-types-name" title={row.name}>{row.short}</span>
            <span className="result-types-bar" aria-hidden="true"><span style={{ width: `${row.max ? Math.min(100, (row.earned / row.max) * 100) : 0}%` }}/></span>
            <strong className="result-types-marks">{row.marked ? row.earned : '–'}<small>/{row.max}</small></strong>
            <small className="result-types-detail">
              {row.marked ? `${row.right} of ${row.total} right${row.unmarked ? ` · ${row.unmarked} unmarked` : ''}` : 'Not marked yet'}
            </small>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Their marked paper, for the page: the summary beside it and the answers
 * both use it. Shown at once when it was fetched before - opened earlier, or
 * fetched ahead from My results - and asked again behind (lib/cache.js).
 */
export function useMyResponses(code, enabled = true) {
  const { data, error } = useCached(enabled ? `/api/me/results/${encodeURIComponent(code)}/responses` : null);
  return { data: data || null, failed: data ? '' : error?.message || '' };
}

/**
 * The answer filter - the same Filter button as the rest of the portal: how it
 * went (anything short of full marks is Wrong) and, when a paper mixes them,
 * the kind of question. Ticks in one group are alternatives; the two groups
 * narrow each other. On a phone it opens as a sheet from the bottom.
 */
const RESULT_GROUP = {
  id: 'result',
  title: 'Result',
  options: [
    { id: 'right', label: 'Right', test: (answer) => answer.standing === 'right' },
    { id: 'wrong', label: 'Wrong', test: (answer) => ['wrong', 'part', 'blank'].includes(answer.standing) },
    { id: 'pending', label: 'Unmarked', rare: true, test: (answer) => answer.standing === 'pending' }
  ]
};
const TYPE_GROUP = {
  id: 'type',
  title: 'Question type',
  options: [
    { id: 'type:mcq', label: 'MCQ · single choice', rare: true, test: (answer) => answer.kind === 'mcq' },
    { id: 'type:msq', label: 'MSQ · multiple choice', rare: true, test: (answer) => answer.kind === 'msq' },
    { id: 'type:short', label: 'Short answer', rare: true, test: (answer) => answer.kind === 'short' }
  ]
};
const FILTER_ICONS = {
  right: { icon: Check, tone: 'ok' },
  wrong: { icon: X, tone: 'bad' },
  pending: { icon: PenLine, tone: 'warn' },
  'type:mcq': { icon: CircleDot, tone: 'muted' },
  'type:msq': { icon: ListChecks, tone: 'muted' },
  'type:short': { icon: AlignLeft, tone: 'muted' }
};

/**
 * The paper on the page: every question with their answer, the right one and
 * the marks - what the Excel holds, without downloading it - narrowed by one
 * Filter button to the right or wrong ones, or one kind of question.
 */
export function AnswerReview({ code, review }) {
  const own = useMyResponses(code, !review);
  const { data, failed } = review || own;
  const [filters, setFilters] = useState([]);
  if (failed) return <p className="help result-review">{failed}</p>;
  if (!data) return <div className="result-review"><Skeleton rows={3} label="Loading your answers"/></div>;
  const answers = data.answers.map((answer) => ({ ...answer, standing: standingOf(answer), kind: typeOf(answer) }));
  const mixed = new Set(answers.map((answer) => answer.kind)).size > 1;
  const groups = mixed ? [RESULT_GROUP, TYPE_GROUP] : [RESULT_GROUP];
  const shown = applyFilters(answers, groups, filters);
  return (
    <section className="result-review" aria-label="Your answers">
      <div className="result-review-head">
        <h2>Your answers</h2>
        <span className="result-shown">{filters.length ? `${shown.length} of ${answers.length}` : `${answers.length} question${answers.length === 1 ? '' : 's'}`}</span>
        <FilterMenu groups={groups} rows={answers} selected={filters} onChange={setFilters} icons={FILTER_ICONS}
          title="Filter answers" allLabel="All questions"/>
      </div>
      {shown.length === 0 && (
        <p className="help result-none">
          No questions match this filter.{' '}
          <button type="button" className="link-button" onClick={() => setFilters([])}>Show all</button>
        </p>
      )}
      <ol className="result-answers">
        {shown.map((answer) => {
          const { standing } = answer;
          const Sign = SIGNS[standing];
          return (
            <li key={answer.questionNumber} className={`result-answer is-${standing}`}>
              <div className="result-answer-head">
                <span className="result-q-group">
                  <span className="result-q">Q{answer.questionNumber}</span>
                  <span className="result-type" title={TYPE_NAMES[answer.kind].name}>{TYPE_NAMES[answer.kind].short}</span>
                </span>
                <span className="result-marks"><Sign size={14} aria-hidden="true"/>{answer.marks === null ? 'Not marked' : `${answer.marks}/${answer.maxMarks}`}</span>
              </div>
              <RichText className="result-prompt" text={answer.prompt}/>
              {answer.image && <QuestionImage image={answer.image} label={`Picture for question ${answer.questionNumber}`} compact/>}
              {answer.classPercentRight !== null && answer.classPercentRight !== undefined && (
                <p className="result-class">{answer.classPercentRight}% of the class got this right</p>
              )}
              <dl className="result-lines">
                <div className="is-yours">
                  <dt>Your answer</dt>
                  <dd className={answer.manualGrading ? 'is-written' : answer.answered ? undefined : 'is-blank'}>{answer.answered ? answer.selectedAnswer : 'Not answered'}</dd>
                </div>
                {!answer.manualGrading && standing !== 'right' && (
                  <div className="is-key"><dt>Correct answer</dt><dd>{answer.correctAnswer}</dd></div>
                )}
              </dl>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Once the answers are out: each kind of question, and how the paper stands against the class. */
function ResultInsights({ code }) {
  const { data } = useMyResponses(code);
  if (!data) return null;
  return (
    <div className="result-insights">
      <TypeBreakdown answers={data.answers}/>
      <ClassComparison comparison={data.comparison} answers={data.answers}/>
    </div>
  );
}

export function ResultScreen({ result }) {
  if (!result) return <div className="empty card">Preparing result…</div>;

  if (result.wasReset) {
    return (
      <section className="join-card card">
        <p className="eyebrow">Attempt reset</p>
        <h1>Your administrator reset this attempt.</h1>
        <p>Reload the test link to begin again.</p>
      </section>
    );
  }

  if (!result.released) {
    return (
      <section className="join-card card">
        <p className="eyebrow" style={{ color: 'var(--warning)' }}>Test submitted</p>
        <h1>Marks are pending</h1>
        <HowSubmitted result={result}/>
        <p>{result.message || 'Your marks are not available yet.'}</p>
        <p className="help">This page checks automatically when marks become available.</p>
        <IntegrityLine result={result}/>
      </section>
    );
  }

  const total = result.totalMarks ?? result.totalQuestions;
  const percent = total ? Math.round((result.score / total) * 100) : null;
  return (
    <section className={`join-card card result-card${result.canDownload ? ' has-review' : ''}`}>
      <div className="result-summary">
        <p className="eyebrow" style={{ color: 'var(--success)' }}>Test submitted</p>
        {result.title && <p className="result-title">{result.title}</p>}
        <div className="result-score-row">
          <h1 className="result-score">{result.score}<small>/{total}</small></h1>
          {percent !== null && <span className="result-percent">{percent}%</span>}
          <DownloadResponses result={result}/>
        </div>
        <HowSubmitted result={result}/>
        {/* Shown before marking was finished: the score so far, said plainly. */}
        {result.pendingManual > 0 && (
          <p className="notice">
            {result.pendingManual} short answer{result.pendingManual === 1 ? ' is' : 's are'} not marked yet. This score counts only what has been
            marked so far, and changes as your teacher marks the rest.
          </p>
        )}
        <p className="help">Answered {result.answered} of {result.totalQuestions} · submitted {dateTime(result.submittedAt)}</p>
        <IntegrityLine result={result}/>
        {result.canDownload && <ResultInsights code={result.code}/>}
      </div>
      {result.canDownload && <AnswerReview code={result.code}/>}
    </section>
  );
}
