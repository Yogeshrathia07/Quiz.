import { useEffect } from 'react';

/**
 * The portal's name, as it appears in the navigation bar, the sign-in page
 * and the browser tab. Change these to your department's own words.
 */
export const BRAND = {
  name: 'Quiz',
  // The wordmark in the navigation bar, after the logo (client/public/logo.svg); a blue full stop follows it.
  wordmark: 'QUIZ',
  // Shown small beside the name, e.g. a department. Leave empty to show none.
  org: '',
  // One line under the name on the sign-in page.
  tagline: 'Class tests and attendance, run from your own classroom.'
};

/** "Students · DBMS Mid-term · Quiz" */
export const pageTitle = (...parts) => [...parts.filter(Boolean), BRAND.name].join(' · ');

/** Sets the browser tab's title while a page is shown. */
export function usePageTitle(...parts) {
  const title = pageTitle(...parts);
  useEffect(() => { document.title = title; }, [title]);
}
