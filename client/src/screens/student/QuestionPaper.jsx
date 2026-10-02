import { useCallback, useEffect, useRef, useState } from 'react';
import { RichText } from '../../components/RichText.jsx';

const HINT = {
  mcq: 'Select one answer',
  msq: 'Select all that apply',
  short: 'Type your answer'
};
const letter = (position) => String.fromCharCode(65 + position);

// Typing adds a character at a time, a keyboard's suggestion or swipe a word.
// This much arriving in one change came from somewhere else: a phone
// keyboard's clipboard (which sends no paste event), voice typing, an extension.
const BURST_CHARS = 30;
// What an answer box must never take: a paste or a drop, however it comes.
const REFUSED_INPUT = new Set(['insertFromPaste', 'insertFromPasteAsQuotation', 'insertFromDrop', 'insertFromYank']);

/**
 * Scrolls the answer box into view inside the question's own scroll area -
 * never the page around it, which cannot be scrolled back during a test. Just
 * enough to show its bottom edge, and never past its top. With every question
 * on one page, the page itself scrolls.
 */
function revealBox(box) {
  const area = box.closest('.exam-body');
  if (!area || getComputedStyle(area).overflowY === 'visible') {
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  const boxRect = box.getBoundingClientRect();
  const areaRect = area.getBoundingClientRect();
  const hidden = boxRect.bottom - areaRect.bottom + 8;
  if (hidden > 0) area.scrollBy({ top: Math.min(hidden, boxRect.top - areaRect.top - 8), behavior: 'smooth' });
}

/**
 * On the right of the question's header: a small dot in the colour of where
 * this answer stands - green saved (on the server), blue saving, amber
 * waiting on this device (offline, the server unreachable, or sending that
 * is taking long), grey not answered yet. Hovered, tapped or focused, it
 * says so in words.
 *
 *   connection: 'online' | 'stuck' (sending for a while) | 'offline' | 'server'
 */
const SAVE_STATES = {
  saved: ['is-saved', 'Saved', 'Your answer is saved on the server.'],
  online: ['is-sending', 'Saving…', 'Your answer is being sent to the server.'],
  stuck: ['is-waiting', 'Still sending…', 'It is taking a while. Your answer is kept on this device - keep this page open.'],
  offline: ['is-waiting', 'Saved on this device', 'You are offline. It sends as soon as you are back online.'],
  server: ['is-waiting', 'Saved on this device', 'The server cannot be reached right now. It sends as soon as it is back.'],
  empty: ['is-empty', 'Not answered yet', 'Your answer saves by itself as soon as you choose or type it.'],
  emptyOffline: ['is-waiting', 'You are offline', 'Your answers are kept on this device and send when you are back online.'],
  final: ['is-final', 'Final', 'This answer is final: the paper has moved on.']
};
function SaveState({ question, connection = 'online' }) {
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    // A tap anywhere else puts the details away (a tap on the dot toggles them itself).
    const close = (event) => { if (!box.current?.contains(event.target)) setOpen(false); };
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
    return () => { window.clearTimeout(timer); document.removeEventListener('pointerdown', close, true); };
  }, [open]);
  const away = connection === 'offline' || connection === 'server';
  const key = question.locked ? 'final'
    : question.unsent ? connection
      : question.answered ? 'saved'
        : away ? 'emptyOffline' : 'empty';
  const [tone, title, detail] = SAVE_STATES[key];
  return (
    <span className={`q-save ${tone}${open ? ' is-open' : ''}`} ref={box}>
      <button type="button" className="q-save-dot" aria-expanded={open} aria-label={`${title}. ${detail}`} onClick={() => setOpen((value) => !value)}>
        <span aria-hidden="true"/>
      </button>
      <span className="q-save-tip" role="tooltip"><strong>{title}</strong>{detail}</span>
    </span>
  );
}

/**
 * One question of the paper. It writes through to the server as the student
 * works, so a closed tab or a flat battery never loses an answer, and it renders
 * read-only the moment the server marks the question final.
 *
 * Mounted with `key={question.id}`, so the typed draft below belongs to exactly
 * one question and a background refresh can never overwrite it mid-sentence.
 */
export function QuestionPaper({ question, total, onSave, flushRef, draftRef, onTextBurst, connection }) {
  const [answerText, setAnswerText] = useState(question.answerText);
  const box = useRef(null);
  const burstRef = useRef(onTextBurst);
  burstRef.current = onTextBurst;

  // Pasting and dropping are refused before they land (the page-wide guard
  // records them). What cannot be refused - text arriving all at once - is
  // measured on every change and reported with how much came in.
  useEffect(() => {
    const field = box.current;
    if (!field || question.locked) return undefined;
    let length = field.value.length;
    const refuse = (event) => { if (REFUSED_INPUT.has(event.inputType)) event.preventDefault(); };
    const measure = () => {
      const grew = field.value.length - length;
      length = field.value.length;
      if (grew >= BURST_CHARS) burstRef.current?.(question.id, grew);
    };
    field.addEventListener('beforeinput', refuse);
    field.addEventListener('input', measure);
    return () => {
      field.removeEventListener('beforeinput', refuse);
      field.removeEventListener('input', measure);
    };
  }, [question.id, question.locked]);
  const draft = useRef(question.answerText);
  const saved = useRef(question.answerText);

  const flush = useCallback(() => {
    if (question.type !== 'short' || question.locked) return;
    if (draft.current === saved.current) return;
    saved.current = draft.current;
    onSave({ questionId: question.id, answerText: draft.current });
  }, [question.id, question.type, question.locked, onSave]);

  // Save shortly after typing stops, and again on the way out - leaving the
  // question or blurring to press Submit must not drop the last few words.
  useEffect(() => {
    if (question.type !== 'short' || question.locked) return undefined;
    const timer = window.setTimeout(flush, 500);
    return () => window.clearTimeout(timer);
  }, [answerText, question.type, question.locked, flush]);
  useEffect(() => flush, [flush]);
  // Strict timing sends the last words before moving on, not after.
  if (flushRef) flushRef.current = flush;
  // Or hands them over to go with the move itself: the words not yet sent,
  // counted as sent from here on, or null when there are none.
  if (draftRef) {
    draftRef.current = () => {
      if (question.type !== 'short' || question.locked || draft.current === saved.current) return null;
      saved.current = draft.current;
      return { answerText: draft.current };
    };
  }

  const changeText = (value) => {
    draft.current = value;
    setAnswerText(value);
  };

  const toggleOption = (optionId) => {
    if (question.locked) return;
    const current = new Set(question.selectedOptions);
    if (question.type === 'msq') {
      if (current.has(optionId)) current.delete(optionId);
      else current.add(optionId);
    } else {
      current.clear();
      current.add(optionId);
    }
    onSave({ questionId: question.id, selectedOptions: [...current] });
  };

  // Clearing returns the question to blank. Before the end time that is
  // allowed; after it the server has made the answer final.
  const hasAnswer = question.type === 'short' ? answerText.trim().length > 0 : question.selectedOptions.length > 0;
  const canClear = hasAnswer && !question.locked;
  const clear = () => {
    if (!canClear) return;
    if (question.type === 'short') {
      changeText('');
      flush();
    } else {
      onSave({ questionId: question.id, selectedOptions: [] });
    }
  };

  return (
    <article className="q-card" id={`question-${question.id}`}>
      <div className="q-head">
        <span className="q-count">Question {question.number}<span>/{total}</span></span>
        <SaveState question={question} connection={connection}/>
      </div>
      <RichText className="q-prompt" text={question.prompt}/>
      <p className="q-hint">{HINT[question.type]}</p>

      {question.type === 'short' ? (
        <textarea
          ref={box}
          className="q-text"
          value={answerText}
          readOnly={question.locked}
          onChange={(event) => changeText(event.target.value)}
          onBlur={flush}
          onFocus={(event) => {
            const box = event.currentTarget;
            // Once the phone keyboard has slid up (and again when it has settled),
            // bring the answer back into view.
            for (const ms of [350, 750]) window.setTimeout(() => { if (document.activeElement === box) revealBox(box); }, ms);
          }}
          placeholder={question.locked ? 'This answer is final.' : 'Your answer'}
        />
      ) : (
        <div className={`q-options${question.type === 'msq' ? ' is-multi' : ''}`}>
          {question.options.map((option, position) => {
            const selected = question.selectedOptions.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                disabled={question.locked}
                className={`q-option${selected ? ' is-selected' : ''}`}
                aria-pressed={selected}
                onClick={() => toggleOption(option.id)}
              >
                <span className="q-letter" aria-hidden="true">{letter(position)}</span>
                <span className="q-option-text">{option.text}</span>
              </button>
            );
          })}
        </div>
      )}

      {canClear && (
        <button className="q-clear" type="button" onClick={clear}>Clear answer</button>
      )}
    </article>
  );
}
