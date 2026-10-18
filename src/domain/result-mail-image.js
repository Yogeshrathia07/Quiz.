import { binLabel, classAnalysisOf, classAnalysisText } from './class-analysis.js';
import { oneLine } from './rich-text.js';

const c = { bg: '#13161C', panel: '#1B1F27', tile: '#232833', line: '#353B47', ink: '#ECECEE', soft: '#A9B4C2', sky: '#55BCE6', average: '#ECECEE', median: '#F8CF42' };
const colours = ['#0E95E4', '#4DA4B5', '#26B781', '#F8CF42', '#FA9C2E', '#F24040', '#697382'];
const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const number = (value) => value === null || !Number.isFinite(Number(value)) ? '—' : String(Math.round(Number(value) * 10) / 10);
const text = (x, y, value, size = 18, fill = c.ink, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${esc(value)}</text>`;
const rect = (x, y, width, height, fill = c.panel, radius = 18) => `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`;
const titleOf = (value) => { const title = oneLine(value).slice(0, 100); return title.length > 86 ? `${title.slice(0, 85)}…` : title; };

/** Only trusted aggregate numbers and escaped title/code enter this SVG. No scripts, links or user images. */
export function classAnalysisSvg({ title, code, analysis: a }) {
  const cardWidth = 209;
  const mark = (key) => a[key] === null ? '—' : a.fullMarks === null ? `${number(a[key])}%` : `${number(a[`${key}Marks`])}/${number(a.fullMarks)}`;
  const hint = (key) => a[key] === null ? 'no marked papers' : `${number(a[key])}%`;
  const stats = [
    [number(a.attempted), `Attempted · ${a.absent} absent`],
    [mark('average'), `Average · ${hint('average')}`],
    [mark('median'), `Median · ${hint('median')}`],
    [mark('highest'), `Highest · ${hint('highest')}`],
    [mark('lowest'), `Lowest · ${hint('lowest')}`],
    [number(a.pendingPapers), a.pendingPapers ? 'Papers still to mark' : 'To mark · all marked']
  ];
  const tiles = stats.map(([value, label], index) => {
    const x = 32 + index * (cardWidth + 16);
    return rect(x, 112, cardWidth, 100, c.tile, 14) + text(x + 18, 155, value, value.length > 12 ? 24 : 30, c.ink, 'font-weight="700"') + text(x + 18, 188, label, 15, c.soft);
  }).join('');
  const total = a.bands.reduce((sum, band) => sum + band.count, 0);
  const circumference = 2 * Math.PI * 114;
  let offset = 0;
  const arcs = a.bands.map((band, index) => {
    if (!band.count || !total) return '';
    const length = band.count / total * circumference;
    const arc = `<circle cx="282" cy="441" r="114" fill="none" stroke="${colours[index]}" stroke-width="46" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 282 441)"/>`;
    offset += length;
    return arc;
  }).join('');
  const legend = a.bands.map((band, index) => {
    const y = 628 + index * 29;
    return `<circle cx="63" cy="${y - 6}" r="7" fill="${colours[index]}"/>` + text(83, y, band.label, 17, c.soft) + text(510, y, `${band.count} · ${band.share}%`, 17, c.ink, 'text-anchor="end" font-weight="600"');
  }).join('');
  const histogram = a.histogram;
  const left = 642; const plotWidth = 678; const baseline = 735; const plotHeight = 348;
  const highestCount = Math.max(1, ...histogram.bins.map((bin) => bin.count));
  const ceiling = Math.ceil(highestCount / 4) * 4;
  const domain = histogram.unit === 'marks' ? histogram.top + 1 : 100;
  const grid = Array.from({ length: 5 }, (_, index) => {
    const y = baseline - index / 4 * plotHeight;
    return `<line x1="${left}" y1="${y}" x2="${left + plotWidth}" y2="${y}" stroke="${c.line}" stroke-width="1"/>` + text(left - 14, y + 5, ceiling * index / 4, 14, c.soft, 'text-anchor="end"');
  }).join('');
  const bars = histogram.bins.map((bin, index) => {
    const end = histogram.unit === 'marks' && bin.last ? bin.to + 1 : bin.to;
    const slotWidth = (end - bin.from) / domain * plotWidth;
    const center = left + (bin.from + end) / 2 / domain * plotWidth;
    const width = Math.max(8, slotWidth * .52);
    const height = bin.count / ceiling * plotHeight;
    const blue = ['#176D95', '#1982AE', '#2897C5', '#64B2CD', '#A5D3E4'][Math.min(4, Math.floor(index / 2))];
    return (bin.count ? rect(center - width / 2, baseline - height, width, height, blue, Math.min(10, height / 2)) + text(center, baseline - height - 12, bin.count, 17, c.soft, 'text-anchor="middle"') : '') + text(center, baseline + 28, binLabel(bin, histogram), 14, c.soft, 'text-anchor="middle"');
  }).join('');
  const value = (key) => histogram.unit === 'marks' ? a[`${key}Marks`] : a[key];
  const lines = ['average', 'median'].map((key) => {
    const amount = value(key);
    if (amount === null) return '';
    const x = left + amount / domain * plotWidth;
    return `<line x1="${x}" y1="${baseline - plotHeight}" x2="${x}" y2="${baseline}" stroke="${c[key]}" stroke-width="2" ${key === 'median' ? 'stroke-dasharray="7 6"' : ''}/>`;
  }).join('');
  const noData = a.counted ? '' : text(left + plotWidth / 2, 540, 'No fully marked papers yet', 21, c.soft, 'text-anchor="middle"');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="914" viewBox="0 0 1400 914" role="img" aria-labelledby="title description">
  <title id="title">Class analysis — ${esc(titleOf(title))}</title><desc id="description">${esc(classAnalysisText(a))}</desc>
  <rect width="1400" height="914" fill="${c.bg}"/>
  <g font-family="Arial, Helvetica, sans-serif">
  ${text(32, 48, 'Class performance', 30, c.ink, 'font-weight="700"')}${text(32, 82, titleOf(title), 20, c.sky)}${text(1368, 48, oneLine(code).slice(0, 32), 16, c.soft, 'text-anchor="end"')}
  ${tiles}${rect(32, 236, 520, 616)}${rect(568, 236, 800, 616)}
  ${text(56, 274, 'Score bands', 22, c.ink, 'font-weight="700"')}
  <circle cx="282" cy="441" r="114" fill="none" stroke="${c.line}" stroke-width="46"/>${arcs}
  ${text(282, 440, total, 48, c.ink, 'text-anchor="middle" font-weight="700"')}${text(282, 475, 'papers', 22, c.soft, 'text-anchor="middle"')}
  ${legend}${text(594, 274, histogram.unit === 'marks' ? 'Marks' : 'Marks (%)', 22, c.ink, 'font-weight="700"')}
  ${text(594, 307, histogram.unit === 'marks' ? `Students by marks · out of ${number(a.fullMarks)}` : a.counted ? 'Percentages · papers have different totals' : 'No fully marked papers yet', 17, c.soft)}
  ${text(594, 344, `Average ${mark('average')}`, 17, c.average, 'font-weight="600"')}${text(945, 344, `Median ${mark('median')}`, 17, c.median, 'font-weight="600"')}
  ${grid}${bars}${lines}${noData}${text(981, 808, histogram.unit === 'marks' ? `Marks (out of ${number(a.fullMarks)})` : 'Marks (%)', 17, c.soft, 'text-anchor="middle"')}
  ${text(32, 887, 'Whole class · all questions · pending papers are excluded from score statistics and the marks chart.', 16, c.soft)}
  </g></svg>`;
}

/** Native async rendering keeps SVG conversion off the server's request/event loop. */
export async function createResultAnalysisImage(test) {
  const analysis = classAnalysisOf(test);
  const svg = classAnalysisSvg({ title: test.title, code: test.code, analysis });
  const { renderAsync } = await import('@resvg/resvg-js');
  const png = await renderAsync(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } });
  const content = png.asPng().toString('base64');
  const code = String(test.code || 'quiz').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'quiz';
  return { analysis, attachment: { name: `class-analysis-${code}.png`, content } };
}

/** Share one render across a classStats snapshot, including concurrent previews/sends. */
export function cacheAnalysisImages(build = createResultAnalysisImage) {
  const images = new WeakMap();
  return (test, snapshot) => {
    if (!snapshot || typeof snapshot !== 'object') return build(test);
    const held = images.get(snapshot);
    if (held?.code === test.code) return held.job;
    const job = Promise.resolve().then(() => build(test));
    images.set(snapshot, { code: test.code, job });
    job.catch(() => { if (images.get(snapshot)?.job === job) images.delete(snapshot); });
    return job;
  };
}
export const resultAnalysisImageFor = cacheAnalysisImages();
