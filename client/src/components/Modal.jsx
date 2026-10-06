import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

export function Modal({ children, onClose, label, className = '' }) {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    // A menu open over the window closes first, on its own Escape; the window waits for the next.
    const onKeyDown = (event) => { if (event.key === 'Escape' && !document.querySelector('.menu-floating, .filter-panel, .student-picker-list, .confirm-overlay, .info-tip-note')) close.current(); };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Hold the page still behind the backdrop; scrolling it while a dialog is
  // open looks like a glitch, and more so now that the backdrop is blurred.
  // Both <html> and <body>: where <html> clips sideways overflow (the
  // dashboard, a result - see base.css) it is <html> that scrolls, and a
  // lock on <body> alone leaves the page free to move.
  useEffect(() => {
    const root = document.documentElement;
    const previous = { root: root.style.overflow, body: document.body.style.overflow };
    root.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      root.style.overflow = previous.root;
      document.body.style.overflow = previous.body;
    };
  }, []);

  return (
    <div
      className="qr-preview-overlay"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section className={`student-analysis-sheet${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={label}>
        <button className="button icon-button modal-close" onClick={onClose} type="button" aria-label="Close" title="Close"><X size={18} aria-hidden="true"/></button>
        {children}
      </section>
    </div>
  );
}
