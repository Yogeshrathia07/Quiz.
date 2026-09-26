/**
 * Tick-box filters. Options come in groups; a row is kept when, in every
 * group that has something ticked, it matches at least one ticked option.
 * Within a group the options are alternatives ("Pending or Approved");
 * across groups they narrow ("Approved and Locked"). Nothing ticked keeps
 * everyone - and so does everything ticked, as long as each group's options
 * between them cover every row (tests/filters.test.js holds them to that).
 *
 *   groups: [{ id, title, options: [{ id, label, test(row) }] }]
 */
export function applyFilters(rows, groups, selected) {
  const ticked = new Set(selected);
  const active = groups
    .map((group) => group.options.filter((option) => ticked.has(option.id)))
    .filter((options) => options.length > 0);
  if (!active.length) return rows;
  return rows.filter((row) => active.every((options) => options.some((option) => option.test(row))));
}

export const allOptionIds = (groups) => groups.flatMap((group) => group.options.map((option) => option.id));

/** How many rows each option matches on its own. */
export const optionCounts = (rows, groups) => Object.fromEntries(
  groups.flatMap((group) => group.options).map((option) => [option.id, rows.filter(option.test).length])
);
