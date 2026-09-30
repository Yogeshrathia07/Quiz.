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

/**
 * The groups laid out in `count` columns, the tallest as short as it can be,
 * so the panel is as short as it can be - short enough to open beside its
 * button rather than over the page. The biggest groups are placed first, each
 * into the shortest column so far; a column then reads in the groups' own
 * order, and so do the columns.
 */
export function packColumns(groups, count) {
  const weight = (group) => group.weight ?? group.options.length + 1; // its options and its heading
  const columns = Array.from({ length: Math.max(1, Math.min(count, groups.length)) }, () => ({ height: 0, entries: [] }));
  groups.map((group, index) => ({ group, index }))
    .sort((a, b) => weight(b.group) - weight(a.group) || a.index - b.index)
    .forEach((entry) => {
      const shortest = columns.reduce((best, column) => (column.height < best.height ? column : best));
      shortest.entries.push(entry);
      shortest.height += weight(entry.group);
    });
  return columns
    .filter((column) => column.entries.length)
    .map((column) => column.entries.sort((a, b) => a.index - b.index))
    .sort((a, b) => a[0].index - b[0].index)
    .map((entries) => entries.map((entry) => entry.group));
}
