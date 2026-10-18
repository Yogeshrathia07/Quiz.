import { earnedMarks, questionMarks, roundMarks } from './marks.js';
import { BANDS, markBars } from './analysis-bands.js';

const round1 = (value) => value === null ? null : Math.round(value * 10) / 10;
const mean = (values) => values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
const median = (values) => {
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
};
const number = (value) => value === null || !Number.isFinite(Number(value)) ? '—' : String(Math.round(Number(value) * 10) / 10);

export function classAnalysisText(analysis) {
  const mark = (key) => analysis[key] === null ? 'Not available' : analysis.fullMarks === null ? `${number(analysis[key])}%` : `${number(analysis[`${key}Marks`])} / ${number(analysis.fullMarks)} (${number(analysis[key])}%)`;
  const histogram = analysis.histogram;
  return [
    'Class analysis (whole class, all questions)',
    `Attempted: ${analysis.attempted}; absent: ${analysis.absent}; still to mark: ${analysis.pendingPapers}.`,
    ...['average', 'median', 'highest', 'lowest'].map((key) => `${key[0].toUpperCase()}${key.slice(1)}: ${mark(key)}`),
    ...analysis.bands.map((band) => `${band.label}: ${band.count} (${band.share}%)`),
    `Marks distribution (${histogram.unit === 'marks' ? `out of ${number(analysis.fullMarks)}` : 'percentages'}):`,
    ...histogram.bins.map((bin) => `${binLabel(bin, histogram)}: ${bin.count}`),
    'Pending papers are excluded from score statistics and the marks chart.'
  ].join('\n');
}

export function binLabel(bin, histogram) {
  if (histogram.unit === 'percent') return `${number(bin.from)}–${number(bin.to)}%`;
  if (histogram.fractions) return bin.last ? `${number(bin.from)}–${number(bin.to)}` : `${number(bin.from)}–<${number(bin.to)}`;
  const end = bin.last ? bin.to : bin.to - 1;
  return bin.from === end ? number(bin.from) : `${number(bin.from)}–${number(end)}`;
}


/** Whole class, all questions, no identifying fields. Pending papers never count as zero. */
export function classAnalysisOf(test) {
  const bank = new Map((test.questions || []).map((question) => [question.id, question]));
  const papers = [];
  let attempted = 0; let absent = 0; let pending = 0;
  for (const registration of test.registrations || []) {
    const attempt = registration.attempt;
    if (!attempt) {
      if (registration.status === 'approved') absent += 1;
      continue;
    }
    attempted += 1;
    if (attempt.status !== 'submitted') continue;
    let score = 0; let max = 0; let waiting = false;
    for (const answer of new Map((attempt.answers || []).map((answer) => [answer.questionId, answer])).values()) {
      const question = bank.get(answer.questionId);
      if (!question) continue;
      const worth = questionMarks(test, question);
      max += worth;
      if (!answer.answeredAt) continue;
      const earned = earnedMarks(answer);
      if (earned === null) waiting = true;
      else score += Math.min(worth, Math.max(0, earned));
    }
    if (!max) continue;
    if (waiting) { pending += 1; continue; }
    papers.push({ score: roundMarks(score), max: roundMarks(max), percent: (roundMarks(score) / roundMarks(max)) * 100 });
  }
  const percents = papers.map((paper) => paper.percent).sort((a, b) => a - b);
  const scores = papers.map((paper) => paper.score).sort((a, b) => a - b);
  const maxes = new Set(papers.map((paper) => paper.max));
  const fullMarks = maxes.size === 1 ? [...maxes][0] : null;
  const total = papers.length + pending;
  const bands = BANDS.map(({ id, label, from, to }) => ({ id, label, count: percents.filter((value) => value >= from && value < to).length }));
  bands.push({ id: 'pending', label: 'Still to mark', count: pending });
  const scale = fullMarks > 0 ? markBars(fullMarks, null, 12) : null;
  const bins = scale ? scale.bars : Array.from({ length: 10 }, (_, index) => ({ index, unit: 'percent', from: index * 10, to: (index + 1) * 10, last: index === 9, count: 0 }));
  for (const paper of papers) {
    const index = scale ? Math.floor((paper.score + 1e-9) / scale.step) : Math.floor(paper.percent / 10);
    bins[Math.max(0, Math.min(bins.length - 1, index))].count += 1;
  }
  return {
    attempted, absent, counted: papers.length, pendingPapers: pending, fullMarks,
    average: round1(mean(percents)), median: round1(median(percents)),
    highest: round1(percents.at(-1) ?? null), lowest: round1(percents[0] ?? null),
    averageMarks: fullMarks === null ? null : round1(mean(scores)), medianMarks: fullMarks === null ? null : round1(median(scores)),
    highestMarks: fullMarks === null ? null : scores.at(-1) ?? null, lowestMarks: fullMarks === null ? null : scores[0] ?? null,
    bands: bands.map((band) => ({ ...band, share: total ? Math.round((band.count / total) * 100) : 0 })),
    histogram: { unit: scale ? 'marks' : 'percent', bins, step: scale?.step ?? 10, top: scale?.top ?? 100, fractions: papers.some((paper) => Math.abs(paper.score - Math.round(paper.score)) > 1e-9) }
  };
}
