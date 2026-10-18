/** Calendar dates, in the viewer's local timezone just like the session list. */
export function localDateKey(value) {
  if (value === null || value === undefined || value === '') return null;
  const at = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  return `${String(at.getFullYear()).padStart(4, '0')}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

export const EMPTY_SESSION_DATES = { mode: 'all', month: '', throughMonth: '', day: '', from: '', to: '' };
const validMonth = (value) => /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && Number(value.slice(0, 4)) > 0;
const validDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !validMonth(value.slice(0, 7))) return false;
  const [year, month, day] = value.split('-').map(Number);
  return day >= 1 && day <= new Date(year, month, 0).getDate();
};
const calendarLabel = (value, monthOnly = false) => {
  const [year, month, day = 1] = value.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date.toLocaleDateString('en', { ...(monthOnly ? {} : { day: 'numeric' }), month: 'short', year: 'numeric' });
};

/** One predicate and label for the active calendar choice. Endpoints are inclusive. */
export function sessionDateFilter(raw = EMPTY_SESSION_DATES) {
  const dates = { ...EMPTY_SESSION_DATES, ...raw };
  const unused = { active: 0, label: 'All dates', error: null, test: () => true };
  const invalid = (error) => ({ active: 1, label: 'Check dates', error, test: () => false });
  const match = (label, accepts) => ({
    active: 1, label, error: null,
    test: (session) => { const day = localDateKey(session.createdAt); return day !== null && accepts(day); }
  });
  if (dates.mode === 'month') {
    if (!dates.month && !dates.throughMonth) return unused;
    if (!validMonth(dates.month) || (dates.throughMonth && !validMonth(dates.throughMonth))) return invalid('Choose a valid starting month.');
    const end = dates.throughMonth || dates.month;
    if (end < dates.month) return invalid('End month must be on or after the starting month.');
    const label = calendarLabel(dates.month, true);
    return match(end === dates.month ? label : `${label} – ${calendarLabel(end, true)}`, (day) => day.slice(0, 7) >= dates.month && day.slice(0, 7) <= end);
  }
  if (dates.mode === 'day') {
    if (!dates.day) return unused;
    if (!validDay(dates.day)) return invalid('Choose a valid day.');
    return match(calendarLabel(dates.day), (day) => day === dates.day);
  }
  if (dates.mode === 'range') {
    if (!dates.from && !dates.to) return unused;
    if ((dates.from && !validDay(dates.from)) || (dates.to && !validDay(dates.to))) return invalid('Choose valid dates.');
    if (dates.from && dates.to && dates.from > dates.to) return invalid('End date must be on or after the start date.');
    const label = dates.from && dates.to ? `${calendarLabel(dates.from)} – ${calendarLabel(dates.to)}`
      : dates.from ? `From ${calendarLabel(dates.from)}` : `Through ${calendarLabel(dates.to)}`;
    return match(label, (day) => (!dates.from || day >= dates.from) && (!dates.to || day <= dates.to));
  }
  return unused;
}
