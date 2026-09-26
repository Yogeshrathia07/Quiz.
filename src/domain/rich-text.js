/**
 * Question text may carry a little formatting, written as plain text (the
 * question editor has buttons for it):
 *
 *   **bold**        bold
 *   a new line      a new line
 *   - item          a bullet point (also "* " or "• ")
 *   1. item         a numbered list (also "1) ")
 *
 * It is stored exactly as written. The student's paper and the admin's pages
 * draw it (client/src/components/RichText.jsx); spreadsheets get the plain
 * version below.
 */

/**
 * Question text as typed, tidied without losing its lines: spaces run
 * together within a line, at most one blank line between blocks.
 */
export function tidyLines(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** For a spreadsheet cell: no ** marks, bullets as "•", lines kept. */
export function plainText(value) {
  return String(value || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^[ \t]*[-*•][ \t]+/gm, '• ');
}

/** On one line, for a column header or a short label. */
export const oneLine = (value) => plainText(value).replace(/\s*\n\s*/g, ' ');
