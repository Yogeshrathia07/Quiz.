/**
 * Quizzes owns preparation and live participation; Results owns submitted papers
 * and analysis. Dashboard addresses stay valid, including the former Results
 * analysis view (?rview=analysis), so a saved link opens in the right area.
 */
export function adminAreaOf(route = {}) {
  const current = route || {};
  if (current.result || current.page === 'results' || current.admin === 'results') return 'results';
  if (current.admin === 'tests') return current.view === 'taken' ? 'results' : 'quizzes';
  if (['quizzes', 'create', 'edit', 'portal'].includes(current.admin)) return 'quizzes';
  return current.rview === 'analysis' || ['responses', 'analysis'].includes(current.tab) ? 'results' : 'quizzes';
}

/** Which primary navigation link owns the current page, on desktop and mobile. */
export function primaryLinkOf(route = {}, isAdmin = false) {
  const current = route || {};
  // A test or register is a shared student-facing link, not an admin workspace.
  if (current.test || current.attend) return null;
  if (current.admin === 'attendance') return 'attendance';
  if (current.admin === 'users') return 'users';
  if (current.page === 'results' || current.result) return isAdmin ? 'results' : 'home';
  if (current.admin && current.admin !== 'portal') return adminAreaOf(current);
  return 'home';
}

/** Closed quizzes remain findable even when nobody submitted a paper. */
export const hasQuizResults = (quiz) => Boolean(quiz && (quiz.isClosed || quiz.submittedCount > 0 || quiz.toMarkCount > 0));
