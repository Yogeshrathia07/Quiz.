import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Copy, Download } from 'lucide-react';
import { api, post } from '../../lib/api.js';
import { dropCached } from '../../lib/cache.js';
import { copyText, localDateTime } from '../../lib/format.js';
import { ActionMenu } from '../../components/ActionMenu.jsx';
import { ApplyChoiceModal } from './ApplyChoiceModal.jsx';
import {
  DEFAULT_TYPE_MARKS, DEFAULT_TYPE_SECONDS, clampMix, estimateSeconds, followTypeDefault, mixTotal, mixWithAdded, newQuestion, poolCounts, strictEstimateSeconds, timerCoverage,
  hasQuestionTimers, NO_TYPE_SECONDS
} from '../../lib/quiz.js';
import { QuestionMarksFields } from '../../components/QuestionMarksFields.jsx';
import { QuestionTimingFields } from '../../components/QuestionTimingFields.jsx';
import { QuestionDrawField } from '../../components/QuestionDrawField.jsx';
import { QuestionMixPicker } from '../../components/QuestionMixPicker.jsx';
import { TestWindowFields, estimateMinutes, scheduleProblem, suggestedEndsAt } from '../../components/TestWindowFields.jsx';
import { nowValue } from '../../components/DateTimeField.jsx';
import { QuestionEditor } from './QuestionEditor.jsx';
import { VenueFields } from '../../components/VenueFields.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';
import {
  ChoiceCards, DEVICE_OPTIONS, FormGroupTitle, IntegrityFields, LAYOUT_OPTIONS, MARKS_OPTIONS, SwitchRow
} from '../../components/FormControls.jsx';
import { normalizeImport } from './import-quiz.js';

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
    // Form only: whether a one-way paper has question timers. Off, it is sent
    // with no times at all; the times set stay here for turning it back on.
    questionTimers: false,
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

/** The form's details as the test's settings: without what only the form uses. */
const settingsOf = ({ questionTimers: _formOnly, ...settings }) => settings;

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

/**
 * Creates a test, or - with `editCode` - edits one: the same form, the whole
 * question paper. Once students have papers, saving asks who the changes
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
  // Folded when editing: the bank is already there, and Save is what you came for.
  const [questionsOpen, setQuestionsOpen] = useState(!editCode);
  const started = Boolean(editing && (editing.test.isStarted || editing.test.isClosed));

  const pool = useMemo(() => poolCounts(questions), [questions]);
  useEffect(() => { setMix((current) => clampMix(current, poolCounts(questions))); }, [questions]);

  // Under strict timing the paper takes as long as its questions' timers allow
  // (0: none of them has a timer, so the usual estimate stands).
  const timed = details.strictTiming && details.questionTimers;
  const timedSeconds = useMemo(() => (timed ? strictEstimateSeconds(questions, mix, details.typeSeconds) : 0),
    [timed, details.typeSeconds, questions, mix]);
  const estimatedSeconds = timedSeconds || estimateSeconds(mix);
  const timers = useMemo(() => (timed ? timerCoverage(questions, mix, details.typeSeconds) : 'none'),
    [timed, details.typeSeconds, questions, mix]);

  const detail = (name, value) => setDetails((current) => ({ ...current, [name]: value }));

  // A type's default time or marks changed: every question of that type that
  // held the old default as its own follows the new one (followTypeDefault), so
  // the default and the questions always agree. "The old default" is the one
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
  const timingField = (name, value) => {
    if (name === 'typeSeconds') return typeDefault(name, value);
    // Timers turned on with every type at 0 start from the usual times; a
    // question's own "no limit" stays as it is.
    if (name === 'questionTimers') {
      return setDetails((current) => ({
        ...current,
        questionTimers: value,
        typeSeconds: value && !hasQuestionTimers(current.typeSeconds) ? { ...DEFAULT_TYPE_SECONDS } : current.typeSeconds
      }));
    }
    return detail(name, value);
  };

  // The end time and the duration follow the estimate until the admin sets
  // one of their own, so the common case needs no thought and the unusual
  // case is one edit away.
  const [endTimeTouched, setEndTimeTouched] = useState(false);
  useEffect(() => {
    if (endTimeTouched) return;
    setDetails((current) => ({
      ...current,
      endsAt: suggestedEndsAt(current, estimatedSeconds),
      durationMinutes: estimateMinutes(estimatedSeconds)
    }));
  }, [endTimeTouched, estimatedSeconds, details.opensAt, details.startMode]);
  const windowField = (name, value) => {
    if (name === 'endsAt' || name === 'durationMinutes') setEndTimeTouched(true);
    detail(name, value);
  };
  useEffect(() => {
    if (!editCode) return;
    api(`/api/admin/tests/${encodeURIComponent(editCode)}/paper`)
      .then((data) => {
        setDetails({ ...detailsFromTest(data.test), questionTimers: hasQuestionTimers(data.test.typeSeconds, data.questions) });
        setQuestions(data.questions);
        setMix(data.test.questionMix || { mcq: data.questions.length, msq: 0, short: 0 });
        setEndTimeTouched(true);
        setEditing(data);
      })
      .catch((error) => showToast(error.message));
  }, [editCode, showToast]);

  // A question that changes type, or a new one, counts towards its type's
  // questions per student (mixWithAdded); the type it left is trimmed by clampMix above.
  const updateQuestion = (index, value) => {
    const before = questions[index];
    if (before && value.type !== before.type) setMix((current) => mixWithAdded(current, pool, value.type));
    setQuestions((current) => current.map((question, i) => (i === index ? value : question)));
  };
  const removeQuestion = (index) => setQuestions((current) => current.filter((_question, i) => i !== index));

  const importJson = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Choose a JSON file smaller than 2 MB.');
      const imported = normalizeImport(JSON.parse(await file.text()), initialDetails());
      const importedPool = poolCounts(imported.questions);
      setQuestions(imported.questions);
      setQuestionsOpen(false);
      setDetails({ ...imported.details, questionTimers: hasQuestionTimers(imported.details.typeSeconds, imported.questions) });
      if (imported.hasEndTime) setEndTimeTouched(true);
      setMix(clampMix(imported.questionMix || { mcq: imported.questions.length, msq: 0, short: 0 }, importedPool));
      showToast(`${imported.questions.length} questions imported. Review them before creating the test.`);
    } catch (error) { showToast(`Could not import JSON: ${error.message}`); }
    event.target.value = '';
  };

  const create = async (event) => {
    event.preventDefault();
    if (!mixTotal(mix)) return showToast('Choose at least one question per student.');
    const problem = scheduleProblem(details);
    if (problem) return showToast(problem);
    if (details.locationRequired && (details.locationLatitude === '' || details.locationLongitude === '')) {
      return showToast('Set the test venue location or turn off the location requirement.');
    }
    if (editing) {
      // Who a change reaches matters only for the questions: settings apply
      // to everyone either way, so a settings-only edit needs no choice.
      if (editing.papers.started > 0 && questionsChanged()) setChoosing(true);
      else saveEdit(editing.papers.started > 0 ? 'everyone' : null);
      return;
    }
    setCreating(true);
    try {
      const created = await post('/api/tests', payload());
      // The quiz lists and home no longer say what they held (lib/cache.js).
      dropCached('/api/admin/');
      onCreated(created);
      showToast('Test created.', 'success');
    } catch (error) { showToast(error.message); setCreating(false); }
  };

  const questionKey = (list) => JSON.stringify(list.map((question) => [
    question.id ?? null, question.prompt, question.type, question.options || [], (question.correctOptions || []).map(String),
    question.timeSeconds === '' || question.timeSeconds === undefined ? null : question.timeSeconds,
    // A picture added, changed or taken off is a change to the question.
    question.image?.id ?? null
  ]));
  const questionsChanged = () => questionKey(questions) !== questionKey(editing.questions);

  // One way with no timers: no type has a time and no question one of its own.
  const untimed = details.strictTiming && !details.questionTimers;
  const payload = () => ({
    ...settingsOf(details),
    ...numericTestSettings(details),
    ...(untimed ? { typeSeconds: { ...NO_TYPE_SECONDS } } : {}),
    questionMix: mix,
    questions: questions.map(({ onPapers, ...question }) => ({
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

  // A required field inside folded-away questions cannot show its message:
  // open the questions so the browser can point at it.
  const revealInvalid = (event) => {
    if (questionsOpen || !event.target.closest?.('.question-editors')) return;
    setQuestionsOpen(true);
    showToast('Some questions are not finished. They are shown below.');
  };

  // The JSON template: saved as a file, or copied as text - to paste wherever
  // the questions are written, then imported with Import JSON.
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

  return (
    <>
      <section className="creator-head creator-head-row">
        <h1>{editing ? `Edit ${editing.test.title}` : 'Create a test'}</h1>
        {editing ? (
          <button className="button button-secondary button-small creator-back" type="button" onClick={() => go(`/?admin=${encodeURIComponent(editCode)}`)}>
            Back to dashboard
          </button>
        ) : (
        <div className="json-import-actions">
          <label className="button button-secondary button-small" htmlFor="quiz-json">Import JSON</label>
          <input id="quiz-json" className="sr-only" type="file" accept="application/json,.json" onChange={importJson}/>
          <ActionMenu label="Template" align="right" items={[
            { label: 'Download template', icon: Download, onSelect: downloadTemplate },
            { label: 'Copy template', icon: Copy, onSelect: copyTemplate }
          ]}/>
        </div>
        )}
      </section>
      {started && (
        <p className="notice editing-note">
          <span>This test has started — you choose who your changes reach when you save.</span>
          <InfoTip label="What can still change">
            Questions, answer keys, times and settings can still change. The start time, whether it goes one way only (no Previous)
            with a timer on each question, how questions are picked and shuffling are fixed; change the end time with Extend time on the dashboard.
          </InfoTip>
        </p>
      )}

      <form className="creator-form" onSubmit={create} onInvalidCapture={revealInvalid}>
        <section className="card form-section">
          <div className="form-grid">
            <div className="form-wide">
              <label className="field-label">Test title</label>
              <input
                className="text-input" required maxLength="120" placeholder="e.g. Data Structures Quiz"
                value={details.title} onChange={(event) => detail('title', event.target.value)}
              />
            </div>
            <div className="form-wide">
              <label className="field-label">Instructions (optional)</label>
              <textarea className="text-area" maxLength="2000" value={details.instructions} onChange={(event) => detail('instructions', event.target.value)}/>
            </div>

            {!started && (
              <>
                <FormGroupTitle title="Timing"/>
                <TestWindowFields
                  values={details}
                  estimatedSeconds={estimatedSeconds}
                  onChange={windowField}
                  idPrefix="create"
                />
              </>
            )}

            <FormGroupTitle title="Questions"/>
            <div className="form-wide">
              <span className="field-label">Questions per student</span>
              <QuestionMixPicker pool={pool} mix={mix} onChange={setMix} idPrefix="create-mix"/>
              <p className="help">
                {mixTotal(mix)} of {questions.length} question{questions.length === 1 ? '' : 's'} per student.
                {started && ' Changes reach only papers started from now.'}
              </p>
            </div>
            {!started && <QuestionDrawField value={details.questionDraw} onChange={(value) => detail('questionDraw', value)} pool={pool} mix={mix} idPrefix="create"/>}
            <QuestionMarksFields values={details} onChange={typeDefault} idPrefix="create"/>
            {!started && (
              <div className="form-wide">
                <ChoiceCards
                  label="Question layout"
                  idPrefix="create-layout"
                  value={details.strictTiming ? 'one' : details.questionLayout}
                  // All on one page has no Previous or Next to take away.
                  onChange={(value) => setDetails((current) => ({ ...current, questionLayout: value, strictTiming: value === 'all' ? false : current.strictTiming }))}
                  options={LAYOUT_OPTIONS}
                />
              </div>
            )}
            {/* One at a time: the Previous and Next buttons, and the timers when it goes one way only. */}
            {(started || details.strictTiming || details.questionLayout !== 'all') && (
              <QuestionTimingFields values={details} onChange={timingField} idPrefix="create" estimatedSeconds={timedSeconds} timers={timers} locked={started}/>
            )}
            {!started && <div className="form-wide pill-switches">
              <SwitchRow
                checked={details.shuffleQuestions}
                onChange={(value) => detail('shuffleQuestions', value)}
                title="Shuffle question order"
              />
            </div>}

            <FormGroupTitle title="Leaving the test"/>
            <IntegrityFields values={details} onChange={detail} idPrefix="create"/>

            <FormGroupTitle title="Who can join"/>
            <div className="form-wide">
              <SwitchRow
                checked={details.allowGuests}
                onChange={(value) => detail('allowGuests', value)}
                title="Allow guest registrations"
                description="People without a college account can join by name. Leave off for graded exams."
              />
            </div>
            <div className="form-wide">
              <SwitchRow
                checked={details.requirePrivateWindow}
                onChange={(value) => detail('requirePrivateWindow', value)}
                title="Private (Incognito) window only"
                description="Browser extensions are off there."
              />
            </div>
            <div className="form-wide">
              <ChoiceCards
                label="Devices"
                idPrefix="create-devices"
                value={details.devices}
                onChange={(value) => detail('devices', value)}
                options={DEVICE_OPTIONS}
                more={<>Try any phone or laptop on the <a href="/?page=window-check" target="_blank" rel="noreferrer">browser check page</a>: it shows what the check decides there, and why.</>}
              />
            </div>
            <div className="form-wide">
              <SwitchRow
                checked={details.locationRequired}
                onChange={(value) => detail('locationRequired', value)}
                title="Require venue location"
                description="Students must be at the venue to begin."
              />
            </div>

            {details.locationRequired && (
              <div className="form-wide">
                <VenueFields values={details} onChange={detail} idPrefix="create" showToast={showToast}/>
              </div>
            )}

            <FormGroupTitle title="When students see their marks"/>
            <div className="form-wide">
              <ChoiceCards
                label={null}
                idPrefix="create-marks"
                value={details.resultReleaseMode}
                onChange={(value) => detail('resultReleaseMode', value)}
                options={MARKS_OPTIONS}
              />
            </div>
          </div>
        </section>

        {/* The questions fold away, so the settings and Save stay close together. */}
        <div className="questions-bar">
          <div className="questions-bar-title">
            <strong>Questions</strong>
            <span>{questions.length}</span>
          </div>
          <button className="button button-secondary button-small" type="button" aria-expanded={questionsOpen} aria-controls="question-editors"
            onClick={() => setQuestionsOpen((open) => !open)}>
            <ChevronDown size={16} className={`questions-bar-caret${questionsOpen ? ' is-open' : ''}`} aria-hidden="true"/>
            {questionsOpen ? 'Hide' : 'Show'}
          </button>
        </div>

        <section className="question-editors" id="question-editors" hidden={!questionsOpen}>
          {questions.map((question, index) => (
            <QuestionEditor
              key={index}
              question={question}
              index={index}
              canRemove={questions.length > 1}
              onChange={updateQuestion}
              onRemove={removeQuestion}
              strict={timed}
              typeSeconds={details.typeSeconds}
              typeMarks={details.typeMarks}
              onPapers={question.onPapers || 0}
            />
          ))}
        </section>

        <div className="creator-actions">
          <button
            className="button button-secondary"
            type="button"
            onClick={() => {
              setQuestionsOpen(true);
              const added = newQuestion();
              setMix((current) => mixWithAdded(current, pool, added.type));
              setQuestions((current) => [...current, added]);
            }}
          >
            + Add question
          </button>
          <button className="button button-primary" disabled={creating} type="submit">
            {editing ? (creating ? 'Saving…' : 'Save changes') : (creating ? 'Creating…' : 'Create test & QR')}
          </button>
        </div>
      </form>
      {choosing && (
        <ApplyChoiceModal
          papers={editing.papers}
          closed={editing.test.isClosed}
          saving={creating}
          onChoose={saveEdit}
          onClose={() => setChoosing(false)}
        />
      )}
    </>
  );
}
