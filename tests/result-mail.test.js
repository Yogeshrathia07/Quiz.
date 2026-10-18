import assert from 'node:assert/strict';
import test from 'node:test';
import { buildResultMail, resultMailOptions } from '../src/domain/result-mail.js';
import { classAnalysisOf } from '../src/domain/class-analysis.js';

const answers = [
  { questionNumber: 1, prompt: 'Which structure is **FIFO**?', answered: true, selectedAnswer: 'Queue', correctAnswer: 'Queue', isCorrect: true, partial: false, marks: 1, maxMarks: 1, manualGrading: false },
  { questionNumber: 2, prompt: 'Pick the stable sorts.', answered: true, selectedAnswer: 'Merge, Quick', correctAnswer: 'Merge, Insertion', isCorrect: false, partial: false, marks: 0, maxMarks: 2, manualGrading: false },
  { questionNumber: 3, prompt: 'Explain a <script>alert(1)</script> collision.', answered: true, selectedAnswer: '<b>keys</b> clash', correctAnswer: '', isCorrect: null, partial: false, marks: 0, maxMarks: 5, manualGrading: true },
  { questionNumber: 4, prompt: 'What is a heap?', answered: false, selectedAnswer: 'No answer', correctAnswer: 'A tree', isCorrect: false, partial: false, marks: 0, maxMarks: 1, manualGrading: false }
];
const base = {
  paper: { title: 'Data <Structures> Quiz', code: 'TEST-ABCDE' },
  student: { name: 'Aarav "Ace" Sharma' },
  marks: { score: 1, totalMarks: 9, pendingMarks: 5, pendingManual: 1 },
  rank: { rank: 3, papers: 30 },
  answers,
  classStats: { averagePercent: 41.6, highestPercent: 88, papers: 30 },
  teacher: 'Dr. Mehta',
  teacherEmail: 'yogesh.sharma@ddn.college.test',
  link: 'https://quiz.example/?result=TEST-ABCDE',
  submittedAt: '2026-10-15T05:00:00.000Z',
  takenSeconds: 1620
};

test('a results email: the marks, then what the teacher chose - and every word typed is escaped', () => {
  const mail = buildResultMail({ ...base, options: { answers: true, correct: true, classStats: true } });
  assert.equal(mail.subject, 'Your marks: Data <Structures> Quiz - 1 / 9');
  assert.ok(mail.html.includes('Data &lt;Structures&gt; Quiz'), 'the title escaped in the HTML');
  assert.equal(/<script>|<b>keys/.test(mail.html), false, 'no question or answer can add markup');
  assert.ok(mail.html.includes('&lt;b&gt;keys&lt;/b&gt; clash'));
  assert.ok(mail.text.includes('Hi Aarav,'), 'by first name');
  assert.ok(mail.text.includes('Marks: 1 / 9 (11%)'));
  assert.ok(mail.text.includes('Rank 3 of 30') && mail.html.includes('Rank 3 of 30'), 'their rank in the class');
  assert.equal(/(right|wrong)|✓|✗/i.test(mail.text + mail.html), false, 'no right or wrong marks on the answers');
  assert.equal(/Questions about your marks/.test(mail.text + mail.html), false);
  assert.ok(mail.text.includes('1 answer still to be marked by your teacher (worth 5 more marks).'));
  assert.ok(mail.text.includes('Class average 42% · highest 88% (30 papers)'));
  assert.ok(mail.text.includes('1. Which structure is FIFO?'), 'question text without its formatting marks');
  assert.ok(mail.text.includes('Correct answer: Merge, Insertion'), 'the key beside what was not right');
  assert.equal(mail.text.includes('Correct answer: Queue'), false, 'not beside what was right');
  assert.ok(mail.text.includes('(not marked yet)') && mail.text.includes('– / 5'), 'a short answer not marked yet is never 0');
  assert.ok(mail.html.includes('target="_blank"'), 'the result link opens on its own');
  assert.ok(mail.text.includes('Time taken: 27 min'));
  assert.ok(mail.text.includes("Teacher's email: yogesh.sharma@ddn.college.test"), 'the faculty email with the details');
  assert.ok(mail.html.includes('href="mailto:yogesh.sharma@ddn.college.test"'), 'a link to write to them');
  const odd = buildResultMail({ ...base, teacherEmail: 'x" onmouseover="alert(1)', options: {} });
  assert.equal(odd.text.includes("Teacher's email") || odd.html.includes('onmouseover'), false, 'anything that is not an address is left out');
  assert.ok(mail.text.includes('See your full result: https://quiz.example/?result=TEST-ABCDE'));
  assert.ok(mail.html.includes('href="https://quiz.example/?result=TEST-ABCDE"'));
});

test('a results email holds only what was chosen', () => {
  const marksOnly = buildResultMail({ ...base, options: { answers: false, correct: false, classStats: false } });
  assert.equal(/Your answers|Correct answer|Class average/.test(marksOnly.text + marksOnly.html), false);
  const noKey = buildResultMail({ ...base, options: { answers: true, correct: false, classStats: false } });
  assert.ok(noKey.text.includes('Your answers'));
  assert.equal(noKey.text.includes('Correct answer'), false, 'the answers, without the key');
  const alone = buildResultMail({ ...base, rank: { rank: 1, papers: 1 }, classStats: { averagePercent: 50, highestPercent: 50, papers: 1 }, options: { classStats: true } });
  assert.ok(alone.text.includes('Rank 1 of 1') && alone.text.includes('Class average 50% · highest 50% (1 paper)'), 'one paper: still its rank, and the class line when chosen');
  assert.equal(buildResultMail({ ...base, options: { classStats: false } }).text.includes('Class average'), false, 'the class line only when chosen');
  assert.equal(buildResultMail({ ...base, rank: null, options: {} }).text.includes('Rank'), false, 'no rank known: none shown');
  const noLink = buildResultMail({ ...base, link: '', options: {} });
  assert.equal(noLink.text.includes('See your full result') || noLink.html.includes('See your full result'), false, 'no address for the site: no result button');
});

test('a long question is cut to a line or two, so a big paper still fits one email', () => {
  const long = { ...answers[0], prompt: 'word '.repeat(200) };
  const mail = buildResultMail({ ...base, answers: Array.from({ length: 100 }, (_v, index) => ({ ...long, questionNumber: index + 1 })), options: { answers: true, correct: true } });
  assert.ok(mail.text.split('\n').every((line) => line.length < 260));
  assert.ok(Buffer.byteLength(mail.html) < 100 * 1024, `under Gmail's clipping size (${Buffer.byteLength(mail.html)} bytes)`);
});

test('class analysis is off by default and only explicit boolean options survive queuing', () => {
  for (const raw of [undefined, null, {}, { analysisImage: 'true', classStats: 1 }]) {
    assert.deepEqual(resultMailOptions(raw), { answers: true, correct: true, classStats: false, analysisImage: false });
  }
  assert.deepEqual(resultMailOptions({ answers: false, correct: true, analysisImage: true, arbitraryImage: 'ignored' }), { answers: false, correct: false, classStats: false, analysisImage: true });
});

test('the PNG and its text alternative appear only when the admin chooses the new option', () => {
  const analysisImage = { analysis: classAnalysisOf({ questions: [], registrations: [] }), attachment: { name: 'class-analysis-TEST.png', content: 'PNGBASE64' } };
  const off = buildResultMail({ ...base, analysisImage, options: { answers: false, analysisImage: false } });
  assert.equal(off.attachments, undefined);
  assert.equal(off.text.includes('Class analysis'), false);
  const on = buildResultMail({ ...base, analysisImage, options: { answers: false, analysisImage: true } });
  assert.deepEqual(on.attachments, [analysisImage.attachment]);
  assert.match(on.text, /Image attached: class-analysis-TEST\.png/);
  assert.match(on.text, /Pending papers are excluded/);
  assert.match(on.html, /Class analysis image attached/);
  assert.equal(on.html.includes('data:image') || on.html.includes('cid:'), false, 'the provider receives a real attachment, not an unsupported inline image');
  assert.equal(on.html.includes('Your answers'), false, 'the image works independently of answer inclusion');
});
