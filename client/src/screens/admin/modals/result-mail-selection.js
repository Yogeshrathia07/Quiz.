/** Sending/queued rows cannot be changed, even if an old selection contains them. */
export const canChooseRecipient = (row) => Boolean(row.canEmail && !['queued', 'sending'].includes(row.mail?.status));

/** The bulk button reflects the currently shown, eligible checkboxes, not a past click. */
export function allShownSelected(rows, selected) {
  const eligible = rows.filter(canChooseRecipient);
  return eligible.length > 0 && eligible.every((row) => selected?.has(row.id));
}
