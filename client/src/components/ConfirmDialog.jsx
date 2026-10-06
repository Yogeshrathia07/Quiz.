import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Download } from 'lucide-react';

/**
 * Asks once before going ahead - a download - in a small card over the page:
 * what is about to happen, then Cancel and the action itself. Escape, a tap
 * beside the card or Cancel close it; Enter (the action has the focus) or a
 * tap on the action goes ahead.
 */
export function ConfirmDialog({ title, children, confirmLabel = 'Download', icon: Icon = Download, onConfirm, onCancel }) {
  const id = useId();
  const action = useRef(null);
  const cancel = useRef(onCancel);
  cancel.current = onCancel;
  useEffect(() => {
    const before = document.activeElement;
    action.current?.focus();
    // First, and only this: a window it opened over (the student's details) stays open.
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      cancel.current();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, []);
  return createPortal(
    <div className="confirm-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="confirm-card" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-text`}>
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-text`}>{children}</p>
        <div className="confirm-actions">
          <button className="button button-secondary" type="button" onClick={onCancel}>Cancel</button>
          <button ref={action} className="button button-primary" type="button" onClick={onConfirm}>
            <Icon size={16} aria-hidden="true"/>{confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body
  );
}
