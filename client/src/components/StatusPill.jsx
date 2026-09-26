const tone = (status) => {
  if (['approved', 'submitted', 'completed', 'live'].includes(status)) return 'success';
  if (['pending', 'waiting', 'in_progress', 'scheduled'].includes(status)) return 'warn';
  return 'danger';
};

/** Statuses are stored lower case; they are read as words, so present them so. */
const sentenceCase = (value) => {
  const text = String(value ?? 'Not started').replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

export function StatusPill({ status, children }) {
  // One width for every status, so a column of them lines up whatever each says.
  return <span className={`pill status-pill ${tone(status)}`}>{children ?? sentenceCase(status)}</span>;
}

/** Free-text pill for labels that are not a status value, e.g. the release policy. */
export function InfoPill({ children, tone: pillTone = 'muted' }) {
  return <span className={`pill ${pillTone}`}>{children}</span>;
}
