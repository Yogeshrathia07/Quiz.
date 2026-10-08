/**
 * The button between a student's answers (the review) and their window (its
 * activity log). It sits in the same place in both, beside the ×, and keeps
 * one size whichever it says, so going to one and back is the same press. A
 * phone shows its short word (`short`).
 */
export function SheetSwitch({ icon: Icon, label, short, tip, onClick }) {
  return (
    <button type="button" className="button button-secondary sheet-switch" onClick={onClick} aria-label={tip || label} data-tip={tip}>
      <Icon size={16} aria-hidden="true"/>
      <span className="sheet-switch-long">{label}</span>
      <span className="sheet-switch-short" aria-hidden="true">{short}</span>
    </button>
  );
}
