/**
 * A paper's marks as an open gauge, drawn the way LeetCode draws its solved
 * count: three quarters of a circle, open at the bottom, in three equal parts
 * - Right (blue), Unmarked (yellow) and Wrong (red), as the tiles beside it on
 * a result's page. Each part fills, in its own colour, with its share of the
 * full marks (5 right of 30 fills a sixth of the blue part, 25 lost five
 * sixths of the red); the rest of the part is the same colour, faint. The
 * score sits in the middle; a pointer resting on the gauge gives each part in
 * numbers.
 *
 * `size` 'large' (a result's page: the percentage under the score and a
 * caption in the opening) or 'small' (a row in My results: the score alone).
 */
const RADIUS = 42;
const CIRCLE = 2 * Math.PI * RADIUS;
// Three quarters of the circle, as LeetCode's; the rest is the opening at the bottom.
const ARC = 0.75 * CIRCLE;
// The arc starts at the bottom left (135° round from three o'clock) and ends at the bottom right.
const START_ANGLE = 135;
// The line's width and the space seen between two parts, in the drawing's units (a hundredth
// of the gauge): LeetCode's thin line on a result's page, a thicker one on a small gauge.
const LINE = { large: { stroke: 3, space: 3 }, small: { stroke: 7, space: 4.5 } };
// The parts from the bottom left round to the bottom right, in the tiles' order, each with the marks it shows.
const PARTS = [
  { id: 'right', name: 'Right', marks: 'earned' },
  { id: 'unmarked', name: 'Unmarked', marks: 'waiting' },
  { id: 'wrong', name: 'Wrong', marks: 'lost' }
];

/**
 * Where each part's line starts and how long it is. A rounded end reaches half the
 * line's width past each end, so the lines are drawn that much short.
 */
function partsLayout({ stroke, space }) {
  const gap = space + stroke;
  const length = (ARC - stroke - gap * (PARTS.length - 1)) / PARTS.length;
  return PARTS.map((part, index) => ({ ...part, start: stroke / 2 + index * (length + gap), length }));
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, Number(value) || 0));
const marksWord = (value) => `${value} mark${value === 1 ? '' : 's'}`;
const percentOf = (value, total) => (total ? Math.round((value / total) * 100) : 0);

/** Earned, still to be marked and lost, from the score, the full marks and the marks waiting. */
export function marksParts(score, total, pending = 0) {
  const all = Math.max(0, Number(total) || 0);
  const earned = clamp(score, 0, all);
  const waiting = clamp(pending, 0, all - earned);
  return { total: all, earned, waiting, lost: Math.max(0, Math.round((all - earned - waiting) * 100) / 100) };
}

/** Each part in words, one a line ("Right: 5 of 30 marks (17%)"): for the hover and for a screen reader. */
export function marksDetail(marks) {
  return PARTS.map(({ name, marks: key }) => `${name}: ${marks[key]} of ${marksWord(marks.total)} (${percentOf(marks[key], marks.total)}%)`).join('\n');
}

export function MarksGauge({ score, total, pending = 0, size = 'large', caption = null }) {
  const marks = marksParts(score, total, pending);
  const small = size === 'small';
  const line = LINE[small ? 'small' : 'large'];
  const detail = marksDetail(marks);
  // A long score ("7.5/10", "100/100") in smaller figures, to stay inside a small gauge's ring.
  const long = `${marks.earned}/${marks.total}`.length > 5;
  return (
    <span className={`marks-gauge is-${small ? 'small' : 'large'}${long ? ' is-long' : ''}`} role="img" aria-label={detail.replaceAll('\n', ', ')} data-tip={detail}
      style={{ '--gauge-stroke': line.stroke }}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <g transform={`rotate(${START_ANGLE} 50 50)`}>
          {partsLayout(line).map(({ id, marks: key, start, length }) => {
            const share = marks.total ? marks[key] / marks.total : 0;
            return (
              <g key={id} className={`marks-gauge-part is-${id}`}>
                <circle className="marks-gauge-track" cx="50" cy="50" r={RADIUS} strokeDasharray={`${length} ${CIRCLE}`} strokeDashoffset={-start}/>
                {share > 0 && (
                  <circle className="marks-gauge-fill" cx="50" cy="50" r={RADIUS}
                    strokeDasharray={`${Math.max(0.01, share * length)} ${CIRCLE}`} strokeDashoffset={-start}/>
                )}
              </g>
            );
          })}
        </g>
      </svg>
      <span className="marks-gauge-center" aria-hidden="true">
        <strong>{marks.earned}<small>/{marks.total}</small></strong>
        {!small && <span>{percentOf(marks.earned, marks.total)}%</span>}
      </span>
      {!small && caption && <span className="marks-gauge-caption" aria-hidden="true">{caption}</span>}
    </span>
  );
}
