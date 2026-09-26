/**
 * Everyone at once. Each student now has their own document and their writes
 * no longer queue behind the class, so this checks the moments where many
 * writes land together and exactly one - or all - must win:
 *
 *   - 30 guests typing the same SAP ID at the same instant: one seat, not two;
 *   - one student registering from 20 devices at once: one registration;
 *   - one student pressing Begin 20 times at once: one paper;
 *   - the admin editing a question for everyone while students keep answering:
 *     no answer lost, every paper brought up to date;
 *   - 150 students answering, then everyone submitting while the admin closes
 *     the test: every paper submitted once, with exactly the answers sent,
 *     marked right.
 *
 *   npm run check:concurrency     (MONGODB_URI decides the database)
 */
import assert from 'node:assert/strict';
import { closeDatabase, initializeDatabase, portalSessions, registrations, studentProfiles, tests } from '../src/db/index.js';
import { testDocByCode } from '../src/data/test-repository.js';
import { hash, randomId } from '../src/lib/crypto.js';
import { createTest } from '../src/services/test-service.js';
import { registerForTest } from '../src/services/registration-service.js';
import { getAttempt, saveAnswer, startAttempt, submitAttemptForStudent } from '../src/services/attempt-service.js';
import { bulkDecision, closeTest, startTest } from '../src/services/admin-service.js';
import { saveTestPaper, testForEditing } from '../src/services/paper-service.js';

const run = `${Date.now()}`;
const admin = { portalUser: { email: `concurrency-${run}@ddn.upes.ac.in`, displayName: 'Concurrency Admin', role: 'admin' } };
const codes = [];
const emails = [];
let checks = 0;
const pass = (label) => { checks += 1; console.log(`  PASS  ${label}`); };

function seatCookie() {
  const cookies = new Map();
  return { cookies, cookie(name, value) { cookies.set(name, value); } };
}
const asSeated = (request, code, response) => ({ ...request, signedCookies: { [`test_access_${code}`]: response.cookies.get(`test_access_${code}`) } });
const student = (tag, index) => {
  const email = `concurrency-${tag}-${index}-${run}@stu.upes.ac.in`;
  emails.push(email);
  return { portalUser: { email, displayName: `Student ${tag} ${index}`, role: 'student' } };
};
const sap = (index) => String(700_000_000 + ((Number(run.slice(-7)) * 13 + index) % 299_999_999));

async function newTest(title, extra = {}) {
  const { test } = await createTest(admin, {
    title, questionMix: { mcq: 3, msq: 0, short: 0 }, shuffleQuestions: false, resultReleaseMode: 'instant',
    fullscreenExitLimit: 0, fullscreenAbsenceLimitSeconds: 0, allowGuests: true, ...extra,
    questions: [
      { prompt: 'Pick B (one)', type: 'mcq', options: ['A', 'B', 'C'], correctOptions: ['1'] },
      { prompt: 'Pick C (two)', type: 'mcq', options: ['A', 'B', 'C'], correctOptions: ['2'] },
      { prompt: 'Pick A (three)', type: 'mcq', options: ['A', 'B', 'C'], correctOptions: ['0'] }
    ]
  });
  codes.push(test.code);
  return test.code;
}

await initializeDatabase();
try {
  /* 1. Thirty guests, one SAP ID, one instant. */
  {
    const code = await newTest(`Concurrency guests ${run}`);
    const shared = sap(1);
    const guests = Array.from({ length: 30 }, (_value, index) => {
      const email = `guest-${randomId(10).toLowerCase()}@guest.test`;
      emails.push(email);
      return { portalUser: { email, displayName: `Guest ${index}`, role: 'student' } };
    });
    // Each is signed in, so none of their seats reads as abandoned.
    await portalSessions().insertMany(guests.map((guest) => ({
      tokenHash: hash(randomId()), email: guest.portalUser.email, name: guest.portalUser.displayName, role: 'student',
      createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), revokedAt: null
    })));
    const outcomes = await Promise.allSettled(guests.map((guest) => registerForTest(guest, seatCookie(), code, { sapId: shared })));
    const won = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason?.status === 409).length;
    assert.equal(won, 1, `exactly one guest gets the SAP ID (got ${won})`);
    assert.equal(refused, 29, 'every other guest is told it is taken');
    assert.equal(await registrations().countDocuments({ testCode: code, sapId: shared, exitedAt: null }), 1, 'one active seat holds it');
    pass('30 guests racing for one SAP ID: exactly one seat');
  }

  /* 2. One student, twenty devices, one instant. */
  {
    const code = await newTest(`Concurrency devices ${run}`);
    const one = student('devices', 0);
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => registerForTest(one, seatCookie(), code, { sapId: sap(2) })));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1, 'one device registers');
    assert.equal(await registrations().countDocuments({ testCode: code, collegeEmail: one.portalUser.email }), 1, 'one registration for the account');
    pass('one student registering from 20 devices at once: one registration');
  }

  /* 3. Twenty presses of Begin at once. */
  {
    const code = await newTest(`Concurrency begin ${run}`);
    const one = student('begin', 0);
    const response = seatCookie();
    await registerForTest(one, response, code, { sapId: sap(3) });
    await bulkDecision(admin, code, 'approve');
    await startTest(admin, code);
    const seated = asSeated(one, code, response);
    const papers = await Promise.all(Array.from({ length: 20 }, () => startAttempt(seated, code, {})));
    assert.equal(new Set(papers.map((paper) => paper.id)).size, 1, 'every press gets the same paper');
    assert.equal(await registrations().countDocuments({ testCode: code, 'attempt.id': papers[0].id }), 1);
    pass('20 simultaneous Begin presses: one paper');
  }

  /* 4. The admin edits a question for everyone while students keep answering. */
  {
    const code = await newTest(`Concurrency edit ${run}`);
    const seats = [];
    for (let index = 0; index < 12; index += 1) {
      const request = student('edit', index);
      const response = seatCookie();
      await registerForTest(request, response, code, { sapId: sap(100 + index) });
      seats.push(asSeated(request, code, response));
    }
    await bulkDecision(admin, code, 'approve');
    await startTest(admin, code);
    const papers = await Promise.all(seats.map((seat) => startAttempt(seat, code, {})));
    const byPrompt = (paper, prefix) => paper.questions.find((question) => question.prompt.startsWith(prefix));
    const optionId = (question, text) => question.options.find((option) => option.text === text).id;

    // Students keep answering "Pick B (one)" over and over while the admin changes "Pick C (two)".
    let answering = true;
    const lastSent = new Map();
    const answerLoop = papers.map(async (paper, index) => {
      const question = byPrompt(paper, 'Pick B');
      let round = 0;
      while (answering || round < 3) {
        const text = ['A', 'B', 'C'][(index + round) % 3];
        await saveAnswer(seats[index], paper.id, { questionId: question.id, selectedOptions: [optionId(question, text)] });
        lastSent.set(index, text);
        round += 1;
      }
    });
    const editing = await testForEditing(admin, code);
    const edited = editing.questions.map((question) => ({
      id: question.id,
      prompt: question.prompt.startsWith('Pick C') ? 'Pick C (two) - reworded' : question.prompt,
      type: question.type,
      options: question.options,
      correctOptions: question.correctOptions
    }));
    await new Promise((resolve) => { setTimeout(resolve, 150); });
    const saved = await saveTestPaper(admin, code, { questions: edited, questionMix: { mcq: 3, msq: 0, short: 0 }, applyTo: 'everyone' });
    answering = false;
    await Promise.all(answerLoop);

    const doc = await testDocByCode(code);
    assert.ok(doc.questions.some((question) => question.prompt === 'Pick C (two) - reworded'), 'the edit is in the bank');
    for (const [index, seat] of seats.entries()) {
      const paper = await getAttempt(seat, code);
      const question = byPrompt(paper, 'Pick B');
      const stored = doc.registrations.find((entry) => entry.attempt?.id === paper.id).attempt.answers.find((answer) => answer.questionId === question.id);
      const text = question.options.find((option) => option.id === stored.selectedOptions[0])?.text;
      assert.equal(text, lastSent.get(index), `student ${index} keeps their last answer through the edit`);
      assert.ok(byPrompt(paper, 'Pick C (two) - reworded'), `student ${index} sees the reworded question`);
    }
    assert.equal(saved.paperSummary.edited, 1);
    pass('editing a question for everyone while 12 students answer: no answer lost, every paper updated');
  }

  /* 5. 150 students: answers, then a submit rush while the admin closes the test. */
  {
    const code = await newTest(`Concurrency rush ${run}`);
    const seats = [];
    await Promise.all(Array.from({ length: 150 }, async (_value, index) => {
      const request = student('rush', index);
      const response = seatCookie();
      await registerForTest(request, response, code, { sapId: sap(1_000 + index) });
      seats[index] = asSeated(request, code, response);
    }));
    await bulkDecision(admin, code, 'approve');
    await startTest(admin, code);
    const papers = await Promise.all(seats.map((seat) => startAttempt(seat, code, {})));
    const sent = papers.map(() => new Map());
    // Every student answers every question, all at once.
    await Promise.all(papers.map(async (paper, index) => {
      for (const question of paper.questions) {
        const pick = question.options[(index + question.id) % question.options.length];
        await saveAnswer(seats[index], paper.id, { questionId: question.id, selectedOptions: [pick.id] });
        sent[index].set(question.id, pick.id);
      }
    }));
    // Half press Submit while the admin presses Close - all in the same instant.
    const rush = await Promise.allSettled([
      ...papers.filter((_paper, index) => index % 2 === 0).map((paper) => submitAttemptForStudent(seats[papers.indexOf(paper)], paper.id)),
      closeTest(admin, code)
    ]);
    const failed = rush.filter((outcome) => outcome.status === 'rejected');
    assert.equal(failed.length, 0, `nothing fails in the rush (${failed.map((outcome) => outcome.reason?.message).join('; ')})`);

    const doc = await testDocByCode(code);
    assert.equal(doc.isClosed, true, 'the test is closed');
    const key = new Map(doc.questions.map((question) => [question.id, (question.correctOptions || []).map(String)]));
    for (const [index, paper] of papers.entries()) {
      const attempt = doc.registrations.find((entry) => entry.attempt?.id === paper.id).attempt;
      assert.equal(attempt.status, 'submitted', `student ${index} is submitted`);
      assert.equal(attempt.submittedBy, index % 2 === 0 ? attempt.submittedBy : 'admin', `student ${index} was closed by the admin or submitted themselves`);
      for (const answer of attempt.answers) {
        assert.deepEqual(answer.selectedOptions, [sent[index].get(answer.questionId)], `student ${index} q${answer.questionId}: the answer sent`);
        const expected = Number(key.get(answer.questionId).length === 1 && key.get(answer.questionId)[0] === String(answer.selectedOptions[0]));
        assert.equal(answer.isCorrect, expected, `student ${index} q${answer.questionId}: marked right`);
      }
    }
    pass('150 students: answers at once, then a submit rush during Close - every paper submitted once, exact and marked right');
  }

  console.log(`\n  Concurrency check passed: ${checks} scenarios.\n`);
} catch (error) {
  console.error(`\n  Concurrency check FAILED: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (codes.length) {
    await tests().deleteMany({ code: { $in: codes } });
    await registrations().deleteMany({ testCode: { $in: codes } });
  }
  await studentProfiles().deleteMany({ email: { $in: emails } });
  await portalSessions().deleteMany({ email: { $in: emails } });
  await closeDatabase();
}
