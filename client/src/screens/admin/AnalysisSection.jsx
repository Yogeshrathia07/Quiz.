import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDownAZ, BarChart3, ChartColumnBig, ChartPie, Check, CheckCheck, ChevronDown, ChevronRight, ClipboardPaste, Clock, Download, ListChecks, ListOrdered,
  Info, Lock, LogOut, PenLine, ScrollText, Search, ShieldCheck, SlidersHorizontal, TrendingDown, TrendingUp, Trophy, X
} from 'lucide-react';
import { FilterMenu } from '../../components/FilterMenu.jsx';
import { Modal } from '../../components/Modal.jsx';
import { durationLabel, shortDateTime } from '../../lib/format.js';
import { useFitToScreen } from '../../lib/fit-to-screen.js';
import { useFloatingPanel } from '../../lib/useFloatingPanel.js';
import { BANDS, PENDING_BAND, STATE_NAMES, bandOf, cellOf, compute, rangeOf, spanOf } from './analysis-compute.js';
import { TYPE_WORD, marksText, percentText, plural, useOverview } from './TestOverview.jsx';

/*
 * The Analysis tab, one screen tall, in three views the switch at the top
 * chooses between: Charts (six figures, the score bands and the marks
 * chart), Questions (every question's average) and the Rank list (every
 * paper, answer by answer). All three share one toolbar: search, Sort &
 * filter (a marks range among them), and which questions count. Every figure comes from compute() (analysis-compute.js)
 * over the questions ticked and the students filtered - one source, so they
 * always agree - and the choices are kept in the address
 * (?view=list&qs=1,2,5&bins=5&lo=40&hi=100; not q, the dashboard's search).
 */

/**
 * The score bands' colours, low to high: rose (below 30%), orange (30-50%),
 * yellow (50-70%), teal (70-80%), sky (80-90%), blue (90-100%); grey for
 * still to mark. The legend names each band beside its colour.
 */
const BAND_COLOURS = { 90: '#5B8DEF', 80: '#38BDF8', 70: '#2DD4BF', 50: '#FACC15', 30: '#FB923C', 0: '#F43F5E', [PENDING_BAND]: '#5C636A' };
/**
 * The bars' colours (the marks chart, the question averages): one purple,
 * darkest for the lowest band and brightest for the best, so on the dark
 * card the better marks stand out. The donut keeps its own colours above.
 */
const BAR_COLOURS = { 90: '#E0E3FF', 80: '#B8BFFB', 70: '#959FF6', 50: '#7480EC', 30: '#5A65CC', 0: '#4A50A8' };
/** Suggested numbers of bars for the marks chart; any whole number from 1 to MAX_BARS will do. */
const BAR_CHOICES = [5, 10, 20];
const MAX_BARS = 100;
const barsOf = (value) => {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 1 && number <= MAX_BARS ? number : null;
};
const VIEWS = [
  { id: 'charts', label: 'Charts', icon: ChartPie },
  { id: 'questions', label: 'Questions', icon: ChartColumnBig },
  { id: 'list', label: 'Rank list', icon: ListOrdered }
];

const minutes = (seconds) => {
  if (seconds === null || seconds === undefined) return '—';
  const total = Math.round(seconds / 60);
  return total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${total}m`;
};
/** A question's average as a share of what it is worth, or null with nothing marked. */
const averagePercent = (question) => (question.average === null || !question.worth ? null : (question.average / question.worth) * 100);

/* ------------------------------------------------------ filters and orders */

const FILTER_GROUPS = [
  {
    id: 'mark', title: 'Marking',
    options: [
      { id: 'mark:done', label: 'Fully marked', test: (row) => row.counted },
      { id: 'mark:pending', label: 'Still to mark', test: (row) => row.band === PENDING_BAND }
    ]
  },
  {
    id: 'flag', title: 'While writing',
    options: [
      { id: 'flag:left', label: 'Left the page', test: (row) => row.flags.includes('left') },
      { id: 'flag:locked', label: 'Locked', test: (row) => row.flags.includes('locked') },
      { id: 'flag:copy', label: 'Copy or paste', test: (row) => row.flags.includes('copy') },
      { id: 'flag:none', label: 'Nothing flagged', test: (row) => row.flags.includes('none') }
    ]
  }
];
const FILTER_ICONS = {
  'avg:above': { icon: TrendingUp, tone: 'ok' },
  'avg:below': { icon: TrendingDown, tone: 'warn' },
  'med:above': { icon: TrendingUp, tone: 'ok' },
  'med:below': { icon: TrendingDown, tone: 'warn' },
  'mark:done': { icon: CheckCheck, tone: 'ok' },
  'mark:pending': { icon: PenLine, tone: 'warn' },
  'flag:left': { icon: LogOut, tone: 'warn' },
  'flag:locked': { icon: Lock, tone: 'bad' },
  'flag:copy': { icon: ClipboardPaste, tone: 'warn' },
  'flag:none': { icon: ShieldCheck, tone: 'ok' }
};

const LIST_SORTS = [
  { id: 'rank', label: 'Rank', icon: Trophy, directions: [{ id: 'asc', label: 'Best first' }, { id: 'desc', label: 'Last first' }] },
  { id: 'total', label: 'Marks', icon: BarChart3, directions: [{ id: 'desc', label: 'Highest first' }, { id: 'asc', label: 'Lowest first' }] },
  { id: 'name', label: 'Name', icon: ArrowDownAZ, directions: [{ id: 'asc', label: 'A–Z' }, { id: 'desc', label: 'Z–A' }] },
  { id: 'time', label: 'Time taken', icon: Clock, directions: [{ id: 'asc', label: 'Fastest first' }, { id: 'desc', label: 'Slowest first' }] }
];
const CHART_SORTS = [
  { id: 'number', label: 'Question number', icon: ListOrdered, directions: [{ id: 'asc', label: 'First to last' }, { id: 'desc', label: 'Last to first' }] },
  { id: 'average', label: 'Average', icon: BarChart3, directions: [{ id: 'asc', label: 'Hardest first' }, { id: 'desc', label: 'Easiest first' }] },
  { id: 'pending', label: 'Still to mark', icon: PenLine, directions: [{ id: 'desc', label: 'Most first' }, { id: 'asc', label: 'Fewest first' }] }
];
/** 'q3-desc' (sorted by the question in column 3) or 'total-desc' as compute()'s { key, dir }. */
const listSortOf = (sort) => {
  const [field, dir] = String(sort).split('-');
  return { key: /^q\d+$/.test(field) ? Number(field.slice(1)) : field, dir };
};

/** The ticked questions in the chart's order. */
function orderQuestions(figures, selected, sort) {
  const [field, dir] = sort.split('-');
  const sign = dir === 'desc' ? -1 : 1;
  const value = (question) => (field === 'average' ? averagePercent(question) : field === 'pending' ? question.pending : question.number);
  return figures.filter((question) => selected.has(question.column)).sort((a, b) => {
    const [x, y] = [value(a), value(b)];
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    return sign * ((x ?? 0) - (y ?? 0)) || a.number - b.number;
  });
}

/* --------------------------------------------------------- the address */

const fromAddress = (key) => new URLSearchParams(window.location.search).get(key);
const ADDRESS_KEYS = ['view', 'qs', 'bins'];
function initialChoices(questions) {
  const asked = fromAddress('qs');
  const numbers = asked === 'none' ? [] : asked ? asked.split(',').map(Number) : null;
  const selected = numbers ? new Set(questions.flatMap((question, column) => (numbers.includes(question.number) ? [column] : []))) : new Set(questions.map((_question, column) => column));
  const bins = barsOf(fromAddress('bins')) ?? 10;
  const view = fromAddress('view');
  return { view: view === 'list' || view === 'questions' ? view : 'charts', selected, bins };
}

/* --------------------------------------------------------------- widgets */

function Tile({ label, value, sub }) {
  return <div className="an-tile" title={sub ? `${label}: ${value} · ${sub}` : `${label}: ${value}`}><strong>{value}</strong><span>{label}{sub ? <small> · {sub}</small> : null}</span></div>;
}

/** Score bands as a ring: a slice per band and one for papers still to mark, each with its count and share in the legend. For reading: nothing here filters. */
function Donut({ bands }) {
  const [hover, setHover] = useState(null);
  const total = bands.reduce((sum, band) => sum + band.count, 0);
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const shown = bands.filter((band) => band.count > 0);
  // Between two bands, just a hairline of the card showing through.
  const gap = shown.length > 1 ? 0.7 : 0;
  // Pointing at a slice or its legend line: that band stands out, and the middle says its count.
  const pointed = bands.find((band) => band.id === hover && band.count > 0) || null;
  const point = (id) => ({ onPointerEnter: () => setHover(id), onPointerLeave: () => setHover((current) => (current === id ? null : current)) });
  let offset = 0;
  return (
    <div className="an-donut-box">
    <div className={`an-donut${pointed ? ' is-pointing' : ''}`}>
      <svg viewBox="0 0 140 140" role="img" aria-label={`Score bands: ${bands.map((band) => `${band.label} ${band.count}`).join(', ')}`}>
        <circle cx="70" cy="70" r={radius} fill="none" stroke="var(--bg-raised)" strokeWidth="18"/>
        {shown.map((band) => {
          const length = (band.count / total) * circumference;
          const slice = (
            <circle key={band.id} cx="70" cy="70" r={radius} fill="none" stroke={BAND_COLOURS[band.id]} strokeWidth={pointed?.id === band.id ? 23 : 18}
              strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`} strokeDashoffset={-offset} transform="rotate(-90 70 70)"
              className={`an-slice${pointed?.id === band.id ? ' is-on' : ''}`} {...point(band.id)}/>
          );
          offset += length;
          return slice;
        })}
        <text x="70" y="68" textAnchor="middle" className="an-donut-total">{pointed ? pointed.count : total}</text>
        <text x="70" y="86" textAnchor="middle" className="an-donut-word">
          {pointed ? `${pointed.label} · ${pointed.share}%` : total === 1 ? 'student' : 'students'}
        </text>
      </svg>
      <ul className="an-legend">
        {bands.map((band) => (
          <li key={band.id} className={`${band.count ? '' : 'is-empty'}${pointed?.id === band.id ? ' is-on' : ''}`.trim() || undefined} {...(band.count ? point(band.id) : {})}>
            <i style={{ background: BAND_COLOURS[band.id] }} aria-hidden="true"/>
            <span className="an-legend-label">{band.label}</span>
            <span className="an-legend-count">{band.count} · {band.share}%</span>
          </li>
        ))}
      </ul>
    </div>
    </div>
  );
}

const ON_BARS = [{ id: 'count', label: 'Students' }, { id: 'share', label: '% of class' }];

/** How many bars: any number typed, from 1 to MAX_BARS - or one of three suggestions. */
function BarsChoice({ bins, setBins }) {
  const [text, setText] = useState(String(bins));
  useLayoutEffect(() => { setText(String(bins)); }, [bins]);
  const typedBars = barsOf(text);
  return (
    <fieldset className="an-option">
      <legend>Bars</legend>
      <div className="an-bars-choice">
        <input className="text-input" type="number" inputMode="numeric" min="1" max={MAX_BARS} step="1" value={text} aria-label="Number of bars"
          onChange={(event) => { setText(event.target.value); const next = barsOf(event.target.value); if (next) setBins(next); }}/>
        <div className="an-bars-suggest" role="group" aria-label="Suggestions">
          {BAR_CHOICES.map((count) => (
            <button key={count} type="button" className={bins === count ? 'is-on' : undefined} aria-pressed={bins === count} onClick={() => setBins(count)}>{count}</button>
          ))}
        </div>
      </div>
      {text.trim() !== '' && !typedBars && <p className="an-option-note">A whole number from 1 to {MAX_BARS}.</p>}
    </fieldset>
  );
}

/** The marks chart's options, behind its Edit button: how many bars, what the bars say, the average and median lines. */
function ChartOptions({ bins, setBins, onBars, setOnBars, lines, setLines }) {
  const [open, setOpen] = useState(false);
  const { holder, panel, style, isDialog } = useFloatingPanel(open, setOpen, 'right', { dialog: true });
  const choice = (label, options, value, onPick) => (
    <fieldset className="an-option">
      <legend>{label}</legend>
      <div className="an-option-choices" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button key={String(option.id)} type="button" role="radio" aria-checked={value === option.id} className={value === option.id ? 'is-on' : undefined}
            onClick={() => onPick(option.id)}>{option.label}</button>
        ))}
      </div>
    </fieldset>
  );
  return (
    <div className="an-edit" ref={holder}>
      <button type="button" className={`an-edit-button${open ? ' is-open' : ''}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        <SlidersHorizontal size={15} aria-hidden="true"/>Edit
      </button>
      {open && createPortal(<>
        {isDialog && <div className="filter-backdrop" data-panel-backdrop="" aria-hidden="true" onClick={() => setOpen(false)}/>}
        <div ref={panel} className={`filter-panel an-options cols-1${isDialog ? ' is-dialog' : ''}`} role="dialog" aria-label="Marks chart options" style={style}>
          <div className="filter-panel-head">
            <strong>Marks chart</strong>
            <button type="button" className="filter-close" aria-label="Close" title="Close" onClick={() => setOpen(false)}><X size={17} aria-hidden="true"/></button>
          </div>
          <div className="an-options-body">
            <BarsChoice bins={bins} setBins={setBins}/>
            {choice('Numbers on the bars', ON_BARS, onBars, setOnBars)}
            {choice('Average and median lines', [{ id: true, label: 'Show' }, { id: false, label: 'Hide' }], lines, setLines)}
          </div>
          <div className="filter-panel-foot">
            <button type="button" className="button button-quiet button-small" onClick={() => { setBins(10); setOnBars('count'); setLines(true); }}>Reset</button>
            <button type="button" className="button button-primary button-small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      </>, document.body)}
    </div>
  );
}

/**
 * The marks chart: how many students scored in each slice of 0-100%, with
 * the group's average and median marked on it. A bar says its count on hover
 * and goes nowhere on a click. Its options are behind Edit.
 */
function Histogram({ histogram, stats, bins, setBins, onBars, setOnBars, lines, setLines }) {
  const most = Math.max(...histogram.bins.map((bin) => bin.count), 0);
  const total = histogram.bins.reduce((sum, bin) => sum + bin.count, 0);
  const label = (count) => (onBars === 'share' ? `${total ? Math.round((count / total) * 100) : 0}%` : String(count));
  const markers = lines ? [
    stats.average !== null && { id: 'average', word: 'Average', value: stats.average },
    stats.median !== null && { id: 'median', word: 'Median', value: stats.median }
  ].filter(Boolean) : [];
  return (
    <section className="card an-card an-histogram" aria-label="Marks">
      <header className="an-card-head">
        <h2>Marks</h2>
        <p className="an-note">Students in each band of marks{onBars === 'share' ? ', as a share of those shown' : ''}.</p>
        <ChartOptions bins={bins} setBins={setBins} onBars={onBars} setOnBars={setOnBars} lines={lines} setLines={setLines}/>
      </header>
      <figure className="ov-spread an-bars">
        <div className="ov-spread-plot" style={{ gridTemplateColumns: `repeat(${histogram.bins.length}, minmax(0, 1fr))` }}>
          {histogram.bins.map((bin) => {
            const tip = `${Math.round(bin.from)}–${Math.round(bin.to)}%: ${plural(bin.count, 'student')}${total ? ` (${Math.round((bin.count / total) * 100)}%)` : ''}`;
            return (
              <div key={bin.index} className="ov-spread-col" data-tip={tip} role="img" aria-label={tip}>
                {bin.count > 0 && (bin.count === most || histogram.bins.length <= 10) && <span className="ov-spread-label">{label(bin.count)}</span>}
                {/* In the purple of the score band its middle falls in. */}
                <span className="ov-spread-bar" style={{ height: most ? `${(bin.count / most) * 100}%` : 0, background: BAR_COLOURS[bandOf((bin.from + bin.to) / 2)] }}/>
              </div>
            );
          })}
          {markers.map((marker, index) => (
            <span key={marker.id} className={`an-marker is-${marker.id}${index ? ' is-second' : ''}${marker.value > 75 ? ' is-flip' : ''}`} style={{ left: `${Math.min(100, Math.max(0, marker.value))}%` }} aria-hidden="true">
              <em>{marker.word} {percentText(marker.value)}</em>
            </span>
          ))}
        </div>
        <figcaption className="ov-spread-axis" aria-hidden="true"><span>0%</span><span>50%</span><span>100%</span></figcaption>
      </figure>
    </section>
  );
}

/** A question's name, cut to fit a tip. */
const questionName = (question) => {
  const prompt = String(question.prompt || 'Picture question').replace(/\s+/g, ' ').trim();
  return `Q${question.number} · ${prompt.length > 110 ? `${prompt.slice(0, 107).trimEnd()}…` : prompt}`;
};
/**
 * The tip on a question, at once on hover (components/HoverTips): its name,
 * and how many got it right - as a number and a share of the answers marked.
 */
const questionTip = (question) => `${questionName(question)}\n${question.marked
  ? `${question.right} of ${question.marked} correct · ${Math.round((question.right / question.marked) * 100)}%`
  : 'Not marked yet'}`;
/** The tip's edge in the colour of how the question went. */
const questionTone = (question) => {
  const percent = question.marked ? (question.right / question.marked) * 100 : null;
  return percent === null ? null : percent >= 90 ? 'info' : percent >= 70 ? 'ok' : percent >= 50 ? 'warn' : 'danger';
};

/** The tallest a question's row grows to when there is room to spare. */
const QUESTION_ROW_MAX = 56;

/**
 * Every ticked question's average, as a share of what it is worth: one
 * column, a row each - its number and type, the question itself, a bar in
 * its score band's purple, the average, and how many got it right. A row
 * opens the rank list ordered by that question; hovering it shows the tip.
 */
function QuestionChart({ figures, onPick }) {
  return (
    <section className="card an-card an-qchart" aria-label="Question averages">
      <header className="an-card-head">
        <h2>Question averages</h2>
        <p className="an-note">Average marks on each question, over the answers already marked. Click a row to rank by it.</p>
        <ul className="an-qlegend" aria-label="Colours">
          {BANDS.map((band) => <li key={band.id}><i style={{ background: BAR_COLOURS[band.id] }} aria-hidden="true"/>{band.label}</li>)}
        </ul>
      </header>
      {figures.length ? (
        <div className="an-qbars" style={{ gridTemplateRows: `repeat(${figures.length}, minmax(36px, 1fr))`, maxHeight: '100%', height: `min(100%, ${figures.length * QUESTION_ROW_MAX}px)` }}>
          {figures.map((question) => {
            const percent = averagePercent(question);
            return (
              <button key={question.id} type="button" className="an-qbar" data-tip={questionTip(question)} data-tip-tone={questionTone(question) || undefined}
                aria-label={`${questionTip(question)}. Rank by this question.`} onClick={() => onPick(question.column)}>
                <span className="an-qbar-label">Q{question.number}</span>
                <span className="an-qbar-sub">{question.pending ? <em>{question.pending} ?</em> : TYPE_WORD[question.type]}</span>
                <span className="an-qbar-text">{question.prompt || 'Picture question'}</span>
                <span className="an-qbar-track">
                  <span className="an-qbar-fill" style={{ width: percent === null ? 0 : `${Math.max(1, percent)}%`, background: percent === null ? undefined : BAR_COLOURS[bandOf(percent)] }}/>
                </span>
                <span className="an-qbar-value">{percent === null ? '—' : percentText(percent)}</span>
                <span className="an-qbar-right">{question.marked ? <><b>{question.right}</b>/{question.marked} right</> : 'Not marked'}</span>
              </button>
            );
          })}
        </div>
      ) : <p className="an-empty">Tick at least one question under Questions.</p>}
    </section>
  );
}

/** One question's numbers, in words: its average, how many are marked, left blank, still to mark. */
const questionFacts = (question) => [
  question.average === null ? 'Nothing marked yet' : `Average ${marksText(question.average)} of ${marksText(question.worth)} (${percentText(averagePercent(question))})`,
  `${question.marked} marked`,
  question.blank ? `${question.blank} left blank` : null,
  question.pending ? `${question.pending} still to mark` : null
].filter(Boolean).join(' · ');

/**
 * Which questions count: a small tile per question - its number and average -
 * by type, with quick picks; every figure and both views use only the ticked
 * ones. A question is read in full in the strip at the foot: the one under the
 * pointer, or focused, or the one just tapped. Opens as a window (a sheet on
 * a phone), so a paper of any length fits without scrolling sideways.
 */
function QuestionPicker({ figures, selected, setSelected }) {
  const [open, setOpen] = useState(false);
  const { holder, panel, style, isDialog } = useFloatingPanel(open, setOpen, 'right', { dialog: 'always' });
  const [reading, setReading] = useState(null);
  useEffect(() => { if (!open) setReading(null); }, [open]);
  const types = ['mcq', 'msq', 'short'].filter((type) => figures.some((question) => question.type === type));
  const every = figures.length;
  const summary = selected.size === every ? 'All questions' : selected.size === 0 ? 'No questions' : `${selected.size} of ${every} questions`;
  const only = (type) => setSelected(new Set(figures.filter((question) => question.type === type).map((question) => question.column)));
  const toggle = (column) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(column)) next.delete(column); else next.add(column);
    return next;
  });
  const read = figures.find((question) => question.column === reading) || null;
  return (
    <div className="filter-menu an-qpicker" ref={holder}>
      <button type="button" className={`button button-secondary filter-trigger${selected.size !== every ? ' is-active' : ''}${open ? ' is-open' : ''}`}
        aria-expanded={open} aria-haspopup="dialog" title={`Questions: ${summary}`} onClick={() => setOpen((value) => !value)}>
        <ListChecks size={16} aria-hidden="true"/>
        <span className="filter-trigger-label toolbar-text">{summary}</span>
        <ChevronDown className="toolbar-chevron" size={15} strokeWidth={2.5} aria-hidden="true"/>
      </button>
      {open && createPortal(<>
        {isDialog && <div className="filter-backdrop" data-panel-backdrop="" aria-hidden="true" onClick={() => setOpen(false)}/>}
        <div ref={panel} className={`filter-panel an-qpanel cols-3${isDialog ? ' is-dialog' : ''}`} role="dialog" aria-label="Questions" style={style}>
          <div className="filter-panel-head">
            <strong>Questions</strong>
            <span>{selected.size} of {every} ticked</span>
            <button type="button" className="filter-close" aria-label="Close" title="Close" onClick={() => setOpen(false)}><X size={17} aria-hidden="true"/></button>
          </div>
          <div className="an-qpanel-quick" role="group" aria-label="Quick picks">
            <button type="button" onClick={() => setSelected(new Set(figures.map((question) => question.column)))}>All</button>
            <button type="button" onClick={() => setSelected(new Set())}>None</button>
            {types.length > 1 && types.map((type) => <button key={type} type="button" onClick={() => only(type)}>{TYPE_WORD[type]} only</button>)}
          </div>
          {/* A mouse reads a question by pointing; a finger always "leaves" when it lifts, so a tap reads it through the click instead. */}
          <div className="an-qpanel-body" onPointerLeave={(event) => { if (event.pointerType === 'mouse') setReading(null); }}>
            {types.map((type) => {
              const group = figures.filter((question) => question.type === type);
              const ticked = group.filter((question) => selected.has(question.column)).length;
              return (
                <section key={type} className="an-qgroup" aria-label={TYPE_WORD[type]}>
                  <h3>{TYPE_WORD[type]}<span>{ticked} of {group.length}</span></h3>
                  <div className="an-qgrid">
                    {group.map((question) => {
                      const on = selected.has(question.column);
                      const percent = averagePercent(question);
                      return (
                        <button key={question.id} type="button" className={`an-qtile${on ? ' is-on' : ''}${reading === question.column ? ' is-reading' : ''}`}
                          aria-pressed={on} aria-label={`Q${question.number}: ${question.prompt || 'Picture question'}. ${questionFacts(question)}`}
                          onPointerEnter={(event) => { if (event.pointerType === 'mouse') setReading(question.column); }} onFocus={() => setReading(question.column)}
                          onClick={() => { toggle(question.column); setReading(question.column); }}>
                          <span className="an-qtile-box" aria-hidden="true">{on && <Check size={11} strokeWidth={3.4}/>}</span>
                          <b>Q{question.number}</b>
                          <small>{percent === null ? '—' : percentText(percent)}</small>
                          {question.pending > 0 && <em className="an-qtile-wait" title={`${question.pending} still to mark`}>{question.pending}?</em>}
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
          <div className={`an-qread${read ? ' has-question' : ''}`} aria-live="polite">
            {read ? <>
              <p className="an-qread-title">
                <b>Q{read.number}</b><span>{TYPE_WORD[read.type]}</span>
                <span className={selected.has(read.column) ? 'is-in' : 'is-out'}>{selected.has(read.column) ? 'Counted' : 'Not counted'}</span>
              </p>
              <p className="an-qread-prompt">{read.prompt || 'A question with a picture only.'}</p>
              <p className="an-qread-facts">{questionFacts(read)}</p>
            </> : <p className="an-qread-hint">Point at a question - or tap it - to read it in full. Tapping also ticks or unticks it.</p>}
          </div>
          <div className="filter-panel-foot">
            <button type="button" className="button button-primary button-small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      </>, document.body)}
    </div>
  );
}

/** A typed number, or null for an empty box (that end left open). */
const typed = (text) => (String(text).trim() === '' ? null : Number(text));

/**
 * One from-to row of the Ranges block: two boxes, either left empty for an
 * open end, and Min and Max to fill an end with the lowest or highest there
 * is - full marks, the last rank - without having to know it. Whatever is
 * typed is used as it is; under it, how many students it takes.
 */
function SpanRow({ title, suffix, lowest, highest, step, span, setSpan, countIn, noun, extra = null }) {
  const [from, setFrom] = useState(span.from === null ? '' : String(span.from));
  const [to, setTo] = useState(span.to === null ? '' : String(span.to));
  // A Clear or Reset from outside shows in the boxes at once, before the next paint.
  useLayoutEffect(() => { setFrom(span.from === null ? '' : String(span.from)); setTo(span.to === null ? '' : String(span.to)); }, [span.from, span.to]);
  const low = typed(from);
  const high = typed(to);
  const valid = (low === null || Number.isFinite(low)) && (high === null || Number.isFinite(high))
    && (low === null || high === null || low <= high) && (low === null || low >= 0);
  const open = low === null && high === null;
  // Whatever is typed is kept; a range that makes no sense (backwards, say) filters nothing until it does.
  const commit = (nextFrom, nextTo) => {
    const a = typed(nextFrom);
    const b = typed(nextTo);
    if ((a === null || Number.isFinite(a)) && (b === null || Number.isFinite(b))) setSpan({ ...span, from: a, to: b });
  };
  const count = valid ? countIn(low ?? lowest, high ?? highest) : null;
  const end = (which) => {
    const isFrom = which === 'from';
    const value = isFrom ? from : to;
    const fill = String(isFrom ? lowest : highest);
    return (
      <div className="an-span-end">
        <input className="text-input" type="number" inputMode="decimal" step={step} min="0" value={value} placeholder={isFrom ? 'From' : 'To'}
          aria-label={`${title} ${isFrom ? 'from' : 'to'}${suffix ? ` (${suffix})` : ''}`}
          onChange={(event) => { if (isFrom) { setFrom(event.target.value); commit(event.target.value, to); } else { setTo(event.target.value); commit(from, event.target.value); } }}/>
        <button type="button" className="an-span-fill" onClick={() => { if (isFrom) { setFrom(fill); commit(fill, to); } else { setTo(fill); commit(from, fill); } }}
          aria-label={`${title} ${isFrom ? 'from the lowest' : 'to the highest'} (${fill}${suffix})`} data-tip={`${isFrom ? 'Lowest' : 'Highest'}: ${fill}${suffix}`}>
          {isFrom ? 'Min' : 'Max'}
        </button>
      </div>
    );
  };
  return (
    <div className="an-span">
      <div className="an-span-head">
        <span className="an-span-title">{title}</span>
        {extra}
        {!open && <button type="button" className="an-span-fill an-span-clear" onClick={() => setSpan({ ...span, from: null, to: null })}>Clear</button>}
      </div>
      <div className="an-span-row">
        {end('from')}
        <span className="an-span-to" aria-hidden="true">–</span>
        {end('to')}
        {suffix && <b className="an-span-unit">{suffix}</b>}
      </div>
      <p className={`an-range-count${valid ? '' : ' is-wrong'}`} aria-live="polite">
        {!valid ? 'From must be 0 or more, and no more than To.'
          : open ? 'Any'
            : <><strong>{count.within}</strong> of {plural(count.of, noun)}</>}
      </p>
    </div>
  );
}

/**
 * Ranges, at the top of Sort & filter: marks - in marks or as a % of the
 * ticked questions - and rank. Fully marked papers only: one still to mark
 * has no final mark or rank yet ("Still to mark" under Marking finds those).
 */
function RangesFilter({ marks, setMarks, rank, setRank, rows, classFigures }) {
  const marked = rows.filter((row) => row.counted);
  const percentUnit = marks.unit !== 'marks';
  const fullMarks = classFigures.maxMarks || 0;
  return (
    <fieldset className="an-range">
      <legend>Ranges</legend>
      <SpanRow
        key={marks.unit}
        title="Marks" suffix={percentUnit ? '%' : ''} lowest={0} highest={percentUnit ? 100 : fullMarks} step="any" span={marks} setSpan={setMarks} noun="paper"
        countIn={(low, high) => ({ of: marked.length, within: marked.filter((row) => { const value = percentUnit ? row.percent : row.secured; return value >= low - 1e-9 && value <= high + 1e-9; }).length })}
        extra={(
          <div className="an-unit" role="radiogroup" aria-label="Marks in">
            {[{ id: 'marks', label: 'Marks' }, { id: 'percent', label: '%' }].map((option) => (
              <button key={option.id} type="button" role="radio" aria-checked={marks.unit === option.id} className={marks.unit === option.id ? 'is-on' : undefined}
                onClick={() => { if (marks.unit !== option.id) setMarks({ unit: option.id, from: null, to: null }); }}>{option.label}</button>
            ))}
          </div>
        )}
      />
      <SpanRow
        title="Rank" suffix="" lowest={1} highest={classFigures.lastRank || 1} step="1" span={rank} setSpan={setRank} noun="student"
        countIn={(low, high) => ({ of: marked.length, within: marked.filter((row) => row.rank !== null && row.rank >= low && row.rank <= high).length })}
      />
    </fieldset>
  );
}

const CELL_RESULT = { O: 'Right', P: 'Part marks', W: 'Wrong', B: 'Left blank' };
const CELL_TONE = { O: 'ok', P: 'warn', W: 'danger', Q: 'warn' };
/** One answer in the rank list: its marks, coloured by how it went (? not marked yet, – blank); its question and the result on hover. */
/**
 * One answer's tile. A click opens that very answer in the marking window -
 * to mark one still to mark (?), or to see or change any other.
 */
function Cell({ cell, question, onOpen }) {
  const result = cell.state === '.' ? 'Not on their paper' : cell.state === 'Q' ? 'Not marked yet · click to mark'
    : `${CELL_RESULT[cell.state]} · ${marksText(cell.marks)} of ${marksText(question.worth)}`;
  const tip = `${questionName(question)}\n${result}`;
  if (cell.state === '.') return <td className="an-cell is-none" data-tip={tip}/>;
  const text = cell.state === 'Q' ? '?' : cell.state === 'B' ? '–' : marksText(cell.marks);
  return (
    <td className={`an-cell is-${cell.state}`} data-tip={tip} data-tip-tone={CELL_TONE[cell.state]}>
      <button type="button" className="an-cell-open" onClick={onOpen} aria-label={`Q${question.number}: ${cell.state === 'Q' ? 'not marked yet - mark it' : `${CELL_RESULT[cell.state]} - open it`}`}>{text}</button>
    </td>
  );
}

/** What they did while writing, a line each - the Flags button's tip. */
const flagLines = (flags) => [
  flags.left > 0 && `Left the page ${plural(flags.left, 'time')}`,
  flags.locked > 0 && `Locked ${plural(flags.locked, 'time')}`,
  flags.copyPaste > 0 && `Tried to copy or paste ${plural(flags.copyPaste, 'time')}`
].filter(Boolean);

function Flags({ flags }) {
  const items = [
    flags.left > 0 && { key: 'left', icon: LogOut, count: flags.left, tip: `Left the page ${plural(flags.left, 'time')}` },
    flags.locked > 0 && { key: 'locked', icon: Lock, count: flags.locked, tip: `Locked ${plural(flags.locked, 'time')}` },
    flags.copyPaste > 0 && { key: 'copy', icon: ClipboardPaste, count: flags.copyPaste, tip: `Tried to copy or paste ${plural(flags.copyPaste, 'time')}` }
  ].filter(Boolean);
  if (!items.length) return <span className="an-flags-none">—</span>;
  return (
    <span className="an-flags">
      {items.map((item) => <span key={item.key} className={`an-flag is-${item.key}`}><item.icon size={13} aria-hidden="true"/>{item.count}</span>)}
    </span>
  );
}

/** The answer tiles' colours, in words - inline when the list has room, behind Key when it has not. */
const CELL_KEY = [
  { state: 'O', label: 'Right', meaning: 'Full marks for the answer' },
  { state: 'P', label: 'Part marks', meaning: 'Some of its marks' },
  { state: 'W', label: 'Wrong', meaning: 'No marks' },
  { state: 'B', label: 'Blank', meaning: 'Left unanswered - counts as 0' },
  { state: 'Q', label: 'Not marked yet', meaning: 'A short answer waiting for your marks' },
  { state: 'none', label: 'Not on their paper', meaning: 'This question was not in their draw' }
];

/**
 * The key as one button, for a list too narrow to show it beside its title
 * (a phone, a small window): the colours, the badges and how ranks are
 * given, in a window of their own.
 */
function KeyButton({ summary }) {
  const [open, setOpen] = useState(false);
  const { holder, panel, style, isDialog } = useFloatingPanel(open, setOpen, 'right', { dialog: true });
  return (
    <div className="an-key-holder" ref={holder}>
      <button type="button" className="an-key-button" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
        <Info size={15} aria-hidden="true"/>Key
      </button>
      {open && createPortal(<>
        {isDialog && <div className="filter-backdrop" data-panel-backdrop="" aria-hidden="true" onClick={() => setOpen(false)}/>}
        <div ref={panel} className={`filter-panel an-keypanel cols-1${isDialog ? ' is-dialog' : ''}`} role="dialog" aria-label="How to read the rank list" style={style}>
          <div className="filter-panel-head">
            <strong>How to read the list</strong>
            <button type="button" className="filter-close" aria-label="Close" title="Close" onClick={() => setOpen(false)}><X size={17} aria-hidden="true"/></button>
          </div>
          <div className="an-keypanel-body">
            <p className="an-keypanel-summary">{summary}</p>
            <h3>Each answer</h3>
            <ul className="an-keylist">
              {CELL_KEY.map((entry) => (
                <li key={entry.state}><i className={`is-${entry.state}`} aria-hidden="true"/><b>{entry.label}</b><span>{entry.meaning}</span></li>
              ))}
            </ul>
            <h3>Ranks and marks</h3>
            <ul className="an-keylist is-marks">
              <li><span className="an-rank-no is-top is-1" aria-hidden="true">1</span><b>Top three</b><span>Gold, silver and bronze</span></li>
              <li><span className="an-rank-wait" aria-hidden="true">—</span><b>Not ranked</b><span>Until every answer is marked - and never on 0 marks</span></li>
              <li><em aria-hidden="true">+6?</em><b>Still to come</b><span>The most its unmarked answers can add</span></li>
            </ul>
          </div>
          <div className="filter-panel-foot">
            <button type="button" className="button button-primary button-small" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      </>, document.body)}
    </div>
  );
}

/**
 * One student at a glance, for a list too narrow to show their marks and
 * answers (a phone, a small window): their rank, marks and time, how many
 * answers went each way, and every question on their paper as a tile - with
 * the way on to their paper, to mark it, and to their activity log.
 */
function StudentCard({ row, questions, columns, onClose, onReview, onLog }) {
  const cells = columns.map((column) => ({ column, question: questions[column], ...cellOf(row.student, column, questions) }))
    .filter((cell) => cell.state !== '.');
  const counts = Object.fromEntries(['O', 'P', 'W', 'B', 'Q'].map((state) => [state, cells.filter((cell) => cell.state === state).length]));
  const { flags } = row.student;
  const flagWords = [
    flags.left > 0 && `left the page ${plural(flags.left, 'time')}`,
    flags.locked > 0 && `locked ${plural(flags.locked, 'time')}`,
    flags.copyPaste > 0 && `tried to copy or paste ${plural(flags.copyPaste, 'time')}`
  ].filter(Boolean);
  return (
    <Modal label={`${row.student.name}: marks and answers`} onClose={onClose} className="an-student-sheet">
      <header className="an-student-head">
        {row.rank ? <span className={`an-rank-no${row.rank <= 3 ? ` is-top is-${row.rank}` : ''}`}>{row.rank}</span>
          : <span className="an-rank-wait" title={row.counted ? 'No rank on 0 marks' : 'Not ranked until every answer is marked'}>—</span>}
        <div>
          <h2>{row.student.name}</h2>
          <p>{[row.student.sapId, row.rank ? `Rank ${row.rank}` : 'Not ranked yet', `${minutes(row.student.seconds)} taken`].filter(Boolean).join(' · ')}</p>
        </div>
      </header>
      <div className="an-student-score">
        <strong>{row.inSelection ? marksText(row.secured) : '—'}<small>/{marksText(row.max)}</small></strong>
        <span className="an-student-pct">{percentText(row.percent)}</span>
        {row.pendingMax > 0 && <em>+ up to {marksText(row.pendingMax)} still to mark</em>}
      </div>
      <ul className="an-student-counts" aria-label="Answers">
        {CELL_KEY.filter((entry) => entry.state !== 'none').map((entry) => (
          <li key={entry.state} className={`is-${entry.state}${counts[entry.state] ? '' : ' is-zero'}`}><b>{counts[entry.state]}</b>{entry.label}</li>
        ))}
      </ul>
      <h3 className="an-student-title">Question by question</h3>
      <div className="an-student-grid">
        {cells.map((cell) => (
          <button key={cell.column} type="button" className={`an-student-tile is-${cell.state}`} onClick={() => { onClose(); onReview(row.student.id, cell.question.id); }}
            title={`Q${cell.question.number}: ${STATE_NAMES[cell.state]} - ${cell.question.prompt || 'Picture question'}`}
            aria-label={`Q${cell.question.number}: ${STATE_NAMES[cell.state]}${cell.state === 'Q' ? ' - mark it' : ' - open it'}`}>
            <b>Q{cell.question.number}</b>
            <small>{cell.state === 'Q' ? '?' : cell.state === 'B' ? '–' : `${marksText(cell.marks)}/${marksText(cell.question.worth)}`}</small>
          </button>
        ))}
      </div>
      {flagWords.length > 0 && <p className="an-student-flags"><LogOut size={14} aria-hidden="true"/>While writing: {flagWords.join(', ')}</p>}
      <div className="an-student-actions">
        <button type="button" className="button button-secondary" onClick={onClose}>Close</button>
        <button type="button" className="button button-secondary" onClick={() => { onClose(); onLog(row.student.id, { sapId: row.student.sapId, name: row.student.name }); }}>
          <ScrollText size={16} aria-hidden="true"/>Activity log
        </button>
        <button type="button" className="button button-primary" onClick={() => { onClose(); onReview(row.student.id); }}>
          <PenLine size={16} aria-hidden="true"/>Open the paper to mark
        </button>
      </div>
    </Modal>
  );
}

const ROW = 34;
/** An answer tile's narrowest and widest: with room to spare it grows towards the widest, and Flags keeps FLAGS_ROOM. */
const TILE = 34;
const TILE_MOST = 46;
const FLAGS_ROOM = 170;
/** Over this many rows the list draws only those in view (and a few either side). */
const WINDOW_FROM = 150;

function RankList({ view, questions, sort, setSort, onReview, onLog, summary, total }) {
  const scroller = useRef(null);
  const [card, setCard] = useState(null);
  const cardRow = card ? view.rows.find((row) => row.student.id === card) : null;
  const [frame, setFrame] = useState({ top: 0, height: 600 });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const measure = () => setFrame({ top: element.scrollTop, height: element.clientHeight });
    measure();
    element.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => { element.removeEventListener('scroll', measure); observer?.disconnect(); };
  }, []);
  // A wide window and few questions: the tiles grow into the room (easier to read and to click)
  // rather than leaving it all to Flags. Flags takes whatever is left, so its width says how much there is.
  const [tile, setTile] = useState(TILE);
  const count = view.columns.length;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !count) return undefined;
    const fit = () => {
      const flags = element.querySelector('thead th.an-col-flags');
      if (!flags || !flags.offsetWidth) { setTile(TILE); return; }
      setTile((current) => {
        const spare = flags.offsetWidth - FLAGS_ROOM + count * (current - TILE);
        return Math.max(TILE, Math.min(TILE_MOST, TILE + Math.floor(spare / count)));
      });
    };
    fit();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [count]);
  const rows = view.shown;
  const windowed = rows.length > WINDOW_FROM;
  const first = windowed ? Math.max(0, Math.floor(frame.top / ROW) - 10) : 0;
  const last = windowed ? Math.min(rows.length, Math.ceil((frame.top + frame.height) / ROW) + 10) : rows.length;
  const [sortField, sortDir] = sort.split('-');
  const header = (field, label, extra = '', firstWay = 'asc', tip = null) => {
    const on = sortField === field;
    const next = () => setSort(`${field}-${on ? (sortDir === 'asc' ? 'desc' : 'asc') : firstWay}`);
    return (
      <th className={`${extra}${on ? ' is-sorted' : ''}`} aria-sort={on ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button type="button" onClick={next} data-tip={tip?.text} data-tip-tone={tip?.tone || undefined}>{label}{on ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}</button>
      </th>
    );
  };
  const columnCount = 7 + view.columns.length;
  return (
    <section className="an-sheet" aria-label="Rank list">
      <header className="an-sheet-head">
        <h2>Rank list</h2>
        <p>{summary}</p>
        <div className="an-key" aria-label="Key">
          {CELL_KEY.map((entry) => <span key={entry.state} className={`is-${entry.state}`}><i/>{entry.label}</span>)}
        </div>
        <KeyButton summary={summary}/>
      </header>
      <div className="an-table" ref={scroller} style={{ '--tile': `${tile}px` }}>
        <table>
          <thead>
            <tr>
              {header('rank', 'Rank', 'an-sticky an-col-rank')}
              {header('name', 'Student', 'an-sticky an-col-name')}
              {header('total', 'Marks', 'an-sticky an-col-total', 'desc')}
              <th className="an-sticky an-col-pct">%</th>
              {view.columns.map((column) => header(`q${column}`, `Q${questions[column].number}`, 'an-col-q', 'desc',
                { text: questionTip(view.questions[column]), tone: questionTone(view.questions[column]) }))}
              {header('time', 'Time', 'an-col-time')}
              <th className="an-col-flags">Flags</th>
              <th className="an-col-more"><span className="sr-only">Marks and answers</span></th>
            </tr>
          </thead>
          <tbody>
            {windowed && first > 0 && <tr className="an-spacer" style={{ height: first * ROW }}><td colSpan={columnCount}/></tr>}
            {rows.slice(first, last).map((row) => (
              <tr key={row.student.id} className={row.counted ? undefined : 'is-unranked'}>
                <td className="an-sticky an-col-rank">
                  {row.rank ? <span className={`an-rank-no${row.rank <= 3 ? ` is-top is-${row.rank}` : ''}`}>{row.rank}</span>
                    : <span className="an-rank-wait" data-tip={row.counted ? 'No rank on 0 marks' : 'Not ranked until every answer is marked'}>—</span>}
                </td>
                <td className="an-sticky an-col-name">
                  <button type="button" className="an-name" onClick={() => onReview(row.student.id)} title={`${row.student.name}${row.student.sapId ? ` · ${row.student.sapId}` : ''} - open the paper`}>
                    {row.student.name}
                  </button>
                </td>
                <td className="an-sticky an-col-total">
                  {row.inSelection ? <>{marksText(row.secured)}<small>/{marksText(row.max)}</small>{row.pendingMax ? <em title={`Up to ${marksText(row.pendingMax)} more once marked`}> +{marksText(row.pendingMax)}?</em> : null}</> : '—'}
                </td>
                <td className="an-sticky an-col-pct">
                  {row.percent === null ? '—' : (
                    <span className="an-pct"><b>{percentText(row.percent)}</b><span className="an-pct-track"><i style={{ width: `${Math.min(100, row.percent)}%` }}/></span></span>
                  )}
                </td>
                {view.columns.map((column) => (
                  <Cell key={column} cell={cellOf(row.student, column, questions)} question={questions[column]} onOpen={() => onReview(row.student.id, questions[column].id)}/>
                ))}
                <td className="an-col-time">{minutes(row.student.seconds)}</td>
                <td className="an-col-flags">
                  {/* Their activity log - the Students tab's Log - with the way on to their answers. */}
                  <button type="button" className="an-flags-button" onClick={() => onLog(row.student.id, { sapId: row.student.sapId, name: row.student.name })} aria-label={`${row.student.name}: activity log`}
                    data-tip={[...flagLines(row.student.flags), 'Open their activity log'].join('\n')} data-tip-tone={flagLines(row.student.flags).length ? 'warn' : undefined}>
                    <Flags flags={row.student.flags}/>
                  </button>
                </td>
                <td className="an-col-more">
                  <button type="button" className="an-row-card" onClick={() => setCard(row.student.id)} aria-label={`${row.student.name}: marks and answers`} data-tip="Marks and answers">
                    <ChevronRight size={17} aria-hidden="true"/>
                  </button>
                </td>
              </tr>
            ))}
            {windowed && last < rows.length && <tr className="an-spacer" style={{ height: (rows.length - last) * ROW }}><td colSpan={columnCount}/></tr>}
          </tbody>
        </table>
        {!rows.length && <p className="an-empty">{total ? 'Nobody matches these filters.' : 'No papers yet.'}</p>}
      </div>
      {/* On <body>: the list is a size container, which would hold a full-screen window inside it. */}
      {cardRow && createPortal(<StudentCard row={cardRow} questions={questions} columns={view.columns} onClose={() => setCard(null)} onReview={onReview} onLog={onLog}/>, document.body)}
    </section>
  );
}

/** The list as it stands - filters, ticked questions and order - as a CSV file. */
function exportCsv(code, view, questions) {
  // A name typed to look like a formula (= + - @) stays text when the file opens in Excel.
  const quote = (value) => {
    const text = String(value ?? '');
    const safe = typeof value === 'string' && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const head = ['Rank', 'Name', 'SAP ID', 'Marks', 'Up to (to mark)', 'Out of', 'Percent', 'Time (min)', 'Left the page', 'Locked', 'Copy or paste',
    ...view.columns.map((column) => `Q${questions[column].number}`)];
  const lines = view.shown.map((row) => [
    row.rank ?? '', row.student.name, row.student.sapId ?? '', row.inSelection ? row.secured : '', row.pendingMax || '', row.max || '',
    row.percent === null ? '' : Math.round(row.percent * 10) / 10, row.student.seconds === null ? '' : Math.round(row.student.seconds / 60),
    row.student.flags.left, row.student.flags.locked, row.student.flags.copyPaste,
    ...view.columns.map((column) => {
      const cell = cellOf(row.student, column, questions);
      return cell.state === 'Q' ? 'to mark' : cell.state === 'B' ? 'blank' : cell.state === '.' ? '' : cell.marks;
    })
  ]);
  const blob = new Blob([[head, ...lines].map((line) => line.map(quote).join(',')).join('\r\n')], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${code}-analysis.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

/* ------------------------------------------------------------------ the tab */

function AnalysisView({ test, matrix, onReview, onLog }) {
  const { questions } = matrix;
  const [choices, setChoices] = useState(() => initialChoices(questions));
  const [search, setSearch] = useState('');
  const [ticked, setTicked] = useState([]);
  const [marks, setMarks] = useState({ unit: 'marks', from: null, to: null });
  const [rank, setRank] = useState({ from: null, to: null });
  const [listSort, setListSort] = useState('rank-asc');
  const [chartSort, setChartSort] = useState('number-asc');
  const [onBars, setOnBars] = useState('count');
  const [lines, setLines] = useState(true);
  const { view: mode, selected, bins } = choices;
  const set = (patch) => setChoices((current) => ({ ...current, ...(typeof patch === 'function' ? patch(current) : patch) }));
  const filters = useMemo(() => ({
    search,
    // Marks in %: an open end is 0 or 100. In marks, or a rank: an open end has no limit.
    range: marks.unit === 'marks' ? null : { from: marks.from ?? 0, to: marks.to ?? 100 },
    marksRange: marks.unit === 'marks' && (marks.from !== null || marks.to !== null) ? { from: marks.from ?? 0, to: marks.to ?? Infinity } : null,
    rankRange: rank.from !== null || rank.to !== null ? { from: rank.from ?? 1, to: rank.to ?? Infinity } : null,
    average: ticked.filter((id) => id.startsWith('avg:')).map((id) => id.slice(4)),
    median: ticked.filter((id) => id.startsWith('med:')).map((id) => id.slice(4)),
    marking: ticked.filter((id) => id.startsWith('mark:')).map((id) => id.slice(5)),
    flags: ticked.filter((id) => id.startsWith('flag:')).map((id) => id.slice(5))
  }), [search, ticked, marks, rank]);
  const sortKey = useMemo(() => listSortOf(listSort), [listSort]);
  const view = useMemo(() => compute(matrix, { selected, bins, filters, sort: sortKey }), [matrix, selected, bins, filters, sortKey]);

  // The choices in the address, so a reload or a shared link opens the same view; gone again on leaving the tab.
  useEffect(() => {
    const url = new URL(window.location.href);
    const keep = (key, value) => (value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value));
    const all = selected.size === questions.length;
    keep('view', mode === 'charts' ? null : mode);
    keep('qs', all ? null : selected.size ? [...selected].sort((a, b) => a - b).map((column) => questions[column].number).join(',') : 'none');
    keep('bins', bins === 10 ? null : String(bins));
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [mode, selected, bins, questions]);
  useEffect(() => () => {
    const url = new URL(window.location.href);
    ADDRESS_KEYS.forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(window.history.state, '', url);
  }, []);
  // A question no longer ticked cannot order the list.
  useEffect(() => {
    const { key } = listSortOf(listSort);
    if (typeof key === 'number' && !selected.has(key)) setListSort('rank-asc');
  }, [selected, listSort]);

  const fullyMarked = matrix.students.filter((student) => !student.st.includes('Q')).length;
  const marked = matrix.students.length ? Math.round((fullyMarked / matrix.students.length) * 100) : 0;
  const { stats } = view;
  const inMarks = stats.fullMarks !== null;
  const figure = (marksValue, percent) => (inMarks && marksValue !== null ? `${marksText(marksValue)}/${marksText(stats.fullMarks)}` : percentText(percent));
  const ran = test.startedAt && test.closedAt ? (Date.parse(test.closedAt) - Date.parse(test.startedAt)) / 1000 : null;
  const meta = [
    test.startedAt && `Held ${shortDateTime(test.startedAt)}`,
    ran !== null && ran >= 60 ? `ran ${durationLabel(ran)}` : test.durationMinutes ? `${test.durationMinutes} min` : null,
    stats.fullMarks !== null && `${marksText(stats.fullMarks)} marks`,
    `${plural(test.questionCount, 'question')} each`,
    `${plural(matrix.students.length, 'paper')}`
  ].filter(Boolean).join(' · ');
  const { classFigures } = view;
  const groups = useMemo(() => {
    const versus = (id, word, value) => ({
      id, title: `Class ${word}${value === null ? '' : ` · ${percentText(value)}`}`,
      options: [
        { id: `${id}:above`, label: `At or above ${word}`, test: (row) => row.counted && value !== null && row.percent >= value - 1e-9 },
        { id: `${id}:below`, label: `Below ${word}`, test: (row) => row.counted && value !== null && row.percent < value - 1e-9 }
      ]
    });
    return [versus('avg', 'average', classFigures.average), versus('med', 'median', classFigures.median), ...FILTER_GROUPS];
  }, [classFigures.average, classFigures.median]);
  const labels = Object.fromEntries(groups.flatMap((group) => group.options.map((option) => [option.id, option.label])));
  const percentOn = rangeOf(filters.range);
  const marksOn = spanOf(filters.marksRange);
  const rankOn = spanOf(filters.rankRange);
  const end = (value) => (value === Infinity ? 'max' : marksText(value));
  const rangeChips = [
    percentOn && { key: 'range', text: `Marks ${marksText(percentOn.from)}–${marksText(percentOn.to)}%`, clear: () => setMarks({ unit: 'percent', from: null, to: null }) },
    marksOn && { key: 'marks', text: `Marks ${end(marksOn.from)}–${end(marksOn.to)} of ${marksText(classFigures.maxMarks)}`, clear: () => setMarks({ unit: 'marks', from: null, to: null }) },
    rankOn && { key: 'rank', text: `Rank ${end(rankOn.from)}–${end(rankOn.to)}`, clear: () => setRank({ from: null, to: null }) }
  ].filter(Boolean);
  const chips = [
    ...rangeChips,
    ...ticked.map((id) => ({ key: id, text: labels[id], clear: () => setTicked((current) => current.filter((entry) => entry !== id)) }))
  ];
  const rankBy = (column) => { setListSort(`q${column}-desc`); set({ view: 'list' }); };
  // A question the list is sorted by: in the Sort group, so the menu says so.
  const sortedColumn = listSortOf(listSort).key;
  const listSorts = typeof sortedColumn === 'number' && questions[sortedColumn]
    ? [...LIST_SORTS, { id: `q${sortedColumn}`, label: `Q${questions[sortedColumn].number} marks`, icon: ListChecks, directions: [{ id: 'desc', label: 'Highest first' }, { id: 'asc', label: 'Lowest first' }] }]
    : LIST_SORTS;
  const pendingAnswers = view.questions.reduce((sum, question) => sum + (selected.has(question.column) ? question.pending : 0), 0);
  const listSummary = [
    `${plural(stats.ranked, 'paper')} ranked`,
    stats.onZero ? `${stats.onZero} on 0 marks (no rank)` : null,
    stats.pendingPapers ? `${stats.pendingPapers} waiting for marking (unranked, at the bottom)` : null,
    stats.average !== null ? `average ${percentText(stats.average)}` : null,
    'level marks share a rank, the faster first'
  ].filter(Boolean).join(' · ');

  return (
    <div className={`an-view is-${mode}`}>
      <section className="card an-bar">
        <div className="an-meta">
          <p title={meta}>{meta}</p>
          <span className="an-count">Showing {view.shown.length} of {matrix.students.length}</span>
          <div className="an-progress" title={`${fullyMarked} of ${matrix.students.length} papers fully marked`}>
            <span className="an-progress-track"><span style={{ width: `${marked}%` }}/></span>
            <span>Marking {marked}% done</span>
          </div>
          <button type="button" className="button button-view an-export" onClick={() => exportCsv(test.code, view, questions)} title="The rank list as it stands, as a CSV file">
            <Download size={15} aria-hidden="true"/><span className="an-word">Export</span>
          </button>
        </div>
        <div className="an-filters">
          <div className="an-views" role="group" aria-label="View">
            {VIEWS.map((option) => (
              <button key={option.id} type="button" aria-pressed={mode === option.id} onClick={() => set({ view: option.id })} aria-label={option.label} data-tip={option.label}>
                <option.icon size={16} aria-hidden="true"/><span className="an-word">{option.label}</span>
              </button>
            ))}
          </div>
          <label className="search-field an-search">
            <Search size={15} aria-hidden="true"/>
            <input className="text-input" type="search" placeholder="Search name or SAP ID" value={search}
              onChange={(event) => setSearch(event.target.value)} aria-label="Search students"/>
          </label>
          <FilterMenu
            groups={groups} rows={view.rows} selected={ticked} onChange={setTicked} icons={FILTER_ICONS}
            title={mode === 'list' ? 'Sort & filter the rank list' : mode === 'questions' ? 'Sort & filter the questions' : 'Filter the charts'} allLabel="Everyone"
            total={matrix.students.length} shown={view.shown.length}
            sorts={mode === 'list' ? listSorts : mode === 'questions' ? CHART_SORTS : null}
            sort={mode === 'list' ? listSort : chartSort}
            onSort={mode === 'list' ? setListSort : setChartSort}
            sortHint={mode === 'list' ? 'Or click a column in the list - a question\'s too.' : 'The order of the question bars.'}
            extra={<RangesFilter marks={marks} setMarks={setMarks} rank={rank} setRank={setRank} rows={view.rows} classFigures={classFigures}/>}
            extraActive={rangeChips.length} extraLabel={rangeChips.length === 1 ? rangeChips[0].text : null}
            onReset={() => { setMarks({ unit: 'marks', from: null, to: null }); setRank({ from: null, to: null }); }}
          />
          <QuestionPicker figures={view.questions} selected={selected} setSelected={(next) => set((current) => ({ selected: typeof next === 'function' ? next(current.selected) : next }))}/>
          {chips.map((chip) => (
            <button key={chip.key} type="button" className="an-chip" onClick={chip.clear} title="Remove this filter">{chip.text}<X size={13} aria-hidden="true"/></button>
          ))}
        </div>
      </section>

      {mode === 'charts' ? <>
        <div className="an-tiles">
          <Tile label="Attempted" value={stats.attempted} sub={`${stats.absent} ${test.isClosed ? 'absent' : 'not begun'}${stats.writing ? `, ${stats.writing} writing` : ''}`}/>
          <Tile label="Average" value={figure(stats.averageMarks, stats.average)} sub={inMarks ? percentText(stats.average) : null}/>
          <Tile label="Median" value={figure(stats.medianMarks, stats.median)} sub={inMarks ? percentText(stats.median) : null}/>
          <Tile label="Highest" value={figure(stats.highestMarks, stats.highest)} sub={inMarks ? percentText(stats.highest) : null}/>
          <Tile label="Lowest" value={figure(stats.lowestMarks, stats.lowest)} sub={inMarks ? percentText(stats.lowest) : null}/>
          <Tile label="To mark" value={stats.pendingPapers} sub={stats.pendingPapers ? plural(pendingAnswers, 'answer') : 'all marked'}/>
        </div>
        <div className="an-charts">
          <section className="card an-card" aria-label="Score bands">
            <header className="an-card-head"><h2>Score bands</h2></header>
            <Donut bands={view.bands}/>
          </section>
          <Histogram histogram={view.histogram} stats={stats} bins={bins} setBins={(value) => set({ bins: value })}
            onBars={onBars} setOnBars={setOnBars} lines={lines} setLines={setLines}/>
        </div>
      </> : mode === 'questions' ? (
        <QuestionChart figures={orderQuestions(view.questions, selected, chartSort)} onPick={rankBy}/>
      ) : (
        <RankList view={view} questions={questions} sort={listSort} setSort={setListSort} onReview={onReview} onLog={onLog}
          summary={listSummary} total={matrix.students.length}/>
      )}
    </div>
  );
}

export function AnalysisSection({ test, counts, serverTime, refresh = 0, onReview, onLog }) {
  const live = test.isStarted && !test.isClosed;
  const fitRef = useFitToScreen(true);
  const matrix = useOverview(test.code, {
    enabled: true, live, matrix: true,
    // `refresh`: marks given or changed in the review (DashboardScreen).
    signature: [counts.submitted, counts.awaitingMarking, test.isClosed, test.resultsFrozenAt, refresh, live ? serverTime : ''].join('|')
  });
  return (
    <div ref={fitRef} className="an">
      {!matrix ? <div className="card ov-panel ov-wait" aria-busy="true">Working out the analysis…</div>
        : !matrix.students.length ? <div className="card ov-panel"><p className="ov-empty">The analysis appears here once papers are handed in.</p></div>
          : <AnalysisView key={matrix.questions.map((question) => question.id).join(',')} test={{ ...test, ...matrix.test, code: test.code }} matrix={matrix} onReview={onReview} onLog={onLog}/>}
    </div>
  );
}
