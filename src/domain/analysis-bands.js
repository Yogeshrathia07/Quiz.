/** Shared by the interactive Analysis page and the optional results-email image. */
export const BANDS = [
  { id: '90', label: '90–100%', from: 90, to: Infinity },
  { id: '80', label: '80–90%', from: 80, to: 90 },
  { id: '70', label: '70–80%', from: 70, to: 80 },
  { id: '50', label: '50–70%', from: 50, to: 70 },
  { id: '30', label: '30–50%', from: 30, to: 50 },
  { id: '0', label: 'Below 30%', from: -Infinity, to: 30 }
];

/** Whole-mark bars: no impossible empty scores, and a short final bar joins its neighbour. */
export function markBars(fullMarks, asked, maxBars = null) {
  const top = Math.ceil(fullMarks - 1e-9);
  const slots = top + 1;
  const want = asked ?? (slots <= 21 ? slots : 10);
  const wanted = Math.max(1, Math.round(top / Math.max(1, want)));
  const step = maxBars ? Math.max(wanted, Math.ceil(slots / Math.max(1, maxBars))) : wanted;
  let count = Math.ceil(slots / step);
  const rest = slots % step;
  if (rest && rest <= step / 2 && count > 1) count -= 1;
  const bars = Array.from({ length: count }, (_unused, index) => {
    const last = index === count - 1;
    const from = index * step;
    const to = last ? top : from + step;
    return { index, unit: 'marks', from, to, last, weight: last ? top - from + 1 : step, count: 0 };
  });
  return { bars, step, top, capped: step > wanted };
}
