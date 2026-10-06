export const dateTime = (value) => (value
  ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  : '—');

export const shortDateTime = (value) => (value
  ? new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(value))
  : '—');

/** "10:42 AM": a time later today, as on a clock. */
export const clockTime = (value) => (value
  ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value))
  : '—');

/** The `value` a datetime-local input expects, in the viewer's own timezone. */
export const localDateTime = (value) => {
  const date = new Date(value);
  return new Date(date - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/** mm:ss, or h:mm:ss once a countdown passes an hour. */
export function countdown(seconds) {
  const value = Math.max(0, Math.ceil(Number(seconds) || 0));
  const minutes = String(Math.floor(value / 60) % 60).padStart(2, '0');
  const rest = String(value % 60).padStart(2, '0');
  const hours = Math.floor(value / 3600);
  return hours > 0 ? `${hours}:${minutes}:${rest}` : `${minutes}:${rest}`;
}

export const durationLabel = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (!minutes) return `${rest}s`;
  return rest ? `${minutes} min ${rest}s` : `${minutes} min`;
};

export const numberInRange = (value, minimum, maximum, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : fallback;
};

/**
 * Clipboard access is refused in plenty of ordinary situations - an unfocused
 * document, a denied permission, a browser without the API - and a silent
 * failure looks exactly like a dead button, so fall back to a selection copy.
 */
export async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch { /* fall through to the selection copy below */ }

  const field = document.createElement('textarea');
  field.value = value;
  field.setAttribute('readonly', '');
  field.style.position = 'fixed';
  field.style.top = '-1000px';
  document.body.append(field);
  field.select();
  const copied = document.execCommand?.('copy');
  field.remove();
  if (!copied) throw new Error('This browser blocked copying. Select the link and copy it manually.');
}
