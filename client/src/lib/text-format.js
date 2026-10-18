/**
 * The question editor's formatting buttons, as plain text edits (the marks
 * are described in src/domain/rich-text.js). Each takes the text and the
 * selection and returns the new text with the selection to restore.
 */
const ANY_MARKER = /^[ \t]*([-*•]|\d{1,3}[.)])[ \t]+/;
const BULLET_MARKER = /^[ \t]*[-*•][ \t]+/;
const NUMBER_MARKER = /^[ \t]*\d{1,3}[.)][ \t]+/;

/** A question's words on one line, without its formatting marks: the question list in the editor shows this. */
export const promptPreview = (text) => String(text || '')
  .replace(/\*\*/g, '')
  .replace(/^[ \t]*([-*•]|\d{1,3}[.)])[ \t]+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

/** Bold on the selection - or off, if it is bold already. With nothing selected, a placeholder to type over. */
export function toggleBold(text, start, end) {
  const before = text.slice(0, start);
  const selected = text.slice(start, end);
  const after = text.slice(end);
  if (before.endsWith('**') && after.startsWith('**')) {
    return { text: before.slice(0, -2) + selected + after.slice(2), start: start - 2, end: end - 2 };
  }
  if (selected.length > 4 && selected.startsWith('**') && selected.endsWith('**')) {
    const inner = selected.slice(2, -2);
    return { text: before + inner + after, start, end: start + inner.length };
  }
  const word = selected || 'bold text';
  return { text: `${before}**${word}**${after}`, start: start + 2, end: start + 2 + word.length };
}

/**
 * The lines the selection touches become a bullet list or a numbered list -
 * or plain lines again, when every one of them already is that list.
 */
export function toggleList(text, start, end, kind) {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const stop = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const newline = text.indexOf('\n', stop);
  const lineEnd = newline === -1 ? text.length : newline;
  const lines = text.slice(lineStart, lineEnd).split('\n');
  // An empty line: start the list there, ready to type.
  if (lines.length === 1 && !lines[0].trim()) {
    const marker = kind === 'bullet' ? '- ' : '1. ';
    const next = text.slice(0, lineStart) + marker + text.slice(lineEnd);
    return { text: next, start: lineStart + marker.length, end: lineStart + marker.length };
  }
  const own = kind === 'bullet' ? BULLET_MARKER : NUMBER_MARKER;
  const already = lines.every((line) => !line.trim() || own.test(line));
  let number = 0;
  const changed = lines.map((line) => {
    if (!line.trim()) return line;
    const bare = line.replace(ANY_MARKER, '');
    if (already) return bare;
    number += 1;
    return kind === 'bullet' ? `- ${bare}` : `${number}. ${bare}`;
  }).join('\n');
  return { text: text.slice(0, lineStart) + changed + text.slice(lineEnd), start: lineStart, end: lineStart + changed.length };
}

/**
 * Enter at the end of a list item starts the next one ("- ", or the next
 * number); Enter on an item left empty ends the list. Null: a plain Enter.
 */
export function continueList(text, caret) {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  const newline = text.indexOf('\n', caret);
  const lineEnd = newline === -1 ? text.length : newline;
  if (caret !== lineEnd) return null;
  const line = text.slice(lineStart, lineEnd);
  const bullet = /^([ \t]*[-*•][ \t]+)(.*)$/.exec(line);
  const numbered = /^([ \t]*)(\d{1,3})([.)])[ \t]+(.*)$/.exec(line);
  if (!bullet && !numbered) return null;
  const rest = bullet ? bullet[2] : numbered[4];
  if (!rest.trim()) {
    // An empty item: the list ends here.
    return { text: text.slice(0, lineStart) + text.slice(lineEnd), caret: lineStart };
  }
  const marker = bullet ? bullet[1] : `${numbered[1]}${Number(numbered[2]) + 1}${numbered[3]} `;
  return { text: `${text.slice(0, caret)}\n${marker}${text.slice(caret)}`, caret: caret + 1 + marker.length };
}

// What the question text's lines can be - shared with components/RichText.jsx.
const BULLET = /^[-*•]\s+(.*)$/;
const NUMBERED = /^(\d{1,3})[.)]\s+(.*)$/;

/** Question text as blocks: paragraphs (lines joined by line breaks), bullet lists, numbered lists. */
export function blocksOf(text) {
  const blocks = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    const last = blocks[blocks.length - 1];
    const bullet = BULLET.exec(line);
    const numbered = !bullet && NUMBERED.exec(line);
    if (!line) blocks.push({ kind: 'gap' });
    else if (bullet) {
      if (last?.kind === 'ul') last.items.push(bullet[1]);
      else blocks.push({ kind: 'ul', items: [bullet[1]] });
    } else if (numbered) {
      if (last?.kind === 'ol') last.items.push(numbered[2]);
      else blocks.push({ kind: 'ol', start: Number(numbered[1]), items: [numbered[2]] });
    } else if (last?.kind === 'p') last.lines.push(line);
    else blocks.push({ kind: 'p', lines: [line] });
  }
  return blocks.filter((block) => block.kind !== 'gap');
}
