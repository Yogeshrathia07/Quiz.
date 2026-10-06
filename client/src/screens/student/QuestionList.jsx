import { QuestionPaper } from './QuestionPaper.jsx';

/**
 * Every question on one scrolling page. Each still saves as you go and each
 * still renders read-only once the server marks it final, so the only thing
 * that differs from the one-at-a-time paper is how much you can see at once.
 */
export function QuestionList({ questions, onSave, connection }) {
  return (
    <div className="q-list">
      {questions.map((question) => (
        <QuestionPaper key={question.id} question={question} total={questions.length} onSave={onSave} connection={connection}/>
      ))}
    </div>
  );
}
