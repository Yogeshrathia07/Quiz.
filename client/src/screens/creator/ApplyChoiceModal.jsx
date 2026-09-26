import { useState } from 'react';
import { Modal } from '../../components/Modal.jsx';

const CHOICES = [
  {
    value: 'everyone',
    title: 'Everyone, including papers already given out',
    points: [
      'Students writing the test see the new wording and options on their next refresh.',
      'A changed answer key re-marks papers already submitted.',
      'A deleted question is taken off every paper, and scores are recounted.',
      'An answer that no longer fits an edited question (fewer options, a new type) is cleared.'
    ]
  },
  {
    value: 'new',
    title: 'Only students who start from now',
    points: [
      'Papers already given out keep every question exactly as it was, and their marks.',
      'Students who begin after this get the edited paper.'
    ]
  }
];

/** Once students have papers, who an edit to the question paper reaches. */
export function ApplyChoiceModal({ papers, closed, saving, onChoose, onClose }) {
  const [choice, setChoice] = useState('everyone');
  return (
    <Modal label="Who should these changes reach?" onClose={onClose}>
      <h1>Who should these changes reach?</h1>
      <p>
        <strong>{papers.started}</strong> student{papers.started === 1 ? ' has' : 's have'} a paper
        {papers.submitted ? <> ({papers.submitted} submitted)</> : ''}.
      </p>
      <div className="apply-choices" role="radiogroup">
        {CHOICES.map((option) => (
          <label key={option.value} className={`apply-choice${choice === option.value ? ' is-on' : ''}`}>
            <input type="radio" name="apply-to" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)}/>
            <span>
              <strong>{option.title}</strong>
              <ul>{option.points.map((point) => <li key={point}>{point}</li>)}</ul>
            </span>
          </label>
        ))}
      </div>
      <p className="help">
        Either way, new questions and a different number of questions per student reach only papers started from now.
        {closed && ' This test is closed: "only students who start from now" matters only if you restart it.'}
      </p>
      <div className="modal-actions">
        <button className="button button-secondary" type="button" onClick={onClose}>Cancel</button>
        <button className="button button-primary" type="button" disabled={saving} onClick={() => onChoose(choice)}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </Modal>
  );
}
