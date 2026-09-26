import { useEffect } from 'react';
import { X } from 'lucide-react';

export function Modal({ children, onClose, label, className = '' }) {
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKeyDown);

    // Hold the page still behind the backdrop; scrolling it while a dialog is
    // open looks like a glitch, and more so now that the backdrop is blurred.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

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
