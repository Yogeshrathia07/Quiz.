import { oneLine } from './rich-text.js';
import { roundMarks } from './marks.js';
import { classAnalysisText } from './class-analysis.js';

/**
 * One student's results email (services/result-mail-service.js): their marks
 * and their rank in the class, and - as the teacher chooses - their answers
 * question by question, the correct answers, the class average/highest mark,
 * and an optional aggregate class-analysis PNG. Only ever their own paper;
 * no other student's identity or individual marks.
 *
 * Built twice over, as HTML and as plain text, from the same lines. The HTML
 * is plain tables with inline styles - what email programs show alike - on
 * white, and every word a person typed (names, titles, questions, answers) is
 * escaped. Question text is cut to a line or two, so a long paper still fits
 * under the size at which Gmail cuts an email short.
 */

const PROMPT_CHARS = 160;
const ANSWER_CHARS = 220;

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const cut = (value, chars) => {
  const text = oneLine(value).trim();
  return text.length > chars ? `${text.slice(0, chars - 1).trimEnd()}…` : text;
};
const marksText = (value) => String(roundMarks(value));
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const bool = (value, fallback) => typeof value === 'boolean' ? value : fallback;

/** Only explicit booleans are accepted; old queued emails never gain an attachment. */
export function resultMailOptions(raw) {
  const options = raw && typeof raw === 'object' ? raw : {};
  const answers = bool(options.answers, true);
  return { answers, correct: answers && bool(options.correct, true), classStats: bool(options.classStats, false), analysisImage: bool(options.analysisImage, false) };
}

/** A date and time as the class reads it. */
export const mailDateTime = (value) => (value ? new Date(value).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
}) : '');

/** Minutes (and seconds) taken, in words. */
const takenText = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return minutes ? `${minutes} min${rest ? ` ${rest} s` : ''}` : `${rest} s`;
};

// Each checked against what it sits on (white, or the marks panel): at least 4.5:1.
const COLOURS = { text: '#1F2933', soft: '#4B5563', line: '#E5E7EB', brand: '#0B7BBD', score: '#0F6FA6', ok: '#1E7A51', warn: '#8A5A00', panel: '#F3F6F9' };

/**
 * `paper`: { title, code }; `student`: { name }; `marks`: { score, totalMarks,
 * pendingMarks, pendingManual }; `answers`: the paper's answers
 * (presenters.studentResponseData); `rank`: { rank, papers } - where this
 * paper stands among every paper handed in, shared by equal marks - or null;
 * `classStats`: { averagePercent, highestPercent, papers } or null;
 * `options`: { answers, correct, classStats, analysisImage }; `analysisImage`
 * is a server-generated aggregate plus its PNG attachment, never client data.
 * `teacher` and `teacherEmail`
 * (the faculty member's name and address, shown with the details), `link`,
 * `submittedAt`, `takenSeconds` as known. Each answer shows what was given and
 * the marks it earned - no right or wrong labels; a short answer still to be
 * marked says so.
 */
export function buildResultMail({ paper, student, marks, answers = [], rank = null, classStats = null, analysisImage = null, options = {}, teacher = '', teacherEmail = '', link = '', submittedAt = null, takenSeconds = null }) {
  // The faculty member's address, to write to them: only one that looks like an address.
  const facultyEmail = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(String(teacherEmail).trim()) ? String(teacherEmail).trim() : '';
  const score = marksText(marks.score);
  const total = marksText(marks.totalMarks);
  const percent = Number(marks.totalMarks) > 0 ? Math.round((Number(marks.score) / Number(marks.totalMarks)) * 100) : 0;
  const firstName = String(student.name || '').trim().split(/\s+/)[0] || 'there';
  const subject = `Your marks: ${cut(paper.title, 90)} - ${score} / ${total}`;
  // Always, once the class is known - "Rank 1 of 1" too, so the line never just goes missing.
  const rankLine = rank && rank.papers >= 1 ? `Rank ${rank.rank} of ${rank.papers}` : '';
  const pending = marks.pendingManual > 0
    ? `${plural(marks.pendingManual, 'answer')} still to be marked by your teacher (worth ${marksText(marks.pendingMarks)} more marks).` : '';
  const showClass = options.classStats && classStats && classStats.papers >= 1;
  const classLine = showClass ? `Class average ${Math.round(classStats.averagePercent)}% · highest ${Math.round(classStats.highestPercent)}% (${plural(classStats.papers, 'paper')})` : '';
  const showImage = options.analysisImage === true && analysisImage?.analysis && analysisImage?.attachment;
  const analysisLines = showImage ? classAnalysisText(analysisImage.analysis).split('\n') : [];
  const facts = [
    ['Test', cut(paper.title, 120)],
    teacher && ['Teacher', cut(teacher, 80)],
    facultyEmail && ["Teacher's email", facultyEmail, `mailto:${facultyEmail}`],
    submittedAt && ['Handed in', mailDateTime(submittedAt)],
    takenText(takenSeconds) && ['Time taken', takenText(takenSeconds)]
  ].filter(Boolean);
  const rows = options.answers ? answers.map((answer) => {
    const waiting = answer.manualGrading && answer.answered && answer.isCorrect === null;
    const showKey = options.correct && !answer.manualGrading && answer.isCorrect !== true && answer.correctAnswer;
    return {
      number: answer.questionNumber,
      prompt: cut(answer.prompt, PROMPT_CHARS) || 'A question with a picture',
      given: answer.answered ? cut(answer.selectedAnswer, ANSWER_CHARS) : 'Not answered',
      waiting,
      key: showKey ? cut(answer.correctAnswer, ANSWER_CHARS) : '',
      marks: waiting ? `– / ${marksText(answer.maxMarks)}` : `${marksText(answer.marks)} / ${marksText(answer.maxMarks)}`
    };
  }) : [];

  const text = [
    `Hi ${firstName},`,
    '',
    `Your marks for ${cut(paper.title, 120)} are out.`,
    '',
    // The marks block, without gaps where a line is not there.
    ...[`Marks: ${score} / ${total} (${percent}%)`, rankLine, pending, classLine].filter(Boolean),
    '',
    ...facts.map(([label, value]) => `${label}: ${value}`),
    ...(showImage ? ['', ...analysisLines, `Image attached: ${analysisImage.attachment.name}`] : []),
    ...(rows.length ? ['', 'Your answers', ...rows.flatMap((row) => [
      '',
      `${row.number}. ${row.prompt}`,
      `   Your answer: ${row.given}${row.waiting ? ' (not marked yet)' : ''} - ${row.marks}`,
      ...(row.key ? [`   Correct answer: ${row.key}`] : [])
    ])] : []),
    '',
    link ? `See your full result: ${link}` : '',
    '',
    'You got this email because you took this test.'
  ].filter((line, index, list) => line !== '' || list[index - 1] !== '').join('\n').trim();

  const c = COLOURS;
  const cell = `padding:8px 0;border-top:1px solid ${c.line};vertical-align:top;font-size:14px;line-height:1.45;color:${c.text}`;
  const answerRows = rows.map((row) => `
    <tr>
      <td style="${cell};width:32px;font-weight:700;color:${c.soft}">${row.number}.</td>
      <td style="${cell}">
        <div style="font-weight:600">${escapeHtml(row.prompt)}</div>
        <div style="margin-top:4px;color:${c.soft}">Your answer: <span style="color:${c.text}">${escapeHtml(row.given)}</span>${row.waiting ? ` <span style="color:${c.warn}">(not marked yet)</span>` : ''}</div>
        ${row.key ? `<div style="margin-top:2px;color:${c.soft}">Correct answer: <span style="color:${c.ok};font-weight:600">${escapeHtml(row.key)}</span></div>` : ''}
      </td>
      <td style="${cell};width:72px;text-align:right;white-space:nowrap;font-weight:700">${escapeHtml(row.marks)}</td>
    </tr>`).join('');
  const factRows = facts.map(([label, value, href]) => `
    <tr><td style="padding:3px 16px 3px 0;color:${c.soft};font-size:13px;white-space:nowrap">${escapeHtml(label)}</td>
      <td style="padding:3px 0;color:${c.text};font-size:13px">${href ? `<a href="${escapeHtml(href)}" style="color:${c.brand};text-decoration:underline">${escapeHtml(value)}</a>` : escapeHtml(value)}</td></tr>`).join('');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:0;background:#FFFFFF;color:${c.text};font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FFFFFF">
    <tr><td align="center" style="padding:24px 12px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
        <tr><td style="font-size:15px;line-height:1.5;color:${c.text}">
          <p style="margin:0 0 12px">Hi ${escapeHtml(firstName)},</p>
          <p style="margin:0 0 16px">Your marks for <strong>${escapeHtml(cut(paper.title, 120))}</strong> are out.</p>
        </td></tr>
        <tr><td style="background:${c.panel};border-radius:12px;padding:18px 20px">
          <div style="font-size:13px;color:${c.soft};font-weight:600">Your marks</div>
          <div style="font-size:30px;font-weight:800;color:${c.score};line-height:1.2;margin-top:2px">${escapeHtml(score)} / ${escapeHtml(total)} <span style="font-size:18px;color:${c.soft};font-weight:700">(${percent}%)</span></div>
          ${rankLine ? `<div style="margin-top:6px;font-size:15px;font-weight:700;color:${c.text}">${escapeHtml(rankLine)}</div>` : ''}
          ${pending ? `<div style="margin-top:6px;font-size:13px;color:${c.warn}">${escapeHtml(pending)}</div>` : ''}
          ${classLine ? `<div style="margin-top:6px;font-size:13px;color:${c.soft}">${escapeHtml(classLine)}</div>` : ''}
        </td></tr>
        <tr><td style="padding:16px 0 0"><table role="presentation" cellpadding="0" cellspacing="0">${factRows}</table></td></tr>
        ${showImage ? `<tr><td style="padding:20px 0 0;font-size:14px;line-height:1.5;color:${c.text}">
          <strong>Class analysis image attached</strong>
          <p style="margin:6px 0 0;color:${c.soft}">The PNG attachment contains the whole class summary, score bands and marks distribution — all questions, without student names or individual results.</p>
          <p style="margin:6px 0 0;color:${c.soft}">${escapeHtml(analysisLines.slice(1, 6).join(' · '))}</p>
        </td></tr>` : ''}
        ${rows.length ? `<tr><td style="padding:22px 0 4px;font-size:16px;font-weight:700;color:${c.text}">Your answers</td></tr>
        <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${answerRows}</table></td></tr>` : ''}
        ${link ? `<tr><td style="padding:24px 0 8px"><a href="${escapeHtml(link)}" target="_blank" rel="noopener" style="display:inline-block;background:${c.brand};color:#FFFFFF;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:999px">See your full result</a></td></tr>` : ''}
        <tr><td style="padding:20px 0 0;border-top:1px solid ${c.line};font-size:12px;line-height:1.5;color:${c.soft}">
          You got this email because you took this test.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  return { subject, text, html, ...(showImage ? { attachments: [analysisImage.attachment] } : {}) };
}
