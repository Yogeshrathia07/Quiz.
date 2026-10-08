/**
 * One CSV cell. Text a student typed - a name, say - that starts like a
 * formula (= + - @, or a tab or return before one) would run as one when the
 * file is opened in Excel; a leading apostrophe keeps it text.
 */
export const csvCell = (value) => {
  const text = String(value ?? '');
  const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};
