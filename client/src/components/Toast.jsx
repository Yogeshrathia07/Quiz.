import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';

const ICONS = { success: CircleCheck, warn: TriangleAlert, error: CircleAlert };

// How long a message stays before it starts to fade. A warning or an error
// gets longer: during a test it is worth reading in full.
export const toastDuration = (tone) => (tone === 'warn' || tone === 'error' ? 6_000 : 4_500);
// The fade itself - slow enough to see it go, not blink out. Matches toast-out in theme.css.
export const TOAST_FADE_MS = 900;

/** The one message on screen: an optional bold title and a line of detail. */
export function Toast({ toast }) {
  const Icon = ICONS[toast.tone] || Info;
  const urgent = toast.tone === 'error' || toast.tone === 'warn';
  return (
    <div className={`toast is-${toast.tone}${toast.leaving ? ' is-leaving' : ''}`} role={urgent ? 'alert' : 'status'}>
      <Icon className="toast-icon" size={20} aria-hidden="true"/>
      <span className="toast-body">
        {toast.title && <strong className="toast-title">{toast.title}</strong>}
        <span className="toast-text">{toast.text}</span>
      </span>
    </div>
  );
}
