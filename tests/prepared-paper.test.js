import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAttempt, paperBasis } from '../src/services/attempt-service.js';

const question = (id, type = 'mcq', options = ['a', 'b', 'c']) => ({ id, type, prompt: `Q${id}`, options, correctOptions: ['0'] });
const quiz = (extra = {}) => ({
  code: 'TEST-READY1', questions: [question(1), question(2), question(3, 'msq'), question(4)],
  questionMix: { mcq: 2, msq: 1, short: 0 }, questionCount: 3, shuffleQuestions: true, questionDraw: 'random', ...extra
});
const student = { id: 'r1', sapId: '500100200', collegeEmail: 'a@stu.example.edu' };

test('the basis stays the same when nothing a paper is made from changes', () => {
  assert.equal(paperBasis(quiz(), student), paperBasis(quiz(), { ...student }));
  const reworded = quiz({ questions: quiz().questions.map((entry) => ({ ...entry, prompt: `${entry.prompt} (reworded)` })) });
  assert.equal(paperBasis(reworded, student), paperBasis(quiz(), student), 'new wording reaches the paper anyway: it is read when shown');
});

test('the basis changes with anything a paper is made from', () => {
  const base = paperBasis(quiz(), student);
  const changes = {
    'a question added': quiz({ questions: [...quiz().questions, question(5)] }),
    'a question retired': quiz({ questions: quiz().questions.map((entry) => (entry.id === 2 ? { ...entry, retired: true } : entry)) }),
    'an option added': quiz({ questions: quiz().questions.map((entry) => (entry.id === 1 ? { ...entry, options: [...entry.options, 'd'] } : entry)) }),
    'a question made short-answer': quiz({ questions: quiz().questions.map((entry) => (entry.id === 3 ? { ...entry, manualGrading: true } : entry)) }),
    'the mix': quiz({ questionMix: { mcq: 3, msq: 0, short: 0 } }),
    'the shuffle': quiz({ shuffleQuestions: false }),
    'the draw': quiz({ questionDraw: 'spread' })
  };
  for (const [what, changed] of Object.entries(changes)) assert.notEqual(paperBasis(changed, student), base, what);
  assert.notEqual(paperBasis(quiz(), { ...student, sapId: '500100201' }), base, 'a corrected SAP ID');
});

test('a paper made ahead is handed out as it is, under a fresh attempt', () => {
  const fresh = buildAttempt(null, quiz(), student);
  const made = buildAttempt(null, quiz(), student, { questions: fresh.questions, answers: fresh.answers });
  assert.deepEqual(made.questions, fresh.questions);
  assert.deepEqual(made.answers, fresh.answers);
  assert.equal(made.seed, fresh.seed);
  assert.notEqual(made.id, fresh.id);
  assert.equal(made.status, 'in_progress');
});
