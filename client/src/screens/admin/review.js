/**
 * The result review's small rules (modals/ResultReviewModal.jsx), kept apart
 * so they can be tested: where an answer stands, and which papers a question
 * is on.
 */

/**
 * Where an answer stands - its dot's colour and its card's word: 'pending' (a
 * short answer still to mark), 'blank' (not answered), 'full', 'part' or
 * 'zero' marks; 'absent' when the question is not on that paper.
 */
export function answerState(answer) {
  if (!answer) return 'absent';
  if (answer.marks === null || answer.marks === undefined) return answer.answered ? 'pending' : 'blank';
  if (!answer.answered && !answer.overridden && answer.marks === 0) return 'blank';
  if (answer.marks >= answer.maxMarks) return 'full';
  return answer.marks > 0 ? 'part' : 'zero';
}

export const STATE_WORDS = {
  pending: 'To mark', blank: 'Not answered', full: 'Full marks', part: 'Part marks', zero: 'No marks', absent: 'Not on this paper'
};

export const answerOf = (paper, questionId) => paper?.answers.find((answer) => answer.questionId === questionId) || null;

/** The papers a question is on - only those still to mark, when asked. */
export const papersWith = (papers, questionId, onlyToMark = false) => papers.filter((paper) => {
  const answer = answerOf(paper, questionId);
  return answer && (!onlyToMark || answerState(answer) === 'pending');
});

/**
 * A review opened from a filtered cohort stays on the clicked student's
 * paper. An absent ID leaves the usual whole-class review exactly as it was;
 * an ID no longer present fails closed rather than showing somebody else.
 */
export function reviewForRegistration(data, onlyRegistrationId = null) {
  if (!data || onlyRegistrationId === null || onlyRegistrationId === undefined) return data;
  const wanted = String(onlyRegistrationId).trim();
  const all = Array.isArray(data.papers) ? data.papers : [];
  const matches = (id) => wanted && id !== null && id !== undefined && String(id) === wanted;
  // A canonical registration ID wins over a legacy alias. Never retain two
  // papers if a malformed/old payload happens to reuse an alias elsewhere.
  const paper = all.find((entry) => matches(entry.registrationId)) || all.find((entry) => matches(entry.id));
  const papers = paper ? [paper] : [];
  const used = new Set(papers.flatMap((paper) => (paper.answers || []).map((answer) => String(answer.questionId))));
  return { ...data, papers, questions: (Array.isArray(data.questions) ? data.questions : []).filter((question) => used.has(String(question.id))) };
}

/** "AS" for Asha Singh; a guest's "Guest:" left off. */
export const initialsOf = (name) => String(name || '?').replace(/^Guest:\s*/, '').split(/\s+/).filter(Boolean)
  .slice(0, 2).map((part) => part[0].toUpperCase()).join('') || '?';
