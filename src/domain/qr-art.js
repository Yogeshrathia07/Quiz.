/**
 * How the portal draws a QR - a test's join code (qrSvg, on the server) and
 * the live attendance code (client/src/screens/attendance/LiveQr.jsx). Squares
 * that touch flow into one rounded shape - a lone square is a dot, a row of
 * them a pill - and the three corner markers are rounded too. The colour is a
 * deep blue, dark enough against the white for a camera. The attendance code
 * changes every few seconds as layers (see qrLayers), so it can fade.
 *
 * A code is `{ size, data }` as the qrcode package makes it: `data[y * size + x]`
 * is set for a dark square.
 */

/** White margin round the code, in squares: cameras need it to find the edge. */
export const QUIET = 2;
/** The corner radius of the white tile, in squares. */
export const TILE_ROUND = 1.6;

export const QR_COLOURS = {
  paper: '#FFFFFF',
  // The squares run from navy at the top left to the app's deep blue at the bottom right.
  from: '#0B2545',
  to: '#0D5F8A',
  ring: '#1176AB',
  centre: '#0B2545'
};

const finders = (size) => [[0, 0], [size - 7, 0], [0, size - 7]];
export const inFinder = (x, y, size) => finders(size).some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);

const n = (value) => Math.round(value * 1000) / 1000;
/** A rectangle as a path, each corner with its own radius: top-left, top-right, bottom-right, bottom-left. */
export function roundedRect(x, y, w, h, [a, b, c, d]) {
  const arc = (r, toX, toY) => (r ? `A${n(r)} ${n(r)} 0 0 1 ${n(toX)} ${n(toY)}` : '');
  return `M${n(x + a)} ${n(y)}H${n(x + w - b)}${arc(b, x + w, y + b)}V${n(y + h - c)}${arc(c, x + w - c, y + h)}`
    + `H${n(x + d)}${arc(d, x, y + h - d)}V${n(y + a)}${arc(a, x + a, y)}Z`;
}

const ROUND = 0.5;
/** Whether a square of the code is dark - off the edge and inside the corner markers count as light. */
const darkIn = ({ size, data }) => (x, y) => x >= 0 && y >= 0 && x < size && y < size && Boolean(data[y * size + x]) && !inFinder(x, y, size);
/** Whether a square's corner rounds off: neither square beside that corner is dark. Corners 0-3 run from the top left, clockwise. */
const roundsIn = (dark) => (x, y, corner) => !dark(corner === 0 || corner === 3 ? x - 1 : x + 1, y) && !dark(x, corner < 2 ? y - 1 : y + 1);

/** The squares `drawn(x, y)` allows, each row of touching ones a single shape whose end corners round where `rounds` says. */
function shapesPath(size, drawn, rounds) {
  let d = '';
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!drawn(x, y)) continue;
      let run = 1;
      while (x + run < size && drawn(x + run, y)) run += 1;
      const last = x + run - 1;
      d += roundedRect(x, y, run, 1, [rounds(x, y, 0) ? ROUND : 0, rounds(last, y, 1) ? ROUND : 0, rounds(last, y, 2) ? ROUND : 0, rounds(x, y, 3) ? ROUND : 0]);
      x = last;
    }
  }
  return d;
}

/**
 * The dark squares `pick(index)` allows, outside the corner markers. Each
 * corner of a shape rounds off where neither square beside it is dark - on
 * the whole code, so a shape looks the same in every layer it is drawn in. A
 * row of touching squares is one shape: only its ends can round.
 */
export function flowPath(code, pick = () => true) {
  const dark = darkIn(code);
  return shapesPath(code.size, (x, y) => dark(x, y) && pick(y * code.size + x), roundsIn(dark));
}

/** How far the layer under a change keeps inside the codes' outlines, in squares: clear of the soft pixels along an edge. */
const INSET = 0.08;
/**
 * The squares dark in both codes, solid, for underneath a change. Each sits
 * just inside its shape in either code - a corner rounds if it rounds in
 * one or the other - so the edges are drawn only by the codes fading over it,
 * never twice. Where two of these squares touch, they meet edge to edge, as
 * one shape.
 */
export function sharedPath(a, b) {
  const [darkA, darkB] = [darkIn(a), darkIn(b)];
  const [roundsA, roundsB] = [roundsIn(darkA), roundsIn(darkB)];
  const both = (x, y) => darkA(x, y) && darkB(x, y);
  let d = '';
  for (let y = 0; y < a.size; y += 1) {
    for (let x = 0; x < a.size; x += 1) {
      if (!both(x, y)) continue;
      const [top, right, bottom, left] = [both(x, y - 1), both(x + 1, y), both(x, y + 1), both(x - 1, y)].map((touching) => (touching ? 0 : INSET));
      const corner = (index) => (roundsA(x, y, index) || roundsB(x, y, index) ? ROUND - INSET : 0);
      d += roundedRect(x + left, y + top, 1 - left - right, 1 - top - bottom, [corner(0), corner(1), corner(2), corner(3)]);
    }
  }
  return d;
}

const all = (r) => [r, r, r, r];
/** The three corner markers: a rounded ring (drawn even-odd) and a rounded centre. They never change. */
export function cornerPaths(size) {
  const at = finders(size);
  return {
    rings: at.map(([x, y]) => roundedRect(x, y, 7, 7, all(2.2)) + roundedRect(x + 1, y + 1, 5, 5, all(1.2))).join(''),
    centres: at.map(([x, y]) => roundedRect(x + 2, y + 2, 3, 3, all(0.9))).join('')
  };
}

/**
 * One code drawn as a change from the one before. Underneath, solid, the
 * squares dark in both - the corner markers too, so a camera keeps its lock;
 * over them the old code fades out and the new one fades in, each as one
 * shape. Squares drawn in separate layers would leave a faint seam where they
 * touch; inside one shape they never do, and the solid layer beneath keeps
 * what stays from dimming mid-change. It keeps inside the outlines, so the
 * change starts and ends exactly on the codes as they look at rest. `all` is
 * the code once the change is over.
 */
export function qrLayers(next, before) {
  const old = before?.size === next.size ? before : null;
  return {
    size: next.size,
    ...cornerPaths(next.size),
    all: flowPath(next),
    stay: old ? sharedPath(old, next) : '',
    leave: old ? flowPath(old) : ''
  };
}

/** A whole code as a standalone SVG image, `width` px square. */
export function qrSvg(code, width = 320) {
  const side = code.size + QUIET * 2;
  const { rings, centres } = cornerPaths(code.size);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}" viewBox="${-QUIET} ${-QUIET} ${side} ${side}">`
    + `<defs><linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${code.size}" y2="${code.size}">`
    + `<stop offset="0" stop-color="${QR_COLOURS.from}"/><stop offset="1" stop-color="${QR_COLOURS.to}"/></linearGradient></defs>`
    + `<rect x="${-QUIET}" y="${-QUIET}" width="${side}" height="${side}" rx="${TILE_ROUND}" fill="${QR_COLOURS.paper}"/>`
    + `<path d="${rings}" fill="${QR_COLOURS.ring}" fill-rule="evenodd"/>`
    + `<path d="${centres}" fill="${QR_COLOURS.centre}"/>`
    + `<path d="${flowPath(code)}" fill="url(#ink)"/>`
    + '</svg>';
}
