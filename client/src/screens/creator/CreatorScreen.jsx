import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ClipboardPaste, Copy, Download, Eraser, FileUp, Plus } from 'lucide-react';
import { api, post } from '../../lib/api.js';
import { dropCached } from '../../lib/cache.js';
import { firstInvalidField } from '../../lib/form-validation.js';
import { copyText, durationLabel, localDateTime, shortDateTime } from '../../lib/format.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { ApplyChoiceModal } from './ApplyChoiceModal.jsx';
import {
  DEFAULT_TYPE_MARKS, DEFAULT_TYPE_SECONDS, clampMix, estimateSeconds, followTypeDefault, mixTotal, mixWithAdded, newQuestion, poolCounts,
  sameForEveryType, strictEstimateSeconds, timerCoverage, hasQuestionTimers, NO_TYPE_SECONDS
} from '../../lib/quiz.js';
import { QuestionMarksFields } from '../../components/QuestionMarksFields.jsx';
import { QuestionFlowFields } from '../../components/QuestionFlowFields.jsx';
import { QuestionDrawField } from '../../components/QuestionDrawField.jsx';
import { QuestionMixPicker } from '../../components/QuestionMixPicker.jsx';
import { TestWindowFields, estimateMinutes, scheduleProblem, scheduleSummary, suggestedEndsAt } from '../../components/TestWindowFields.jsx';
import { nowValue } from '../../components/DateTimeField.jsx';
import { VenueFields } from '../../components/VenueFields.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import { ConfirmDialog } from '../../components/ConfirmDialog.jsx';
import { ChoiceCards, DEVICE_OPTIONS, IntegrityFields, MARKS_OPTIONS, SwitchRow } from '../../components/FormControls.jsx';
import { normalizeImport } from './import-quiz.js';
import { PasteJsonModal } from './PasteJsonModal.jsx';
import { CreatorGlance, CreatorPanel, CreatorSection, CreatorToggles } from './CreatorPanel.jsx';
import { QuestionTable } from './QuestionTable.jsx';
import { useCreatorDraft } from './useCreatorDraft.js';

export function initialDetails() {
  return {
    title: '',
    instructions: '',
    // Nothing is scheduled unless the admin sets a time: they press Start,
    // and the paper runs for as long as its questions are expected to take.
    startMode: 'manual',
    opensAt: nowValue(5),
    endMode: 'duration',
    endsAt: '',
    durationMinutes: null,
    questionLayout: 'one',
    strictTiming: false,
    strictNext: true,
    // One at a time with going back (no question timers: a timed paper goes forward only).
    strictPrevious: false,
    // Form only: whether a one-way paper has question timers. Off, it is sent
    // with no times at all; the times set stay here for turning it back on.
    questionTimers: false,
    // Form only: one time for every question ('same'), or one per type ('type'); unset, read from the times.
    timeEach: undefined,
    typeSeconds: { ...DEFAULT_TYPE_SECONDS },
    typeMarks: { ...DEFAULT_TYPE_MARKS },
    questionDraw: 'spread',
    fullscreenExitLimit: 3,
    fullscreenAbsenceLimitSeconds: 60,
    warningsBeforeLock: 0,
    violationAction: 'lock',
    shuffleQuestions: true,
    allowGuests: false,
    requirePrivateWindow: false,
    devices: 'any',
    locationRequired: false,
    locationRadiusMeters: 250,
    locationLatitude: '',
    locationLongitude: '',
    resultReleaseMode: 'instant'
  };
}

/** The largest quiz JSON taken, from a file or pasted. */
const MAX_JSON_BYTES = 2 * 1024 * 1024;

/** The form's details as the test's settings: without what only the form uses. */
const settingsOf = ({ questionTimers: _formOnly, timeEach: _alsoFormOnly, ...settings }) => settings;

/** Everything below the questions that both this form and the edit modal share. */
export function numericTestSettings(details) {
  return {
    startMode: details.startMode,
    opensAt: details.startMode === 'scheduled' ? new Date(details.opensAt).toISOString() : null,
    endMode: details.endMode,
    untimed: details.endMode === 'manual',
    endsAt: details.endMode === 'at' ? new Date(details.endsAt).toISOString() : null,
    durationMinutes: details.endMode === 'duration' || details.endMode === 'each' ? Number(details.durationMinutes) : null,
    strictTiming: details.strictTiming === true,
    typeSeconds: Object.fromEntries(Object.entries(details.typeSeconds || DEFAULT_TYPE_SECONDS).map(([type, seconds]) => [type, Number(seconds) || 0])),
    typeMarks: Object.fromEntries(Object.entries({ ...DEFAULT_TYPE_MARKS, ...(details.typeMarks || {}) }).map(([type, marks]) => [type, Number(marks) || 1])),
    fullscreenExitLimit: Number(details.fullscreenExitLimit),
    fullscreenAbsenceLimitSeconds: Number(details.fullscreenAbsenceLimitSeconds),
    warningsBeforeLock: Number(details.warningsBeforeLock),
    locationRadiusMeters: Number(details.locationRadiusMeters),
    locationLatitude: details.locationLatitude === '' ? null : Number(details.locationLatitude),
    locationLongitude: details.locationLongitude === '' ? null : Number(details.locationLongitude)
  };
}

/** The saved test in the form's own shape, for editing. */
function detailsFromTest(test) {
  return {
    ...initialDetails(),
    title: test.title,
    instructions: test.instructions || '',
    startMode: test.startMode || 'manual',
    opensAt: test.opensAt ? localDateTime(test.opensAt) : nowValue(5),
    endMode: test.endMode || (test.untimed ? 'manual' : 'at'),
    endsAt: test.endsAt ? localDateTime(test.endsAt) : nowValue(30),
    durationMinutes: test.durationMinutes || estimateMinutes(test.estimatedSeconds || 60),
    questionLayout: test.questionLayout || 'one',
    strictTiming: test.strictTiming === true,
    strictNext: test.strictNext !== false,
    strictPrevious: test.strictPrevious === true,
    typeSeconds: test.typeSeconds || { ...DEFAULT_TYPE_SECONDS },
    typeMarks: { ...DEFAULT_TYPE_MARKS, ...(test.typeMarks || {}) },
    questionDraw: test.questionDraw || 'random',
    fullscreenExitLimit: test.fullscreenExitLimit,
    fullscreenAbsenceLimitSeconds: test.fullscreenAbsenceLimitSeconds,
    warningsBeforeLock: test.warningsBeforeLock,
    violationAction: test.violationAction || 'lock',
    shuffleQuestions: test.shuffleQuestions,
    allowGuests: test.allowGuests,
    requirePrivateWindow: test.requirePrivateWindow,
    devices: test.devices || 'any',
    locationRequired: test.locationRequired,
    locationRadiusMeters: test.locationRadiusMeters || 250,
    locationLatitude: test.locationLatitude ?? '',
    locationLongitude: test.locationLongitude ?? '',
    resultReleaseMode: test.resultReleaseMode
  };
}

const DEVICE_WORDS = { any: 'Any device', phone: 'Phones only', laptop: 'Laptops only' };
const LEAVING_WORDS = { record: 'exits recorded', warn: 'warned on leaving', lock: 'locked on leaving', warn_lock: 'warned, then locked' };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** When a test that has started runs, in one line: its start is history, and its end moves with Extend time. */
function runningLine(test) {
  if (test.isClosed) return 'This test has finished.';
  const end = test.untimed ? 'ends when you close it'
    : test.endMode === 'each' ? `each student has ${durationLabel((Number(test.durationMinutes) || 0) * 60)} from their own Begin`
      : `ends ${shortDateTime(test.endsAt)}`;
  return `Running · ${end}. Change the end time with Extend time on the dashboard.`;
}

/** Whether there is anything worth keeping as a draft: words, a question or a picture. */
const hasContent = (details, questions) => Boolean(String(details.title ?? '').trim() || String(details.instructions ?? '').trim()
  || questions.some((question) => String(question.prompt ?? '').trim() || (question.options || []).some((option) => String(option).trim()) || question.image));

/**
 * Creates a test, or - with `editCode` - edits one: the same form, the whole
 * question paper. Overview starts with the title and description; the left
 * navigation opens one section on the right. Phones use a compact strip.
 * Import and Create remain in reach. A new test is kept as a
 * draft on the server while it is written (useCreatorDraft), so leaving the
 * page loses nothing. Once students have papers, saving asks who the changes
 * reach (see paper-service.js on the server).
 */
export function CreatorScreen({ onCreated, showToast, editCode = null, go }) {
  const [details, setDetails] = useState(initialDetails);
  const [questions, setQuestions] = useState(() => [newQuestion()]);
  const [mix, setMix] = useState({ mcq: 1, msq: 0, short: 0 });
  const [creating, setCreating] = useState(false);
  // Editing: the test as loaded (null while loading), and the pending choice.
  const [editing, setEditing] = useState(null);
  const [choosing, setChoosing] = useState(false);
  // Which part is open (one at a time), and which question's editor.
  const [openPanel, setOpenPanel] = useState('overview');
  const [openQuestion, setOpenQuestion] = useState(null);
  // The sidebar becomes a sticky navigation strip on phones. A selected
  // section starts at the top without losing any of its form values.
  const bar = useRef(null);
  const panels = useRef(null);
  const pendingInvalid = useRef(null);
  const reveal = useRef(false);
  const showPart = (panel) => {
    reveal.current = true;
    setOpenPanel(panel);
  };
  useLayoutEffect(() => {
    if (!reveal.current || !openPanel) return;
    reveal.current = false;
    // QuestionTable aligns the expanded row after its editor is laid out.
    // A later panel reset would undo that on return or validation reveal.
    if (openPanel === 'questions' && openQuestion !== null) return;
    panels.current?.scrollTo({ top: 0, behavior: 'auto' });
    const top = document.getElementById(`${openPanel}-body`)?.getBoundingClientRect().top;
    const under = window.matchMedia('(max-width:700px)').matches
      ? bar.current?.getBoundingClientRect().bottom ?? 0
      : document.querySelector('.site-header')?.getBoundingClientRect().bottom ?? 0;
    if (top === undefined || (top >= under && top < window.innerHeight * 0.6)) return;
    const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: Math.max(0, window.scrollY + top - under - 12), behavior: smooth ? 'smooth' : 'auto' });
  }, [openPanel, openQuestion]);
  useLayoutEffect(() => {
    const field = pendingInvalid.current;
    if (!field || !field.isConnected || !field.getClientRects().length) return;
    // The editor is visible and aligned now. No delayed callback may pull
    // the admin back to this question after they have opened another part.
    pendingInvalid.current = null;
    field.reportValidity?.();
  }, [openPanel, openQuestion]);
  const started = Boolean(editing && (editing.test.isStarted || editing.test.isClosed));

  const pool = useMemo(() => poolCounts(questions), [questions]);
  useEffect(() => { setMix((current) => clampMix(current, poolCounts(questions))); }, [questions]);

  // A question's time is the test's, set in Question settings: its own time
  // (from an older test) counts only once the test has started, when the
  // times are fixed as they were.
  const timedQuestions = useMemo(() => (started ? questions : questions.map((question) => ({ ...question, timeSeconds: null }))), [questions, started]);
  // Under strict timing the paper takes as long as its questions' timers allow
  // (0: none of them has a timer, so the usual estimate stands).
  const timed = details.strictTiming && details.questionTimers;
  const timedSeconds = useMemo(() => (timed ? strictEstimateSeconds(timedQuestions, mix, details.typeSeconds) : 0),
    [timed, details.typeSeconds, timedQuestions, mix]);
  const estimatedSeconds = timedSeconds || estimateSeconds(mix);
  const timers = useMemo(() => (timed ? timerCoverage(timedQuestions, mix, details.typeSeconds) : 'none'),
    [timed, details.typeSeconds, timedQuestions, mix]);

  const detail = (name, value) => setDetails((current) => ({ ...current, [name]: value }));
  const changeDetails = (patch) => setDetails((current) => ({ ...current, ...patch }));

  // A type's default marks changed: every question of that type that held the
  // old default as its own follows the new one (followTypeDefault), so the
  // default and the questions always agree. "The old default" is the one
  // before this run of typing or clicking - typing 25 passes through 2, and a
  // question deliberately worth 2 must not be taken for one that followed it.
  // A pause ends the run; the default then becomes the one to compare with.
  const defaultsBefore = useRef({});
  const defaultsSettle = useRef(null);
  const typeDefault = (name, next) => {
    const field = name === 'typeSeconds' ? 'timeSeconds' : 'marks';
    defaultsBefore.current[name] ??= { ...(details[name] || {}) };
    const before = defaultsBefore.current[name];
    setQuestions((current) => Object.keys(next).reduce((list, type) => (
      next[type] !== '' && Number(next[type]) !== Number(before[type]) ? followTypeDefault(list, field, type, before[type]) : list
    ), current));
    window.clearTimeout(defaultsSettle.current);
    defaultsSettle.current = window.setTimeout(() => { defaultsBefore.current = {}; }, 1200);
    detail(name, next);
  };
  useEffect(() => () => window.clearTimeout(defaultsSettle.current), []);

  // The end time and the duration follow the estimate until the admin sets
  // one of their own, so the common case needs no thought and the unusual
  // case is one edit away.
  const [endTimeTouched, setEndTimeTouched] = useState(false);
  // Also when a draft comes back without a duration (one saved before it held one): filled in again.
  const durationMissing = details.durationMinutes === null || details.durationMinutes === undefined;
  useEffect(() => {
    if (endTimeTouched) return;
    setDetails((current) => ({
      ...current,
      endsAt: suggestedEndsAt(current, estimatedSeconds),
      durationMinutes: estimateMinutes(estimatedSeconds)
    }));
  }, [endTimeTouched, estimatedSeconds, details.opensAt, details.startMode, durationMissing]);
  const windowField = (name, value) => {
    if (name === 'endsAt' || name === 'durationMinutes') setEndTimeTouched(true);
    detail(name, value);
  };
  useEffect(() => {
    if (!editCode) return;
    api(`/api/admin/tests/${encodeURIComponent(editCode)}/paper`)
      .then((data) => {
        const loaded = detailsFromTest(data.test);
        setDetails({ ...loaded, questionTimers: hasQuestionTimers(data.test.typeSeconds, data.questions), timeEach: sameForEveryType(loaded.typeSeconds) ? 'same' : 'type' });
        setQuestions(data.questions);
        setMix(data.test.questionMix || { mcq: data.questions.length, msq: 0, short: 0 });
        setEndTimeTouched(true);
        setEditing(data);
      })
      .catch((error) => showToast(error.message));
  }, [editCode, showToast]);

  // A new test is kept as a draft on the server as it is written, and brought
  // back here - from any device - until it is created or thrown away.
  const draft = useCreatorDraft({
    enabled: !editCode,
    snapshot: hasContent(details, questions) ? { version: 1, details, questions, mix, endTimeTouched } : null,
    onRestore: (saved) => {
      const kept = Array.isArray(saved.questions) ? saved.questions.filter((question) => question && typeof question === 'object') : [];
      const savedDetails = saved.details && typeof saved.details === 'object' ? saved.details : {};
      setDetails({ ...initialDetails(), ...savedDetails, title: String(savedDetails.title ?? ''), instructions: String(savedDetails.instructions ?? '') });
      setQuestions(kept.length ? kept.map((question) => ({
        ...newQuestion(),
        ...question,
        prompt: String(question.prompt ?? ''),
        options: Array.isArray(question.options) ? question.options.map(String) : [],
        correctOptions: Array.isArray(question.correctOptions) ? question.correctOptions.map(String) : []
      })) : [newQuestion()]);
      if (saved.mix && typeof saved.mix === 'object') setMix(saved.mix);
      setEndTimeTouched(saved.endTimeTouched === true);
    }
  });
  // Clear: asked first ("Are you sure?"), then an empty form again and the kept draft thrown away.
  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearDraft = async () => {
    setConfirmingClear(false);
    await draft.discard();
    setDetails(initialDetails());
    setQuestions([newQuestion()]);
    setMix({ mcq: 1, msq: 0, short: 0 });
    setEndTimeTouched(false);
    showPart('overview');
    setOpenQuestion(null);
  };

  // Only the phone navigation covers content; the desktop sidebar must not
  // count as a tall header when scrolling to unfinished fields.
  const shown = !(editCode && !editing) && draft.status !== 'loading';
  useEffect(() => {
    const node = bar.current;
    if (!shown || !node || typeof ResizeObserver === 'undefined') return undefined;
    const root = document.documentElement;
    const measure = () => root.style.setProperty('--creator-stuck', `${(document.querySelector('.site-header')?.offsetHeight || 0) + (window.matchMedia('(max-width:700px)').matches ? node.offsetHeight + 8 : 0)}px`);
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => {
      watch.disconnect();
      root.style.removeProperty('--creator-stuck');
    };
  }, [shown]);

  // A question that changes type, or a new one, counts towards its type's
  // questions per student (mixWithAdded); the type it left is trimmed by clampMix above.
  const updateQuestion = (index, value) => {
    const before = questions[index];
    if (before && value.type !== before.type) setMix((current) => mixWithAdded(current, pool, value.type));
    setQuestions((current) => current.map((question, i) => (i === index ? value : question)));
  };
  const removeQuestion = (index) => {
    setQuestions((current) => current.filter((_question, i) => i !== index));
    setOpenQuestion(null);
  };
  const addQuestion = () => {
    const added = newQuestion();
    setMix((current) => mixWithAdded(current, pool, added.type));
    setQuestions((current) => [...current, added]);
    setOpenPanel('questions');
    setOpenQuestion(questions.length);
  };

  // A quiz from JSON - a file's text, or pasted. Null once it is in, else what was wrong.
  const applyImport = (text) => {
    try {
      if (new Blob([text]).size > MAX_JSON_BYTES) throw new Error('The JSON must be smaller than 2 MB.');
      let parsed;
      try { parsed = JSON.parse(text); }
      catch (error) { throw new Error(`That is not valid JSON (${error.message}).`); }
      const imported = normalizeImport(parsed, initialDetails());
      const importedPool = poolCounts(imported.questions);
      setQuestions(imported.questions);
      setDetails({
        ...imported.details,
        questionTimers: hasQuestionTimers(imported.details.typeSeconds, imported.questions),
        timeEach: sameForEveryType(imported.details.typeSeconds) ? 'same' : 'type'
      });
      if (imported.hasEndTime) setEndTimeTouched(true);
      setMix(clampMix(imported.questionMix || { mcq: imported.questions.length, msq: 0, short: 0 }, importedPool));
      // The list, to look over before creating.
      setOpenPanel('questions');
      setOpenQuestion(null);
      showToast(`${imported.questions.length} questions imported. Review them before creating the test.`);
      return null;
    } catch (error) { return error.message; }
  };
  const importJson = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const problem = file.size > MAX_JSON_BYTES ? 'Choose a JSON file smaller than 2 MB.' : applyImport(await file.text());
    if (problem) showToast(`Could not import JSON: ${problem}`);
    event.target.value = '';
  };
  const jsonFile = useRef(null);
  const [pastingJson, setPastingJson] = useState(false);

  const create = async (event) => {
    event.preventDefault();
    // Closed panels remain mounted. Reveal the first invalid field before
    // asking the browser to focus it, including repeated submit attempts.
    const invalid = firstInvalidField(event.currentTarget);
    if (invalid) { revealInvalid(invalid); return; }
    // What the browser does not check itself: said, with the part it is in opened.
    const stop = (message, panel) => {
      showPart(panel);
      showToast(message);
    };
    if (!mixTotal(mix)) return stop('Choose at least one question per student.', 'settings');
    const problem = started ? null : scheduleProblem(details);
    if (problem) return stop(problem, 'schedule');
    if (details.locationRequired && (details.locationLatitude === '' || details.locationLongitude === '')) {
      return stop('Set the test venue location or turn off the location requirement.', 'rules');
    }
    if (editing) {
      // Who a change reaches matters only for the questions: settings apply
      // to everyone either way, so a settings-only edit needs no choice.
      if (editing.papers.started > 0 && questionsChanged()) setChoosing(true);
      else saveEdit(editing.papers.started > 0 ? 'everyone' : null);
      return;
    }
    setCreating(true);
    // The draft's last change lands first; the server throws the draft away once the test exists.
    await draft.pause();
    try {
      const created = await post('/api/tests', payload());
      // The quiz lists and home no longer say what they held (lib/cache.js).
      dropCached('/api/admin/');
      onCreated(created);
      showToast('Test created.', 'success');
    } catch (error) {
      showToast(error.message);
      setCreating(false);
      draft.resume();
    }
  };

  const questionKey = (list) => JSON.stringify(list.map((question) => [
    question.id ?? null, question.prompt, question.type, question.options || [], (question.correctOptions || []).map(String),
    question.timeSeconds === '' || question.timeSeconds === undefined ? null : question.timeSeconds,
    // A picture added, changed or taken off is a change to the question.
    question.image?.id ?? null
  ]));
  const questionsChanged = () => questionKey(timedQuestions) !== questionKey(started ? editing.questions : editing.questions.map((question) => ({ ...question, timeSeconds: null })));

  // One way with no timers: no type has a time and no question one of its own.
  const untimed = details.strictTiming && !details.questionTimers;
  const payload = () => ({
    ...settingsOf(details),
    ...numericTestSettings(details),
    ...(untimed ? { typeSeconds: { ...NO_TYPE_SECONDS } } : {}),
    // No going back with a timer on each question (QuestionFlowFields keeps what
    // Previous was set to for when the timer goes off) - unless a running test has it.
    strictPrevious: details.strictTiming === true && details.strictPrevious === true && (!details.questionTimers || started),
    questionMix: mix,
    questions: timedQuestions.map(({ onPapers, ...question }) => ({
      ...question,
      correctOptions: question.correctOptions.map(String),
      timeSeconds: question.timeSeconds === '' || question.timeSeconds === undefined || (untimed && Number(question.timeSeconds) > 0) ? null : question.timeSeconds,
      marks: question.marks === '' || question.marks === undefined || question.marks === null ? null : Number(question.marks)
    }))
  });

  const saveEdit = async (applyTo) => {
    setCreating(true);
    try {
      const saved = await api(`/api/admin/tests/${encodeURIComponent(editCode)}/paper`, {
        method: 'PUT',
        body: JSON.stringify({ ...payload(), ...(applyTo ? { applyTo } : {}) })
      });
      dropCached('/api/admin/');
      const summary = saved.paperSummary;
      const parts = [
        summary?.edited && `${summary.edited} edited`,
        summary?.added && `${summary.added} added`,
        summary?.removed && `${summary.removed} deleted`
      ].filter(Boolean);
      showToast(`Quiz saved${parts.length ? ` — ${parts.join(', ')}` : ''}${summary?.papersUpdated ? `; ${summary.papersUpdated} paper${summary.papersUpdated === 1 ? '' : 's'} updated` : ''}.`, 'success');
      go(`/?admin=${encodeURIComponent(editCode)}`);
    } catch (error) { showToast(error.message); setCreating(false); setChoosing(false); }
  };

  // A required field in a closed part cannot show its message: open that part
  // (and the question it is in), then let the browser point at it.
  const revealInvalid = (field) => {
    const panel = field.closest?.('[data-panel]')?.dataset.panel;
    const row = field.closest?.('[data-question-index]');
    const hidden = (panel && panel !== openPanel) || (row && Number(row.dataset.questionIndex) !== openQuestion);
    if (!hidden) { field.reportValidity?.(); return; }
    pendingInvalid.current = field;
    if (panel) showPart(panel);
    if (row) setOpenQuestion(Number(row.dataset.questionIndex));
    showToast(row ? `Question ${Number(row.dataset.questionIndex) + 1} is not finished. It is open now.` : 'Something is not finished yet. It is open now.');
  };

  // The JSON template: saved as a file, or copied as text - to paste wherever
  // the questions are written, then imported with Import questions.
  const downloadTemplate = () => {
    const link = document.createElement('a');
    link.href = '/quiz-template.json';
    link.download = 'quiz-template.json';
    link.click();
  };
  const copyTemplate = async () => {
    try {
      const response = await fetch('/quiz-template.json', { cache: 'no-cache' });
      if (!response.ok) throw new Error('The template could not be loaded.');
      await copyText(await response.text());
      showToast('Template copied.', 'success');
    } catch (error) {
      showToast(error.message.startsWith('This browser blocked') ? 'This browser blocked copying. Use Download template instead.' : error.message);
    }
  };

  if (editCode && !editing) return <div className="empty card">Loading the test…</div>;
  if (draft.status === 'loading') return <div className="empty card">Loading…</div>;

  // Each part says in one line what it holds, read before it is opened.
  const oneAtATime = details.strictTiming || details.questionLayout !== 'all';
  const unwritten = questions.filter((question) => !question.prompt?.trim()).length;
  const scheduleIssue = started ? null : scheduleProblem(details);
  const summaries = {
    questions: [plural(questions.length, 'question'), unwritten && `${unwritten} not written yet`].filter(Boolean).join(' · '),
    schedule: started ? runningLine(editing.test) : scheduleIssue || scheduleSummary(details),
    settings: [
      `${mixTotal(mix)} per student`,
      oneAtATime ? 'one at a time' : 'all on one page',
      timed && 'timed',
      details.shuffleQuestions && 'shuffled'
    ].filter(Boolean).join(' · '),
    rules: [
      DEVICE_WORDS[details.devices] || DEVICE_WORDS.any,
      details.requirePrivateWindow && 'private window',
      details.allowGuests ? 'guests allowed' : 'college accounts only',
      details.locationRequired && 'at the venue',
      LEAVING_WORDS[details.violationAction]
    ].filter(Boolean).join(' · ')
  };
  const toggle = (panel) => { if (openPanel !== panel) showPart(panel); };
  // The draft saves quietly; the bar speaks only when it could not, so nothing is lost unseen.
  // A narrow phone gets the short words (theme.css): the buttons beside it keep their room.
  const [draftNote, draftShort] = draft.status === 'error' ? ['Not saved - check the connection', 'Not saved']
    : draft.status === 'too-big' ? ['Too big to keep as a draft', 'Too big to save'] : ['', ''];
  const backLabel = editing ? 'Back to quiz dashboard' : 'Back to Quizzes';

  return (
    <>
      <div className="creator-workspace">
        <aside className="creator-bar" ref={bar} aria-label="Quiz builder">
          <div className="creator-sidebar-heading">
            <button className="creator-nav-back" type="button" aria-label={backLabel} title={backLabel}
              onClick={() => go(editing ? `/?admin=${encodeURIComponent(editCode)}` : '/?admin=quizzes')}>
              <ArrowLeft size={18} aria-hidden="true"/>
            </button>
            <h1 className="creator-sidebar-title">{editing ? 'Edit quiz' : 'Create quiz'}</h1>
          </div>
          <CreatorToggles open={openPanel} onToggle={toggle}/>
          {started && (
            <p className="notice editing-note">
              <span>This test has started — you choose who your changes reach when you save.</span>
              <InfoTip label="What can still change">
                Questions, answer keys, marks and most settings can still change, and so can Next - and on a paper with no timer, going back can be turned on.
                The start time, the timer on each question, how questions are picked and shuffling are fixed; change the end time with
                Extend time on the dashboard.
              </InfoTip>
            </p>
          )}
          {draft.restoredAt && (
            <p className="notice draft-note">
              <span title={`Your unfinished test from ${shortDateTime(draft.restoredAt)} was restored.`}>
                Draft restored<span className="draft-restored-date">{shortDateTime(draft.restoredAt)}</span>
              </span>
            </p>
          )}
          <div className="creator-bar-actions">
            {draftNote && (
              <span className="creator-bar-note is-problem" role="status">
                <span className="creator-bar-note-long">{draftNote}</span>
                <span className="creator-bar-note-short">{draftShort}</span>
              </span>
            )}
            {!editing && (
              <div className="creator-secondary-actions">
                <button className="button button-secondary button-small draft-clear" type="button" onClick={() => setConfirmingClear(true)}>
                  <Eraser size={16} aria-hidden="true"/>Clear
                </button>
                {/* Import from a file or paste JSON. The full label can wrap on a narrow phone. */}
                <ActionMenu label="Import questions" icon={FileUp} align="right" items={[
                  { label: 'From a file', icon: FileUp, onSelect: () => jsonFile.current?.click() },
                  { label: 'Paste JSON', icon: ClipboardPaste, onSelect: () => setPastingJson(true) },
                  { label: 'Download template', icon: Download, onSelect: downloadTemplate },
                  { label: 'Copy template', icon: Copy, onSelect: copyTemplate }
                ]}/>
              </div>
            )}
            <button className="button button-create" form="creator-form" disabled={creating} type="submit">
              {!editing && <Plus size={16} aria-hidden="true"/>}
              {editing ? (creating ? 'Saving…' : 'Save changes') : (creating ? 'Creating…' : 'Create quiz')}
            </button>
          </div>
          {!editing && <input ref={jsonFile} id="quiz-json" name="quiz-json-file" className="sr-only" type="file" accept="application/json,.json" tabIndex={-1} aria-hidden="true" onChange={importJson}/>}
        </aside>

        <form id="creator-form" className="creator-form" ref={panels} aria-label="Quiz details and settings" noValidate onSubmit={create}>
          <div className="creator-panels">
            <CreatorPanel id="overview" summary="Give your quiz a name and review its setup." open={openPanel === 'overview'}>
              <div className="creator-top-fields">
                <div className="creator-field">
                  <span className="field-label-row">
                    <label className="field-label" htmlFor="test-title">Title</label>
                    <InfoTip label="About creating a quiz">
                      Open Questions, Schedule, Question settings or Rules to edit that part, then press {editing ? 'Save changes' : 'Create quiz'}.
                      {!editing && ' Import questions accepts a file or pasted JSON; its menu includes a template.'}
                    </InfoTip>
                  </span>
                  <input
                    id="test-title" name="title" className="text-input" required maxLength="120" placeholder="e.g. Data Structures Quiz"
                    value={details.title} onChange={(event) => detail('title', event.target.value)}
                  />
                </div>
                <div className="creator-field">
                  <label className="field-label" htmlFor="test-instructions">Description <span className="field-optional">optional</span></label>
                  <textarea id="test-instructions" name="instructions" className="text-area" rows={3} maxLength="2000" placeholder="What students read before they begin"
                    value={details.instructions} onChange={(event) => detail('instructions', event.target.value)}/>
                </div>
              </div>
              <CreatorGlance summaries={summaries} onOpen={toggle}/>
            </CreatorPanel>

            <CreatorPanel id="questions" summary={summaries.questions} open={openPanel === 'questions'}>
              <p className="help creator-panel-hint">Tap a question to write or change it. Write as many as you like: Question settings decides how many each student gets.</p>
              <QuestionTable questions={questions} active={openPanel === 'questions'} openIndex={openQuestion} onOpen={setOpenQuestion} onChange={updateQuestion} onRemove={removeQuestion}
                onAdd={addQuestion} typeMarks={details.typeMarks}/>
            </CreatorPanel>

            <CreatorPanel id="schedule" summary={summaries.schedule} open={openPanel === 'schedule'}>
              {started ? <p className="creator-when-line">{runningLine(editing.test)}</p> : (
                <div className="form-grid">
                  <CreatorSection title="When it starts and ends" hint="Start it yourself or at a set time; it ends by itself, or when you close it. Every paper still open is handed in at the end."/>
                  <TestWindowFields values={details} estimatedSeconds={estimatedSeconds} onChange={windowField} idPrefix="create"/>
                </div>
              )}
            </CreatorPanel>

            <CreatorPanel id="settings" summary={summaries.settings} open={openPanel === 'settings'}>
              <div className="form-grid">
                <CreatorSection title="Questions each student gets" hint="All of them, or a few each from a bigger bank - and in what order."/>
                <div className="form-wide">
                  <span className="field-label">Questions per student</span>
                  <QuestionMixPicker pool={pool} mix={mix} onChange={setMix} idPrefix="create-mix"/>
                  <p className="help">
                    {mixTotal(mix)} of {plural(questions.length, 'question')} per student.
                    {started && ' Changes reach only papers started from now.'}
                  </p>
                </div>
                {!started && (
                  <div className="form-wide switch-list">
                    <SwitchRow checked={details.shuffleQuestions} onChange={(value) => detail('shuffleQuestions', value)}
                      title="Shuffle question order" hint="Each student gets the questions in a different order."/>
                  </div>
                )}
                {!started && <QuestionDrawField value={details.questionDraw} onChange={(value) => detail('questionDraw', value)} pool={pool} mix={mix} idPrefix="create"/>}

                <CreatorSection title="Marks" hint="What a right answer earns, and when students see their marks."/>
                <QuestionMarksFields values={details} onChange={typeDefault} idPrefix="create"/>
                <div className="form-wide">
                  <ChoiceCards label="Students see their marks" idPrefix="create-marks" value={details.resultReleaseMode}
                    onChange={(value) => detail('resultReleaseMode', value)} options={MARKS_OPTIONS} hint/>
                </div>

                <CreatorSection title="Moving through the paper" hint="One page or one question at a time - and then going back, moving on early and a timer on each question."/>
                <QuestionFlowFields values={details} onChange={changeDetails} idPrefix="create" estimatedSeconds={timedSeconds} timers={timers} started={started}/>
              </div>
            </CreatorPanel>

            <CreatorPanel id="rules" summary={summaries.rules} open={openPanel === 'rules'}>
              <div className="form-grid">
                <CreatorSection title="Who can take it" hint="On which devices and in which window, who may join, and from where."/>
                <div className="form-wide">
                  <ChoiceCards
                    label="Devices"
                    idPrefix="create-devices"
                    value={details.devices}
                    onChange={(value) => detail('devices', value)}
                    options={DEVICE_OPTIONS}
                    more={<>Try any phone or laptop on the <a href="/?page=window-check" target="_blank" rel="noreferrer">browser check page</a>: it shows what the check decides there, and why.</>}
                    hint
                  />
                </div>
                <div className="form-wide switch-list">
                  <SwitchRow checked={details.requirePrivateWindow} onChange={(value) => detail('requirePrivateWindow', value)}
                    title="Private (Incognito) window only" hint="Students open the test in a private window, where browser extensions are off."/>
                  <SwitchRow checked={details.allowGuests} onChange={(value) => detail('allowGuests', value)}
                    title="Allow guests" hint="People without a college account can join with just their name. Leave off for graded exams."/>
                  <SwitchRow checked={details.locationRequired} onChange={(value) => detail('locationRequired', value)}
                    title="Venue" hint="Students must be at the venue, by their device's location, to begin - and to carry on."/>
                </div>
                {details.locationRequired && (
                  <div className="form-wide dependent-fields">
                    <VenueFields values={details} onChange={detail} idPrefix="create" showToast={showToast}/>
                  </div>
                )}

                <CreatorSection title="Leaving the test" hint="Switching to another app or tab, or leaving fullscreen. Every exit is recorded, whatever you choose here."/>
                <IntegrityFields values={details} onChange={detail} idPrefix="create"/>
              </div>
            </CreatorPanel>
          </div>
        </form>
      </div>
      {choosing && (
        <ApplyChoiceModal
          papers={editing.papers}
          closed={editing.test.isClosed}
          saving={creating}
          onChoose={saveEdit}
          onClose={() => setChoosing(false)}
        />
      )}
      {pastingJson && <PasteJsonModal onImport={applyImport} onClose={() => setPastingJson(false)}/>}
      {confirmingClear && (
        <ConfirmDialog title="Are you sure?" confirmLabel="Clear" icon={Eraser} tone="danger"
          onConfirm={clearDraft} onCancel={() => setConfirmingClear(false)}>
          This clears the test you are writing - its title, questions and settings. It cannot be undone.
        </ConfirmDialog>
      )}
    </>
  );
}
