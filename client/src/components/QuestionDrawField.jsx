import { drawSummary } from '../lib/quiz.js';
import { ChoiceCards } from './FormControls.jsx';

const DRAW_OPTIONS = [
  { value: 'spread', title: 'Least overlap', description: 'Each student who begins takes the next questions in the bank, so neighbours get different ones and every question is used about equally.' },
  { value: 'random', title: 'Fully random', description: 'An independent random pick for each student; some overlap happens by chance.' }
];

/** How each student's questions are picked from a bank bigger than one paper. */
export function QuestionDrawField({ value, onChange, pool, mix, idPrefix }) {
  const summary = drawSummary(pool, mix, value);
  if (!summary) {
    return <p className="help form-wide">Every student gets the same questions. Add more to the bank to give students different papers.</p>;
  }
  return (
    <div className="form-wide">
      <ChoiceCards label="How questions are picked" idPrefix={`${idPrefix}-draw`} value={value} onChange={onChange} options={DRAW_OPTIONS} hint/>
      <p className="help draw-summary">With this bank, {summary}</p>
    </div>
  );
}
