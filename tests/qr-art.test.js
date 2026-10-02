import assert from 'node:assert/strict';
import test from 'node:test';
import QRCode from 'qrcode';
import { cornerPaths, flowPath, inFinder, qrLayers, qrSvg, roundedRect, sharedPath } from '../src/domain/qr-art.js';

/** A code from rows of '#' (dark) and '.' (light). */
const code = (...rows) => ({ size: rows.length, data: Uint8Array.from(rows.join('').split(''), (cell) => (cell === '#' ? 1 : 0)) });
/** A 21-square canvas, its corner markers left light, with `marks` ([x, y]) dark. */
function canvas(marks) {
  const data = new Uint8Array(21 * 21);
  for (const [x, y] of marks) data[y * 21 + x] = 1;
  return { size: 21, data };
}
const shapes = (path) => path.split('M').length - 1;

test('a lone square is a dot, a row of squares one pill, a corner where two shapes meet stays square', () => {
  assert.equal(flowPath(canvas([[10, 10]])), roundedRect(10, 10, 1, 1, [0.5, 0.5, 0.5, 0.5]));
  assert.equal(flowPath(canvas([[9, 10], [10, 10], [11, 10]])), roundedRect(9, 10, 3, 1, [0.5, 0.5, 0.5, 0.5]), 'one shape, rounded only at its ends');
  // An L: the corner square joins both arms, so neither of its shared sides rounds.
  const ell = flowPath(canvas([[10, 9], [10, 10], [11, 10]]));
  assert.equal(shapes(ell), 2);
  assert.equal(ell, roundedRect(10, 9, 1, 1, [0.5, 0.5, 0, 0]) + roundedRect(10, 10, 2, 1, [0, 0.5, 0.5, 0.5]));
});

test('the corner markers are drawn on their own, rounded, and left out of the squares', () => {
  const full = code(...Array.from({ length: 21 }, () => '#'.repeat(21)));
  assert.ok(inFinder(0, 0, 21) && inFinder(20, 0, 21) && inFinder(0, 20, 21) && !inFinder(20, 20, 21) && !inFinder(7, 7, 21));
  const { rings, centres } = cornerPaths(21);
  assert.equal(shapes(rings), 6, 'three rings, each an outline and its hole');
  assert.equal(shapes(centres), 3);
  assert.ok(rings.includes('A2.2 2.2'), 'rounded');
  // A fully dark code: every row a pill, minus the markers' 7 squares at each side.
  assert.ok(!flowPath(full).startsWith('M0 0'));
});

test('a change of code: what stays is solid underneath, just inside both codes; the old and new codes fade over it whole', () => {
  const before = code('.....', '.##..', '.....', '..#..', '.....');
  const next = code('.....', '.###.', '.....', '.....', '..#..');
  // Set in the middle of a 21-square code, clear of the corner markers.
  const pad = (small) => canvas([...small.data].flatMap((on, index) => (on ? [[8 + (index % 5), 8 + Math.floor(index / 5)]] : [])));
  const layers = qrLayers(pad(next), pad(before));
  assert.equal(layers.leave, flowPath(pad(before)), 'the old code, as one shape');
  assert.equal(layers.all, flowPath(pad(next)), 'the new code, as one shape');
  assert.equal(layers.stay, sharedPath(pad(before), pad(next)));
  // Only the two squares dark in both, just inside their outlines, meeting edge to edge. The pair's right end is
  // square in the new code (a third square joins it) but round in the old: underneath, it is round, so it never
  // shows outside either code - the new code's square end fades in over it.
  assert.equal(layers.stay, roundedRect(9.08, 9.08, 0.92, 0.84, [0.42, 0, 0, 0.42]) + roundedRect(10, 9.08, 0.92, 0.84, [0, 0.42, 0.42, 0]));
  assert.deepEqual([qrLayers(pad(next), null).stay, qrLayers(pad(next), null).leave], ['', ''], 'the first code just appears');
});

test('a real attendance code: one shape for each run of touching squares in a row, the markers left out', () => {
  const { modules } = QRCode.create('https://example.org/?attend=ATT-7QK2M&k=0123456789ab', { errorCorrectionLevel: 'M' });
  const { size, data } = modules;
  const dark = (x, y) => x < size && Boolean(data[y * size + x]) && !inFinder(x, y, size);
  let runs = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (dark(x, y) && !(x > 0 && dark(x - 1, y))) runs += 1;
  assert.equal(shapes(flowPath(modules)), runs);
  assert.equal(shapes(flowPath(modules, () => false)), 0);
  assert.equal(qrLayers(modules, null).all, flowPath(modules), 'the first code is one shape');
  let squares = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (dark(x, y)) squares += 1;
  assert.equal(shapes(sharedPath(modules, modules)), squares, 'a code shares every square with itself, each drawn on its own');
});

test('a whole code as an image: the tile, the markers, every shape, one gradient', () => {
  const { modules } = QRCode.create('https://example.org/?test=ABC123', { errorCorrectionLevel: 'M' });
  const svg = qrSvg(modules, 320);
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="320" height="320" viewBox="-2 -2 /);
  assert.ok(svg.includes(`d="${flowPath(modules)}" fill="url(#ink)"`));
  assert.ok(svg.includes(`d="${cornerPaths(modules.size).rings}"`));
  assert.equal(svg.match(/<linearGradient/g).length, 1);
});
