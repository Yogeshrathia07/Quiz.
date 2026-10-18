import { useState } from 'react';
import { Modal } from '../../components/Modal.jsx';

/**
 * Import JSON by pasting it rather than choosing a file - the quiz in the
 * template's shape, copied from wherever it was written. The same checks as a
 * file: `onImport` returns what was wrong, or nothing once the quiz is in, and
 * a problem stays here beside the text so it can be fixed and tried again.
 */
export function PasteJsonModal({ onImport, onClose }) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');

  const submit = (event) => {
    event.preventDefault();
    const wrong = onImport(text);
    if (wrong) setProblem(wrong);
    else onClose();
  };

  return (
    <Modal label="Paste quiz JSON" onClose={onClose} className="paste-json-modal">
      <div className="page-heading">
        <h1>Paste JSON</h1>
      </div>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="paste-json">The quiz as JSON, in the template&apos;s shape</label>
        <textarea
          id="paste-json"
          name="quiz-json"
          className="text-area paste-json-text"
          rows={12}
          spellCheck={false}
          autoFocus
          required
          placeholder={'{\n  "title": "…",\n  "questions": [ … ]\n}'}
          value={text}
          onChange={(event) => { setText(event.target.value); setProblem(''); }}
        />
        {problem && <p className="notice danger" role="alert">{problem}</p>}
        <div className="modal-actions">
          <button className="button button-primary" disabled={!text.trim()}>Import</button>
        </div>
      </form>
    </Modal>
  );
}
