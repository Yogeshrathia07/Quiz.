/** Inspect native constraints without firing invalid events on hidden panels.
 * The caller reveals the first field, then calls its reportValidity(). */
export function firstInvalidField(form) {
  return Array.from(form?.elements || []).find((field) => field.willValidate && field.validity?.valid === false) || null;
}
