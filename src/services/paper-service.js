import { registrations, tests } from '../db/index.js';
import { PublicTestError } from '../lib/errors.js';
import { stableSort } from '../lib/crypto.js';
import { buildTest } from '../domain/test-builder.js';
import { publicTest } from '../domain/presenters.js';
import { activeQuestions, questionType } from '../domain/question-bank.js';
import { endModeOf, startModeOf } from '../domain/attempt-rules.js';
import { invalidateTestCache, registrationsOf, requireOwnedTest, serializePaperWrite, serializeTestWrite, testDocByCode } from '../data/test-repository.js';
import { gradeAnswers } from './attempt-service.js';
import { earnedMarks, questionMarks, roundMarks } from '../domain/marks.js';
import { refuseIfFrozen } from '../domain/freeze.js';
import { adminDashboard } from './admin-service.js';
import { refusePastTimes } from './test-service.js';
import { requireImages } from './question-image-service.js';
import { imageView } from '../domain/question-image.js';

/**
 * Editing a test's question paper - questions, options, answer keys, times,
 * the mix and the settings - at any point, even once papers are out.
 *
 * Once students have papers, the admin chooses who an edit reaches:
 *
 *   everyone  Every paper, including ones being written and ones submitted.
 *             An edited question is changed in place, so students see the fix
 *             on their next refresh and submitted papers are re-marked with
 *             the new answer key. A deleted question is taken off every paper.
 *   new       Only papers started from now. An edited or deleted question
 *             that is on some paper is kept, `retired`, for those papers
 *             (see activeQuestions); new papers get the new version.
 *
 * Either way, questions added now can only reach papers started from now:
 * a paper already handed out keeps its number of questions.
 */

const CHOICES = ['everyone', 'new'];

const toStored = (built, id) => ({
  id,
  prompt: built.prompt,
  // Short answers are stored as MSQ with manual grading - see questionType().
  type: built.type === 'short' ? 'msq' : built.type,
  options: built.options,
  correctOptions: built.correctOptions,
  manualGrading: built.type === 'short',
  timeSeconds: built.timeSeconds ?? null,
  // Its own marks; null follows its type's (domain/marks.js).
  marks: built.marks ?? null,
  image: built.image ?? null
});

// Marks are not part of what makes a question a different version: a change
// to what it is worth re-marks every paper that has it (see saveTestPaper).
const sameQuestion = (a, b) => JSON.stringify([a.prompt, a.type, a.options, a.correctOptions, Boolean(a.manualGrading), a.timeSeconds ?? null, a.image?.id ?? null])
  === JSON.stringify([b.prompt, b.type, b.options, b.correctOptions, Boolean(b.manualGrading), b.timeSeconds ?? null, b.image?.id ?? null]);

const papersOf = (test) => (test.registrations || []).filter((registration) => registration.attempt);

/** The test as the editor needs it: settings, and every active question with its answer key. */
export async function testForEditing(req, code) {
  const test = await requireOwnedTest(req, code);
  const onPapers = new Map();
  for (const { attempt } of papersOf(test)) {
    for (const assigned of attempt.questions || []) onPapers.set(assigned.questionId, (onPapers.get(assigned.questionId) || 0) + 1);
  }
  const papers = papersOf(test);
  return {
    test: { ...publicTest(test), locationLatitude: test.locationLatitude ?? null, locationLongitude: test.locationLongitude ?? null },
    questions: activeQuestions(test).map((question) => ({
      id: question.id,
      prompt: question.prompt,
      type: questionType(question),
      options: question.options || [],
      correctOptions: (question.correctOptions || []).map(String),
      timeSeconds: question.timeSeconds ?? null,
      marks: question.marks ?? null,
      image: question.image ? { ...question.image, url: imageView(question.image).url } : null,
      onPapers: onPapers.get(question.id) || 0
    })),
    papers: { started: papers.length, submitted: papers.filter(({ attempt }) => attempt.status === 'submitted').length }
  };
}

/**
 * The new bank. Questions keep their id when edited (the editor sends it);
 * new ones get fresh ids. With papers out, `mode` decides whether an edited
 * question changes in place ('everyone') or is replaced by a new version
 * while the old one is kept for the papers that have it ('new').
 */
function planBank(stored, rawQuestions, built, mode, usedIds) {
  const byId = new Map(stored.map((question) => [question.id, question]));
  let nextId = Math.max(0, ...stored.map((question) => question.id)) + 1;
  const active = [];
  // Older versions stay exactly as long as some paper still uses them, whichever choice is made now.
  const retired = stored.filter((question) => question.retired && usedIds.has(question.id));
  let edited = 0;
  const changed = new Map();
  const kept = new Set();

  built.forEach((question, index) => {
    const wanted = Number(rawQuestions[index]?.id);
    const before = byId.get(wanted);
    if (!before || before.retired || kept.has(wanted)) {
      active.push(toStored(question, nextId));
      nextId += 1;
      return;
    }
    kept.add(wanted);
    const after = toStored(question, wanted);
    // The same question, perhaps worth something else now: it keeps its place, with its new marks.
    if (sameQuestion(before, after)) { active.push({ ...before, marks: after.marks }); return; }
    edited += 1;
    if (mode === 'new' && usedIds.has(wanted)) {
      // Papers that have it keep this version; new papers get the edit.
      retired.push({ ...before, retired: true });
      active.push({ ...after, id: nextId });
      nextId += 1;
      return;
    }
    active.push(after);
    if (usedIds.has(wanted)) changed.set(wanted, { before, after });
  });

  const removed = stored.filter((question) => !question.retired && !kept.has(question.id));
  const removedIds = new Set();
  for (const question of removed) {
    if (!usedIds.has(question.id)) continue;
    if (mode === 'new') retired.push({ ...question, retired: true });
    else removedIds.add(question.id);
  }
  return { questions: [...active, ...retired], changed, removedIds, edited, added: built.length - kept.size, removedCount: removed.length };
}

/**
 * One paper brought up to the edited bank ('everyone'): deleted questions
 * taken off (and the rest renumbered), answers that no longer fit an edited
 * question cleared, a strict paper's place kept, and a submitted paper
 * re-marked against the new answer key - and against what each question is
 * worth now (`rescaled`: question id → { from, to } marks).
 */
function migratePaper(nextTest, attempt, changed, removedIds, rescaled = new Map()) {
  const order = [...(attempt.questions || [])].sort((left, right) => left.questionIndex - right.questionIndex);
  const kept = order.filter((assigned) => !removedIds.has(assigned.questionId));
  if (!kept.length) throw new PublicTestError(409, 'This would leave a student\'s paper with no questions. Keep at least one of the questions they were given.');

  const questions = kept.map((assigned, index) => {
    const change = changed.get(assigned.questionId);
    const optionsChanged = change && (change.before.options || []).length !== (change.after.options || []).length;
    return {
      ...assigned,
      questionIndex: index,
      optionOrder: optionsChanged
        ? stableSort(change.after.options.map((_option, position) => String(position)), `${attempt.seed}:${assigned.questionId}`, (id) => id)
        : assigned.optionOrder
    };
  });

  const manualIds = new Set((nextTest.questions || []).filter((question) => question.manualGrading).map((question) => question.id));
  let answers = (attempt.answers || []).filter((answer) => !removedIds.has(answer.questionId)).map((given) => {
    // Worth something else now: a mark given by hand - a short answer's, or one
    // a teacher gave a choice answer - keeps its share: full stays full, half
    // stays half. Other choice answers are simply marked again.
    const worth = rescaled.get(given.questionId);
    const answer = worth && (manualIds.has(given.questionId) || given.marksOverride) && earnedMarks(given) !== null
      ? { ...given, isCorrect: roundMarks((earnedMarks(given) * worth.to) / worth.from) }
      : given;
    const change = changed.get(answer.questionId);
    if (!change) return answer;
    // The question itself changed: a mark a teacher gave its old version no
    // longer applies, and the answer is marked again.
    const { marksOverride: _given, ...fresh } = answer;
    // Switched between a written answer and a choice: the old answer no longer fits.
    if (Boolean(change.before.manualGrading) !== Boolean(change.after.manualGrading)) {
      return { ...fresh, selectedOptions: [], answerText: '', answeredAt: null, isCorrect: null };
    }
    if (change.after.manualGrading) return answer;
    let selected = (fresh.selectedOptions || []).filter((id) => Number(id) < change.after.options.length);
    if (change.after.type === 'mcq' && selected.length > 1) selected = [];
    return { ...fresh, selectedOptions: selected, answeredAt: selected.length ? fresh.answeredAt : null };
  });
  if (attempt.status === 'submitted') answers = gradeAnswers(nextTest, { answers });

  const next = { ...attempt, questions, answers };
  if (attempt.strict) {
    const openId = order[attempt.strict.index]?.questionId;
    next.strict = {
      ...attempt.strict,
      index: order.slice(0, attempt.strict.index).filter((assigned) => !removedIds.has(assigned.questionId)).length,
      // The open question was deleted: the next one's clock starts when shown.
      shownAt: openId !== undefined && removedIds.has(openId) ? null : attempt.strict.shownAt,
      log: (attempt.strict.log || []).filter((entry) => !removedIds.has(entry.questionId))
    };
  }
  return next;
}

/**
 * Writes one student's paper brought up to the edited bank - but only over
 * the paper exactly as it was read. The student may save an answer in the
 * same moment: then the write misses, the paper is read again with that
 * answer in it, brought up to date again, and written again. No answer is
 * ever lost to an edit.
 */
async function rewritePaper(testCode, registration, migrated, migrate) {
  // Answers wait for their turn while this runs, so only the rarer writes
  // (a move to the next question, a check-in) can still make it read again.
  return serializePaperWrite(testCode, registration.id, async () => {
    let current = registration.attempt;
    let next = migrated;
    for (let round = 0; round < 8; round += 1) {
      const result = await registrations().updateOne({ testCode, id: registration.id, attempt: current }, { $set: { attempt: next } });
      if (result.matchedCount === 1) return;
      const [latest] = await registrationsOf(testCode, { id: registration.id });
      // Restarted or reset meanwhile: there is no paper left to bring up to date.
      if (!latest?.attempt) return;
      current = latest.attempt;
      next = migrate(current);
    }
    throw new PublicTestError(503, "A student's paper was busy while the change was being applied. Save again to finish applying it.");
  });
}

export async function saveTestPaper(req, code, raw = {}) {
  const test = await requireOwnedTest(req, code);
  refuseIfFrozen(test, 'edit the test');
  if (!Array.isArray(raw.questions)) throw new PublicTestError(400, 'Send the list of questions.');
  const hasPapers = papersOf(test).length > 0;
  if (hasPapers && !CHOICES.includes(raw.applyTo)) {
    throw new PublicTestError(400, 'Students already have papers: choose whether the changes reach them too.', 'NEEDS_APPLY_TO');
  }
  // Once the test is under way, what shapes the whole cohort's test stays as
  // it is. The end time has its own control (Extend time).
  const started = Boolean(test.isStarted || test.isClosed);
  const pick = (field, fallback) => (started || raw[field] === undefined ? fallback : raw[field]);
  const source = {
    title: raw.title ?? test.title,
    instructions: raw.instructions ?? test.instructions,
    startMode: pick('startMode', startModeOf(test)),
    opensAt: pick('opensAt', test.opensAt),
    endMode: pick('endMode', endModeOf(test)),
    durationMinutes: pick('durationMinutes', test.durationMinutes),
    endsAt: pick('endsAt', test.endsAt ?? undefined),
    fullscreenExitLimit: raw.fullscreenExitLimit ?? test.fullscreenExitLimit,
    fullscreenAbsenceLimitSeconds: raw.fullscreenAbsenceLimitSeconds ?? test.fullscreenAbsenceLimitSeconds,
    warningsBeforeLock: raw.warningsBeforeLock ?? test.warningsBeforeLock,
    violationAction: raw.violationAction ?? test.violationAction,
    shuffleQuestions: pick('shuffleQuestions', test.shuffleQuestions),
    allowGuests: raw.allowGuests ?? test.allowGuests,
    requirePrivateWindow: raw.requirePrivateWindow ?? test.requirePrivateWindow ?? false,
    devices: raw.devices ?? test.devices,
    questionLayout: pick('questionLayout', test.questionLayout),
    strictTiming: pick('strictTiming', test.strictTiming === true),
    // A one-way paper's clock is fixed once it is under way, as in Edit test setup (LOCKED_ONCE_STARTED).
    strictNext: pick('strictNext', test.strictNext !== false),
    typeSeconds: pick('typeSeconds', test.typeSeconds),
    // What questions are worth can change at any time: papers are re-marked.
    typeMarks: raw.typeMarks ?? test.typeMarks,
    questionDraw: pick('questionDraw', test.questionDraw),
    locationRequired: raw.locationRequired ?? test.locationRequired,
    locationRadiusMeters: raw.locationRadiusMeters ?? test.locationRadiusMeters,
    locationLatitude: raw.locationLatitude ?? test.locationLatitude,
    locationLongitude: raw.locationLongitude ?? test.locationLongitude,
    resultReleaseMode: raw.resultReleaseMode ?? test.resultReleaseMode,
    questionMix: raw.questionMix ?? test.questionMix,
    questions: raw.questions.map((question) => ({
      prompt: question?.prompt, type: question?.type, options: question?.options, correctOptions: question?.correctOptions,
      timeSeconds: question?.timeSeconds, marks: question?.marks, image: question?.image
    }))
  };
  const input = buildTest(source);
  if (!started) refusePastTimes(input, raw);
  await requireImages(input.questions);

  let summary = null;
  await serializeTestWrite(test.code, async () => {
    // Read again inside the queue, so two saves of this test never interleave.
    const fresh = await testDocByCode(test.code);
    const papers = papersOf(fresh);
    const usedIds = new Set(papers.flatMap(({ attempt }) => (attempt.questions || []).map((assigned) => assigned.questionId)));
    const mode = papers.length ? raw.applyTo : 'everyone';
    const plan = planBank(fresh.questions || [], raw.questions, input.questions, mode, usedIds);
    const nextTest = { ...fresh, typeMarks: input.typeMarks, questions: plan.questions };
    // What each question on a paper was worth, and is worth now - its own
    // marks or its type's. A change re-marks every paper that has it, whichever
    // choice was made: that choice is about a question's content.
    const worthOf = (doc) => new Map((doc.questions || []).map((question) => [question.id, questionMarks(doc, question)]));
    const before = worthOf(fresh);
    const rescaled = new Map([...worthOf(nextTest)]
      .filter(([id, to]) => usedIds.has(id) && before.has(id) && before.get(id) !== to)
      .map(([id, to]) => [id, { from: before.get(id), to }]));

    // Every paper the edit reaches, worked out before anything is written: a
    // paper that would be left with no questions stops the whole save here.
    const migrations = [];
    if (plan.changed.size || plan.removedIds.size || rescaled.size) {
      for (const registration of papers) {
        const touches = (registration.attempt.questions || []).some((assigned) => (
          plan.changed.has(assigned.questionId) || plan.removedIds.has(assigned.questionId) || rescaled.has(assigned.questionId)
        ));
        if (touches) migrations.push({ registration, attempt: migratePaper(nextTest, registration.attempt, plan.changed, plan.removedIds, rescaled) });
      }
    }

    const set = {
      title: input.title,
      instructions: input.instructions,
      updatedAt: new Date(),
      estimatedSeconds: input.estimatedSeconds,
      questionCount: input.questionCount,
      questionMix: input.questionMix,
      fullscreenExitLimit: input.fullscreenExitLimit,
      fullscreenAbsenceLimitSeconds: input.fullscreenAbsenceLimitSeconds,
      warningsBeforeLock: input.warningsBeforeLock,
      violationAction: input.violationAction,
      allowGuests: input.allowGuests,
      requirePrivateWindow: input.requirePrivateWindow,
      devices: input.devices,
      strictNext: input.strictNext,
      typeSeconds: input.typeSeconds,
      typeMarks: input.typeMarks,
      locationRequired: input.locationRequired,
      locationRadiusMeters: input.locationRadiusMeters,
      locationLatitude: input.locationLatitude,
      locationLongitude: input.locationLongitude,
      resultReleaseMode: input.resultReleaseMode,
      questions: plan.questions
    };
    if (!started) {
      Object.assign(set, {
        startMode: input.startMode, opensAt: input.opensAt, endMode: input.endMode, untimed: input.untimed,
        endsAt: input.endsAt, durationMinutes: input.durationMinutes, windowSeconds: input.windowSeconds,
        shuffleQuestions: input.shuffleQuestions, questionLayout: input.questionLayout,
        strictTiming: input.strictTiming, questionDraw: input.questionDraw
      });
    }
    await tests().updateOne({ code: test.code }, { $set: set });
    await invalidateTestCache(test.code);
    for (const { registration, attempt } of migrations) {
      await rewritePaper(test.code, registration, attempt, (latest) => migratePaper(nextTest, latest, plan.changed, plan.removedIds, rescaled));
    }
    summary = {
      applyTo: papers.length ? mode : null,
      edited: plan.edited, added: plan.added, removed: plan.removedCount, papersUpdated: migrations.length
    };
  });
  return { ...(await adminDashboard(req, code)), paperSummary: summary };
}
