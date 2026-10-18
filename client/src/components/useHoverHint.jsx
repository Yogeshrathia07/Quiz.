import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** An immediate, icon-free row hint. Keyboard focus and a touch toggle show it too. */
export function useHoverHint(description) {
  const id = useId();
  const row = useRef(null);
  const note = useRef(null);
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const close = () => { setOpen(false); setPlace(null); };
  useLayoutEffect(() => {
    if (!description || !open || !row.current || !note.current) return;
    const at = row.current.getBoundingClientRect();
    const box = note.current.getBoundingClientRect();
    const left = Math.max(12, Math.min(at.left, window.innerWidth - box.width - 12));
    const below = at.bottom + 6;
    const top = below + box.height <= window.innerHeight - 12 ? below : Math.max(12, at.top - box.height - 6);
    setPlace({ left, top });
  }, [description, open]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      // Dismiss the hint first, without closing the email dialog behind it.
      event.stopPropagation();
      close();
    };
    const outside = (event) => { if (!row.current?.contains(event.target)) close(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);
  if (!description) return { props: {}, describedBy: undefined, hint: null };
  return {
    describedBy: id,
    props: {
      ref: row,
      onPointerEnter: (event) => { if (event.pointerType !== 'touch') setOpen(true); },
      onPointerDown: (event) => { if (event.pointerType === 'touch') setOpen(true); },
      // Touch sends pointerleave as the finger lifts. Keep its explanation
      // until the next tap elsewhere instead of flashing it for one frame.
      onPointerLeave: (event) => { if (event.pointerType !== 'touch') close(); },
      onFocusCapture: () => setOpen(true),
      onBlurCapture: (event) => { if (!row.current?.contains(event.relatedTarget)) close(); }
    },
    hint: createPortal(<span ref={note} id={id} role="tooltip" hidden={!open} className="switch-hover-note"
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}>{description}</span>, document.body)
  };
}
