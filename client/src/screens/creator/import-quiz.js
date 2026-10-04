import { DEFAULT_TYPE_MARKS, DEFAULT_TYPE_SECONDS, QUESTION_TYPES, newQuestion } from '../../lib/quiz.js';
import { localDateTime, numberInRange } from '../../lib/format.js';

const text = (value) => String(value ?? '').trim();

/** Marks from the file: more than 0 and at most 100, to two places - else none. */
function marksIn(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 100 ? Math.round(number * 100) / 100 : null;
}

function importedOptions(question) {
  const source = Array.isArray(question.options) ? question.options : [];
  return source.map((option) => text(typeof option === 'object' && option ? option.text ?? option.label ?? '' : option));
}

function importedQuestion(question, index) {
  const prompt = text(question.prompt ?? question.question ?? question.text);
  const type = String(question.type || 'mcq').toLowerCase();
  if (prompt.length < 3 || !QUESTION_TYPES.includes(type)) throw new Error(`Question ${index + 1} is incomplete.`);
  // Strict timing: the question's own time in seconds (0 = no limit), if the file gives one.
  const timeSeconds = numberInRange(question.timeSeconds ?? question.time_seconds, 0, 3600, null);
  // What it is worth, if the file says (else its type's marks).
  const marks = marksIn(question.marks ?? question.points);
  if (type === 'short') return { ...newQuestion(), prompt, type, options: [], correctOptions: [], timeSeconds, marks };

  const options = importedOptions(question);
  if (options.length < 2 || options.some((option) => !option)) throw new Error(`Question ${index + 1} needs at least two options.`);

  const rawCorrect = question.correctOptions ?? question.correctOption ?? question.correctAnswer ?? question.answer ?? question.correct;
  const values = Array.isArray(rawCorrect) ? rawCorrect : rawCorrect === undefined ? [] : [rawCorrect];
  // Correct answers may be given as option indexes or as the exact option text.
  const correctOptions = [...new Set(values.map((value) => {
    const candidate = text(value);
    if (/^\d+$/.test(candidate) && Number(candidate) < options.length) return String(Number(candidate));
    const found = options.findIndex((option) => option.toLowerCase() === candidate.toLowerCase());
    return found >= 0 ? String(found) : null;
  }))];
  if (!correctOptions.length || correctOptions.includes(null)) throw new Error(`Question ${index + 1} needs valid correctOptions.`);

  return {
    prompt,
    type: type === 'msq' || correctOptions.length > 1 ? 'msq' : 'mcq',
    options,
    correctOptions,
    timeSeconds,
    marks
  };
}

/** Turns an uploaded quiz JSON file into the creator form's own state. */
export function normalizeImport(raw, defaults) {
  const source = Array.isArray(raw) ? { questions: raw } : raw;
  if (!source || !Array.isArray(source.questions)) throw new Error('JSON must contain a questions array.');
  const typeSeconds = QUESTION_TYPES.reduce((times, type) => ({
    ...times,
    [type]: numberInRange((source.typeSeconds ?? source.type_seconds ?? {})[type], 0, 3600, DEFAULT_TYPE_SECONDS[type])
  }), {});
  const typeMarks = QUESTION_TYPES.reduce((marks, type) => ({
    ...marks,
    [type]: marksIn((source.typeMarks ?? source.type_marks ?? {})[type]) ?? DEFAULT_TYPE_MARKS[type]
  }), {});
  // A question given its type's own time or marks is following that default:
  // kept so, and changing the default later still reaches it.
  const questions = source.questions.map(importedQuestion).map((question) => ({
    ...question,
    timeSeconds: question.timeSeconds !== null && question.timeSeconds === typeSeconds[question.type] ? null : question.timeSeconds,
    marks: question.marks !== null && question.marks === typeMarks[question.type] ? null : question.marks
  }));
  if (!questions.length) throw new Error('Add at least one question.');

  const rawStart = source.startsAt ?? source.startAt ?? source.opensAt ?? source.opens_at;
  const parsedStart = rawStart ? new Date(rawStart) : null;
  const rawEnd = source.endsAt ?? source.endAt ?? source.ends_at ?? source.closesAt ?? source.closes_at;
  const parsedEnd = rawEnd ? new Date(rawEnd) : null;
  const hasEnd = Boolean(parsedEnd && !Number.isNaN(parsedEnd.getTime()));
  const hasStart = Boolean(parsedStart && !Number.isNaN(parsedStart.getTime()));
  const untimed = source.untimed === true || source.noTimeLimit === true || source.no_time_limit === true;
  const duration = numberInRange(source.durationMinutes ?? source.duration_minutes, 1, 24 * 60, null);
  // "durationFrom": "student" - each student gets the duration from their own Begin.
  const ownTime = (source.durationFrom ?? source.duration_from) === 'student';
  const releaseMode = source.resultReleaseMode ?? source.result_release_mode;

  return {
    questions,
    details: {
      ...defaults,
      title: text(source.title ?? source.name),
      instructions: text(source.instructions ?? source.description),
      // A start time in the file schedules the test; an end time, a duration
      // or "no time limit" says how it ends. Anything left out stays manual.
      startMode: hasStart ? 'scheduled' : defaults.startMode,
      opensAt: hasStart ? localDateTime(parsedStart) : defaults.opensAt,
      endMode: untimed ? 'manual' : hasEnd ? 'at' : duration ? (ownTime ? 'each' : 'duration') : defaults.endMode,
      endsAt: hasEnd ? localDateTime(parsedEnd) : defaults.endsAt,
      durationMinutes: duration || defaults.durationMinutes,
      fullscreenExitLimit: numberInRange(source.fullscreenExitLimit ?? source.fullscreen_exit_limit, 0, 20, 3),
      violationAction: ['record', 'warn', 'lock', 'warn_lock'].includes(source.violationAction ?? source.violation_action) ? (source.violationAction ?? source.violation_action) : 'lock',
      fullscreenAbsenceLimitSeconds: numberInRange(source.fullscreenAbsenceLimitSeconds ?? source.fullscreen_absence_limit_seconds, 0, 3600, 10),
      warningsBeforeLock: numberInRange(source.warningsBeforeLock ?? source.warnings_before_lock, 0, 20, 0),
      shuffleQuestions: source.shuffleQuestions ?? source.shuffle_questions ?? true,
      questionLayout: ['one', 'all'].includes(source.questionLayout ?? source.question_layout) ? (source.questionLayout ?? source.question_layout) : 'one',
      allowGuests: source.allowGuests ?? source.allow_guests ?? false,
      requirePrivateWindow: source.requirePrivateWindow ?? source.require_private_window ?? false,
      devices: ['any', 'phone', 'laptop'].includes(source.devices) ? source.devices : 'any',
      locationRequired: source.locationRequired ?? source.location_required ?? false,
      locationRadiusMeters: numberInRange(source.locationRadiusMeters ?? source.location_radius_meters, 10, 100000, 250),
      locationLatitude: source.locationLatitude ?? source.location_latitude ?? '',
      locationLongitude: source.locationLongitude ?? source.location_longitude ?? '',
      resultReleaseMode: ['instant', 'after_quiz', 'admin'].includes(releaseMode) ? releaseMode : 'instant',
      strictTiming: source.strictTiming === true || source.strict_timing === true,
      strictNext: (source.strictNext ?? source.strict_next) !== false,
      questionDraw: ['spread', 'random'].includes(source.questionDraw ?? source.question_draw) ? (source.questionDraw ?? source.question_draw) : defaults.questionDraw,
      typeSeconds,
      typeMarks
    },
    questionMix: source.questionMix ?? source.question_mix ?? null,
    // Tells the form to stop auto-tracking the estimate: the file said when.
    hasEndTime: hasEnd || Boolean(duration)
  };
}
