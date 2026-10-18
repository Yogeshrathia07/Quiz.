import assert from 'node:assert/strict';
import test from 'node:test';
import { classAnalysisOf, classAnalysisText } from '../src/domain/class-analysis.js';
import { cacheAnalysisImages, classAnalysisSvg, createResultAnalysisImage } from '../src/domain/result-mail-image.js';
import { compute } from '../client/src/screens/admin/analysis-compute.js';

const question = { id: 'q1', type: 'msq', marks: 30 };
const paper = (score, { given = true, status = 'submitted' } = {}) => ({
  fullName: 'PRIVATE STUDENT NAME', collegeEmail: 'private@example.test', sapId: 'PRIVATE-SAP', status: 'approved',
  attempt: { status, answers: [{ questionId: question.id, isCorrect: score, answeredAt: given ? '2026-10-16T08:00:00Z' : null }] }
});
const quiz = (scores) => ({ title: 'Sample quiz', code: 'TEST-IMAGE', questions: [question], registrations: scores.map((value) => paper(value)) });

test('class-image figures and bins agree with the Analysis page, including zero and pending papers', () => {
  const scores = [0, 3, 9, 15, 21, 24, 27, 30, null];
  const doc = quiz(scores);
  doc.registrations.push({ status: 'approved' }, paper(5, { status: 'in_progress' }));
  const analysis = classAnalysisOf(doc);
  const matrix = {
    questions: [{ id: 'q1', worth: 30 }], people: { began: 10, absent: 1 },
    students: scores.map((score, index) => ({ id: String(index), name: `Student ${index}`, st: score === null ? 'Q' : score === 30 ? 'O' : score === 0 ? 'W' : 'P', pm: { 0: score }, seconds: index }))
  };
  const view = compute(matrix, { selected: new Set([0]), bins: null, byMarks: true, maxBars: 12 });
  for (const key of ['attempted', 'absent', 'counted', 'pendingPapers', 'fullMarks', 'average', 'median', 'highest', 'lowest', 'averageMarks', 'medianMarks', 'highestMarks', 'lowestMarks']) {
    assert.equal(analysis[key], view.stats[key], key);
  }
  assert.deepEqual(analysis.bands, view.bands.map(({ id, label, count, share }) => ({ id, label, count, share })));
  assert.deepEqual(analysis.histogram.bins, view.histogram.bins);
  assert.equal(analysis.bands.find((band) => band.id === '30').count, 1, '30% starts its band');
  assert.equal(analysis.histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 8, 'pending paper excluded');
  assert.equal(/PRIVATE|private@example/.test(JSON.stringify(analysis)), false, 'aggregate data has no student identifiers');
});

test('different paper totals use percentages, with blank answers distinct from pending marking', () => {
  const doc = { title: 'Mixed papers', code: 'MIX', questions: [{ id: 'a', marks: 10 }, { id: 'b', marks: 20 }], registrations: [
    { attempt: { status: 'submitted', answers: [{ questionId: 'a', isCorrect: 10, answeredAt: true }, { questionId: 'b', isCorrect: 0, answeredAt: true }] } },
    { attempt: { status: 'submitted', answers: [{ questionId: 'a', isCorrect: 5, answeredAt: true }] } },
    { attempt: { status: 'submitted', answers: [{ questionId: 'a', isCorrect: null, answeredAt: true }] } },
    { attempt: { status: 'submitted', answers: [{ questionId: 'a', isCorrect: null, answeredAt: null }] } }
  ] };
  const analysis = classAnalysisOf(doc);
  assert.equal(analysis.counted, 3);
  assert.equal(analysis.pendingPapers, 1);
  assert.equal(analysis.average, 27.8);
  assert.equal(analysis.median, 33.3);
  assert.equal(analysis.fullMarks, null);
  assert.equal(analysis.histogram.unit, 'percent');
  assert.equal(analysis.histogram.bins.reduce((sum, bin) => sum + bin.count, 0), 3);
  assert.match(classAnalysisText(analysis), /Average: 27.8%/);
});

test('fractional marks, duplicate answer records and empty classes stay finite and private', () => {
  const doc = quiz([0.5]);
  doc.registrations[0].attempt.answers.unshift({ questionId: 'q1', isCorrect: 30, answeredAt: true });
  const a = classAnalysisOf(doc);
  assert.equal(a.highestMarks, 0.5, 'the final answer record wins, as in the Analysis matrix');
  assert.equal(a.fullMarks, 30);
  assert.equal(a.histogram.fractions, true);
  for (const registrations of [[], [paper(null)], [{ status: 'approved' }]]) {
    const analysis = classAnalysisOf({ ...doc, registrations });
    const svg = classAnalysisSvg({ title: 'Quiz </text><script>alert(1)</script>', code: 'X<&', analysis });
    assert.equal(/NaN|Infinity|<script>|undefined/.test(svg), false);
    assert.match(svg, /No fully marked papers yet/);
    assert.equal(svg.includes('PRIVATE STUDENT NAME'), false);
  }
});

test('the image is a bounded real PNG with a safe attachment name', async () => {
  const image = await createResultAnalysisImage({ ...quiz([0, 9, 15, 24, 30, null]), code: '../../TEST\r\nBAD' });
  const png = Buffer.from(image.attachment.content, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1400);
  assert.equal(png.readUInt32BE(20), 914);
  assert.ok(png.byteLength > 10_000 && png.byteLength < 1024 * 1024, `${png.byteLength} PNG bytes`);
  assert.match(image.attachment.name, /^class-analysis-[a-zA-Z0-9_-]+\.png$/);
});

test('one image render is shared across recipients, failures can retry, and a fresh snapshot refreshes it', async () => {
  let count = 0;
  const cached = cacheAnalysisImages(async () => { count += 1; return { image: count }; });
  const snapshot = {};
  const first = cached({ code: 'A' }, snapshot);
  assert.equal(cached({ code: 'A' }, snapshot), first);
  await Promise.all([first, cached({ code: 'A' }, snapshot)]);
  assert.equal(count, 1);
  await cached({ code: 'A' }, {});
  await cached({ code: 'B' }, snapshot);
  assert.equal(count, 3, 'new snapshot or different test never reuses the old image');
  let calls = 0;
  const failing = cacheAnalysisImages(async () => { if (++calls === 1) throw new Error('renderer failed'); return 'ok'; });
  await assert.rejects(failing({ code: 'A' }, snapshot), /renderer failed/);
  assert.equal(await failing({ code: 'A' }, snapshot), 'ok');
});
