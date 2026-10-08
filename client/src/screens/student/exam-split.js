export const DEFAULT_EXAM_SPLIT = 53;

/** Keep the movable divider within 20–80%, and leave room to read both panes. */
export function examSplitLimits(availableWidth) {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return { min: 20, max: 80 };

  // The minimums grow gradually from a landscape phone to a tablet/desktop,
  // so crossing one pixel-wide breakpoint never makes the divider jump.
  const room = Math.min(1, Math.max(0, (availableWidth - 600) / 300));
  const questionMin = 210 + 90 * room;
  const answerMin = 210 + 130 * room;
  // On a very narrow landscape screen there is not room for both minimums.
  // Centre the divider there rather than allowing either pane to disappear.
  const scale = Math.min(1, availableWidth / (questionMin + answerMin));
  const min = Math.max(20, questionMin * scale / availableWidth * 100);
  const max = Math.min(80, 100 - answerMin * scale / availableWidth * 100);
  return { min, max };
}

export function clampExamSplit(value, limits) {
  return Math.min(limits.max, Math.max(limits.min, value));
}

export function examSplitAtPointer(clientX, left, availableWidth, dividerWidth, limits) {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return clampExamSplit(DEFAULT_EXAM_SPLIT, limits);
  return clampExamSplit((clientX - left - dividerWidth / 2) / availableWidth * 100, limits);
}
