import { isGuestEmail, openPerson, personAddress, useViewer } from '../lib/people.js';

/**
 * A person's name that opens them under Users (lib/people.js) - for a teacher
 * who may manage users. For anyone else, and for a guest (no account to
 * open), it is the name alone. A click never reaches the row around it, so a
 * row that opens something of its own still does so everywhere but the name.
 */
export function PersonLink({ email, guest = false, className = '', children }) {
  const viewer = useViewer();
  if (!email || guest || isGuestEmail(email) || !viewer?.canManageUsers) {
    return className ? <span className={className}>{children}</span> : children;
  }
  return (
    <a
      className={['person-link', className].filter(Boolean).join(' ')}
      href={personAddress(email)}
      title="Open in Users: their details, SAP ID and every test"
      onClick={(event) => {
        event.stopPropagation();
        // Ctrl / Cmd / Shift or the middle button: a new tab or window, as any link.
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        openPerson(email);
      }}
    >
      {children}
    </a>
  );
}
