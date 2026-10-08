/**
 * The Test tab's overview: the whole class at a glance - who took part, how
 * the marks came out, question by question, how long papers took, how they
 * were handed in and who left the page. Worked out here in one pass over the
 * class, so it holds for thousands of students as for ten: the dashboard
 * itself has only one page of a big class in hand.
 *
 * Marks and questions count submitted papers only - while the test runs,
 * "so far". A paper with short answers still to mark counts what is marked.
 */
import { registrations } from '../db/index.js';
import { requireOwnedTest } from '../data/test-repository.js';
import { dateMs, iso } from '../lib/time.js';
import { activeQuestions, questionType } from '../domain/question-bank.js';
import { earnedMarks, marksOrNull, paperMarks, questionMarks, roundMarks } from '../domain/marks.js';
import { LEAVE_REASONS, integritySummary } from '../domain/integrity.js';
import { timeTakenSeconds } from '../domain/presenters.js';
import { oneLine } from '../domain/rich-text.js';

/** Only what the overview reads: never answer text or events. */
const PROJECTION = {
  _id: 0, status: 1,
  'attempt.status': 1, 'attempt.startedAt': 1, 'attempt.submittedAt': 1, 'attempt.submittedBy': 1,
  'attempt.pausedAt': 1, 'attempt.isLocked': 1, 'attempt.awaySince': 1, 'attempt.integrity': 1,
  'attempt.questions.questionId': 1,
  'attempt.answers.questionId': 1, 'attempt.answers.isCorrect': 1, 'attempt.answers.answeredAt': 1, 'attempt.answers.selectedOptions': 1
};
/** Marks are shown in ten bands of 10%: 0-9%, 10-19% ... 90-100%. */
const BANDS = 10;
const FINISHES = ['student', 'time', 'admin', 'teacher'];
/**
 * While a test runs, every teacher's tab asks again as answers come in. One
 * answer is shared for this long, so a busy test's overview is worked out at
 * most this often, however many tabs are open.
 */
const LIVE_REUSE_MS = 5_000;
const recent = new Map();

export const testOverview = (req, code) => shared(req, code, 'overview', overviewOf);

/** The Analysis tab: every submitted paper, question by question (matrixOf). */
export const testMatrix = (req, code) => shared(req, code, 'matrix', matrixOf);

async function shared(req, code, kind, build) {
  const test = await requireOwnedTest(req, code, { withStudents: false });
  const live = test.isStarted && !test.isClosed;
  const key = `${test.code}:${kind}`;
  const held = recent.get(key);
  if (live && held && Date.now() - held.at < LIVE_REUSE_MS) return held.promise;
  const promise = build(test);
  if (live) {
    for (const [old, entry] of recent) if (Date.now() - entry.at > 60_000) recent.delete(old);
    recent.set(key, { at: Date.now(), promise });
    promise.catch(() => recent.delete(key));
  }
  return promise;
}

const median = (sorted) => {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => (values.length ? values.reduce((total, value) => total + value, 0) / values.length : null);
const round1 = (value) => (value === null ? null : Math.round(value * 10) / 10);
const earliest = (current, value) => (value && (!current || dateMs(value) < dateMs(current)) ? value : current);
const latest = (current, value) => (value && (!current || dateMs(value) > dateMs(current)) ? value : current);
const choiceKey = (answer) => (answer.selectedOptions || []).map(String).sort().join(',');
const optionText = (question, key) => key.split(',').map((id) => question.options?.[Number(id)]).filter((text) => text !== undefined).map(oneLine).join(' • ');

/**
 * What every paper will be worth, before any is made: the question mix at
 * each type's worth. Null when questions carry worths of their own and papers
 * may differ - the papers themselves then say (marks.fullMarks).
 */
function plannedFullMarks(test) {
  const bank = activeQuestions(test);
  if (!bank.length || bank.some((question) => marksOrNull(question.marks) !== null)) return null;
  if (test.questionMix) {
    return roundMarks(['mcq', 'msq', 'short'].reduce((total, type) => total
      + (Number(test.questionMix[type]) || 0) * questionMarks(test, { type: type === 'short' ? 'msq' : type, manualGrading: type === 'short' }), 0));
  }
  const worths = new Set(bank.map((question) => questionMarks(test, question)));
  return worths.size === 1 ? roundMarks([...worths][0] * (Number(test.questionCount) || 0)) : null;
}

/** The class at a glance: the Test tab, and what a student's result compares with (classStats). */
export async function overviewOf(test, { percentList = false } = {}) {
  const bank = test.questions || [];
  const questions = new Map(bank.map((question, index) => [question.id, {
    question, number: index + 1, worth: questionMarks(test, question),
    papers: 0, answered: 0, right: 0, partial: 0, wrong: 0, pending: 0, marks: 0, wrongPicks: new Map()
  }]));
  const people = { registered: 0, pending: 0, approved: 0, rejected: 0, began: 0, notBegun: 0, writing: 0, paused: 0, locked: 0, away: 0, submitted: 0 };
  const finish = { student: 0, time: 0, admin: 0, teacher: 0, unknown: 0 };
  const conduct = { began: 0, left: 0, leaves: 0, awayMs: 0, longestAwayMs: 0, everLocked: 0, offline: 0, copyPaste: 0, reasons: {} };
  const timeline = { firstBeganAt: null, lastBeganAt: null, firstSubmittedAt: null, lastSubmittedAt: null };
  const percents = [];
  const scores = [];
  const fullMarks = new Set();
  const times = [];
  const answeredShares = [];
  let toMark = 0;

  const cursor = registrations().find({ testCode: test.code }, { projection: PROJECTION });
  for await (const registration of cursor) {
    people.registered += 1;
    if (registration.status === 'pending') people.pending += 1;
    else if (registration.status === 'rejected') people.rejected += 1;
    else if (registration.status === 'approved') people.approved += 1;
    const attempt = registration.attempt;
    if (!attempt) {
      if (registration.status === 'approved') people.notBegun += 1;
      continue;
    }
    people.began += 1;
    timeline.firstBeganAt = earliest(timeline.firstBeganAt, attempt.startedAt);
    timeline.lastBeganAt = latest(timeline.lastBeganAt, attempt.startedAt);

    const integrity = integritySummary(attempt);
    conduct.began += 1;
    if (integrity.leaveCount > 0) conduct.left += 1;
    conduct.leaves += integrity.leaveCount || 0;
    conduct.awayMs += integrity.awayMs || 0;
    conduct.longestAwayMs = Math.max(conduct.longestAwayMs, integrity.longestAwayMs || 0);
    if (integrity.lockCount > 0) conduct.everLocked += 1;
    if (integrity.offline.count > 0) conduct.offline += 1;
    if ((integrity.flags.copy || 0) + (integrity.flags.cut || 0) + (integrity.flags.paste || 0) > 0) conduct.copyPaste += 1;
    for (const [reason, count] of Object.entries(integrity.leaves)) {
      if (count > 0 && reason !== 'offline') conduct.reasons[reason] = (conduct.reasons[reason] || 0) + count;
    }

    if (attempt.status !== 'submitted') {
      people.writing += 1;
      if (attempt.pausedAt) people.paused += 1;
      if (attempt.isLocked) people.locked += 1;
      if (integrity.isAway) people.away += 1;
      continue;
    }
    people.submitted += 1;
    finish[FINISHES.includes(attempt.submittedBy) ? attempt.submittedBy : 'unknown'] += 1;
    timeline.firstSubmittedAt = earliest(timeline.firstSubmittedAt, attempt.submittedAt);
    timeline.lastSubmittedAt = latest(timeline.lastSubmittedAt, attempt.submittedAt);
    const taken = timeTakenSeconds(attempt);
    if (taken !== null) times.push(taken);

    let score = 0;
    let waiting = false;
    let answered = 0;
    const answers = attempt.answers || [];
    for (const answer of answers) {
      const entry = questions.get(answer.questionId);
      const marks = earnedMarks(answer);
      const given = Boolean(answer.answeredAt);
      if (marks !== null) score += marks;
      if (given) answered += 1;
      if (!entry) continue;
      entry.papers += 1;
      if (!given) continue;
      entry.answered += 1;
      if (marks === null) {
        entry.pending += 1;
        if (entry.question.manualGrading) waiting = true;
        continue;
      }
      entry.marks += marks;
      if (marks >= entry.worth) entry.right += 1;
      else if (marks > 0) entry.partial += 1;
      else {
        entry.wrong += 1;
        if (!entry.question.manualGrading) {
          const key = choiceKey(answer);
          entry.wrongPicks.set(key, (entry.wrongPicks.get(key) || 0) + 1);
        }
      }
    }
    if (waiting) toMark += 1;
    const worth = paperMarks(test, attempt);
    const percent = worth > 0 ? (score / worth) * 100 : 0;
    fullMarks.add(worth);
    scores.push(roundMarks(score));
    percents.push(percent);
    const total = (attempt.questions?.length || answers.length);
    if (total) answeredShares.push(answered / total);
  }

  const sortedPercents = [...percents].sort((a, b) => a - b);
  const sortedScores = [...scores].sort((a, b) => a - b);
  const sameFull = fullMarks.size === 1 ? [...fullMarks][0] : null;
  const bands = Array.from({ length: BANDS }, () => 0);
  for (const percent of percents) bands[Math.min(BANDS - 1, Math.floor(percent / (100 / BANDS)))] += 1;
  const sortedTimes = [...times].sort((a, b) => a - b);

  return {
    serverTime: new Date().toISOString(),
    people,
    paper: { fullMarks: plannedFullMarks(test) },
    finish,
    timeline: {
      startedAt: iso(test.startedAt), endedAt: iso(test.closedAt),
      firstBeganAt: iso(timeline.firstBeganAt), lastBeganAt: iso(timeline.lastBeganAt),
      firstSubmittedAt: iso(timeline.firstSubmittedAt), lastSubmittedAt: iso(timeline.lastSubmittedAt)
    },
    marks: {
      papers: percents.length,
      toMark,
      // Every paper is worth the same unless questions differ in worth and papers differ in questions.
      fullMarks: sameFull,
      average: sameFull === null ? null : round1(mean(scores)),
      median: sameFull === null ? null : round1(median(sortedScores)),
      highest: sameFull === null ? null : sortedScores.at(-1) ?? null,
      lowest: sameFull === null ? null : sortedScores[0] ?? null,
      averagePercent: round1(mean(percents)),
      medianPercent: round1(median(sortedPercents)),
      highestPercent: round1(sortedPercents.at(-1) ?? null),
      lowestPercent: round1(sortedPercents[0] ?? null),
      bands,
      // How much of the paper was answered, on average.
      answeredPercent: answeredShares.length ? Math.round(mean(answeredShares) * 100) : null
    },
    time: {
      papers: sortedTimes.length,
      averageSeconds: sortedTimes.length ? Math.round(mean(sortedTimes)) : null,
      medianSeconds: sortedTimes.length ? Math.round(median(sortedTimes)) : null,
      fastestSeconds: sortedTimes[0] ?? null,
      slowestSeconds: sortedTimes.at(-1) ?? null
    },
    conduct: {
      began: conduct.began,
      left: conduct.left,
      leaves: conduct.leaves,
      averageAwaySeconds: conduct.left ? Math.round(conduct.awayMs / conduct.left / 1000) : 0,
      longestAwaySeconds: Math.round(conduct.longestAwayMs / 1000),
      everLocked: conduct.everLocked,
      offline: conduct.offline,
      copyPaste: conduct.copyPaste,
      reasons: Object.entries(conduct.reasons)
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => ({ id, label: LEAVE_REASONS[id] || id, count }))
    },
    questions: [...questions.values()]
      .filter((entry) => entry.papers > 0)
      .map((entry) => {
        const [commonWrong, commonWrongCount] = [...entry.wrongPicks.entries()].sort((a, b) => b[1] - a[1])[0] || [];
        return {
          id: entry.question.id,
          number: entry.number,
          type: questionType(entry.question),
          prompt: oneLine(entry.question.prompt).slice(0, 180),
          hasImage: Boolean(entry.question.image),
          retired: Boolean(entry.question.retired),
          worth: entry.worth,
          papers: entry.papers,
          answered: entry.answered,
          blank: entry.papers - entry.answered,
          right: entry.right,
          partial: entry.partial,
          wrong: entry.wrong,
          pending: entry.pending,
          // Of the papers it was on, as the Excel's question analysis counts it.
          percentRight: Math.round((entry.right / entry.papers) * 100),
          // A blank counts as no marks; an answer still to mark is left out until it is marked.
          averageMarks: entry.papers - entry.pending ? roundMarks(entry.marks / (entry.papers - entry.pending)) : null,
          commonWrong: commonWrong === undefined ? null : { answer: optionText(entry.question, commonWrong) || 'No option', count: commonWrongCount }
        };
      }),
    // classStats only: every paper's percent, lowest first - never sent as it is.
    ...(percentList ? { percentList: sortedPercents } : {})
  };
}

/**
 * The class as a student may compare their own paper with it once their marks
 * are out (registration-service myResponseView): numbers only, never a name.
 * Worked out once per test and shared for a minute, so a class opening their
 * results together costs one pass.
 */
const CLASS_REUSE_MS = 60_000;
const classes = new Map();
export function classStats(test) {
  const held = classes.get(test.code);
  if (held && Date.now() - held.at < CLASS_REUSE_MS) return held.promise;
  const promise = overviewOf(test, { percentList: true }).then((overview) => {
    const types = {};
    for (const question of overview.questions) {
      const counted = question.papers - question.pending;
      const entry = types[question.type] || (types[question.type] = { marks: 0, worth: 0 });
      entry.marks += (question.averageMarks || 0) * counted;
      entry.worth += question.worth * counted;
    }
    return {
      papers: overview.marks.papers,
      averagePercent: overview.marks.averagePercent,
      medianPercent: overview.marks.medianPercent,
      highestPercent: overview.marks.highestPercent,
      medianSeconds: overview.time.medianSeconds,
      percents: overview.percentList,
      questions: new Map(overview.questions.map((question) => [question.id, question.percentRight])),
      types: Object.fromEntries(Object.entries(types).map(([type, entry]) => [type, entry.worth ? round1((entry.marks / entry.worth) * 100) : null]))
    };
  });
  for (const [old, entry] of classes) if (Date.now() - entry.at > 10 * 60_000) classes.delete(old);
  classes.set(test.code, { at: Date.now(), promise });
  promise.catch(() => classes.delete(test.code));
  return promise;
}

/** Where one paper (its percent, its time) stands in the class: what the student's result page shows. */
export function standingIn(stats, percent, seconds) {
  const higher = stats.percents.filter((value) => value > percent + 1e-9).length;
  const lower = stats.percents.filter((value) => value < percent - 1e-9).length;
  return {
    papers: stats.papers,
    rank: higher + 1,
    // Of everyone else, how many this paper did better than.
    betterThanPercent: stats.papers > 1 ? Math.round((lower / (stats.papers - 1)) * 100) : null,
    you: { percent: round1(percent), seconds },
    class: { averagePercent: stats.averagePercent, medianPercent: stats.medianPercent, highestPercent: stats.highestPercent, medianSeconds: stats.medianSeconds },
    types: stats.types
  };
}

/*
 * The Analysis tab's data: every submitted paper against every question, as
 * the teacher's own browser works out the figures from it (analysis-compute
 * in the client) - so ticking questions, changing bars or the rank mode costs
 * no request.
 *
 * Each answer is one letter of a paper's `st`, column by column:
 *   O right (full marks), P part marks (the marks in `pm`), W wrong, B blank,
 *   Q not marked yet - never counted as 0 - and . not on this paper.
 */
const MATRIX_PROJECTION = {
  _id: 0, id: 1, fullName: 1, sapId: 1, status: 1,
  'attempt.status': 1, 'attempt.startedAt': 1, 'attempt.submittedAt': 1, 'attempt.integrity': 1,
  'attempt.answers.questionId': 1, 'attempt.answers.isCorrect': 1, 'attempt.answers.answeredAt': 1, 'attempt.answers.selectedOptions': 1
};

/** One answer's state, by the marks it has (null: not marked yet) and whether it was answered. */
export function answerState(marks, given, worth) {
  if (!given) return 'B';
  if (marks === null) return 'Q';
  if (marks >= worth) return 'O';
  return marks > 0 ? 'P' : 'W';
}

export async function matrixOf(test) {
  const bank = test.questions || [];
  const byId = new Map(bank.map((question, index) => [question.id, { question, number: index + 1, worth: questionMarks(test, question) }]));
  const people = { registered: 0, approved: 0, began: 0, absent: 0, writing: 0, submitted: 0 };
  const used = new Set();
  const wrongPicks = new Map();
  const papers = [];

  const cursor = registrations().find({ testCode: test.code }, { projection: MATRIX_PROJECTION });
  for await (const registration of cursor) {
    people.registered += 1;
    if (registration.status === 'approved') people.approved += 1;
    const attempt = registration.attempt;
    if (!attempt) {
      if (registration.status === 'approved') people.absent += 1;
      continue;
    }
    people.began += 1;
    if (attempt.status !== 'submitted') {
      people.writing += 1;
      continue;
    }
    people.submitted += 1;
    const states = new Map();
    for (const answer of attempt.answers || []) {
      const entry = byId.get(answer.questionId);
      if (!entry) continue;
      const marks = earnedMarks(answer);
      const state = answerState(marks, Boolean(answer.answeredAt), entry.worth);
      states.set(answer.questionId, [state, marks]);
      used.add(answer.questionId);
      if (state === 'W' && !entry.question.manualGrading) {
        const picks = wrongPicks.get(answer.questionId) || new Map();
        picks.set(choiceKey(answer), (picks.get(choiceKey(answer)) || 0) + 1);
        wrongPicks.set(answer.questionId, picks);
      }
    }
    const integrity = integritySummary(attempt);
    papers.push({
      id: registration.id, name: registration.fullName, sapId: registration.sapId || null,
      seconds: timeTakenSeconds(attempt),
      flags: {
        left: integrity.leaveCount || 0, locked: integrity.lockCount || 0,
        copyPaste: (integrity.flags.copy || 0) + (integrity.flags.cut || 0) + (integrity.flags.paste || 0)
      },
      states
    });
  }

  const columns = [...byId.values()].filter((entry) => used.has(entry.question.id));
  return {
    serverTime: new Date().toISOString(),
    test: {
      startedAt: iso(test.startedAt), closedAt: iso(test.closedAt), durationMinutes: test.durationMinutes ?? null,
      endMode: test.endMode || null, isStarted: Boolean(test.isStarted), isClosed: Boolean(test.isClosed), questionCount: test.questionCount
    },
    people,
    questions: columns.map(({ question, number, worth }) => {
      const [wrong, count] = [...(wrongPicks.get(question.id) || new Map()).entries()].sort((a, b) => b[1] - a[1])[0] || [];
      return {
        id: question.id, number, type: questionType(question), worth,
        prompt: oneLine(question.prompt).slice(0, 400), hasImage: Boolean(question.image),
        commonWrong: wrong === undefined ? null : { answer: optionText(question, wrong) || 'No option', count }
      };
    }),
    students: papers.map((paper) => {
      const partial = {};
      const st = columns.map(({ question }, column) => {
        const [state, marks] = paper.states.get(question.id) || ['.', null];
        if (state === 'P') partial[column] = roundMarks(marks);
        return state;
      }).join('');
      return { id: paper.id, name: paper.name, sapId: paper.sapId, seconds: paper.seconds, flags: paper.flags, st, pm: partial };
    })
  };
}
