/**
 * A person's page under Users - who they are, their SAP ID and every test -
 * reached from wherever a teacher sees their name: an attendance list, a
 * test's students and results, a paper (components/PersonLink.jsx).
 *
 * The app shares who is signed in (`ViewerContext`, set in App.jsx) and its
 * own way of changing page (`setNavigator`), so a name deep in a table can
 * open the page without a reload.
 */
import { createContext, useContext } from 'react';

export const ViewerContext = createContext(null);
/** Who is signed in: { email, role, canManageUsers, … }, or null. */
export const useViewer = () => useContext(ViewerContext);

/** Guest accounts (a SAP ID and a name, no college account) have no page under Users. */
export const isGuestEmail = (email) => String(email || '').trim().toLowerCase().endsWith('@guest.test');

/** Users, with this person's details open. */
export const personAddress = (email) => `/?admin=users&user=${encodeURIComponent(String(email || '').trim().toLowerCase())}`;

let navigate = (url) => { window.location.assign(url); };
/** App.jsx hands over its own navigation: `go(url, historyState)`. */
export const setNavigator = (go) => { navigate = go; };

/**
 * Opens the person under Users. The page is marked as opened from a name, so
 * closing their details goes back to where the name was.
 */
export const openPerson = (email) => navigate(personAddress(email), { fromName: true });
/** Whether this page was opened from a name (and closing should go back there). */
export const openedFromName = () => Boolean(window.history.state?.fromName);
