import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';

const MARGIN = 12;

/**
 * The "how this works" of a page, field or switch, kept out of the way: an (i)
 * that shows the note on a tap or click, and hides it on another, on Escape,
 * on a tap anywhere else, or when the page scrolls. The app carries no
 * instructions of its own beyond what someone needs to act right now.
 *
 * The note is placed on the screen itself, through a portal: under the (i),
 * moved left as far as it must to stay on screen, or above it when there is
 * no room below - so no card that clips its content, and no dialog, cuts it
 * off. Inside a switch's label a tap on the (i) does not flip the switch.
 */
export function InfoTip({ label = 'About this page', children }) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState(null);
  const holder = useRef(null);
  const button = useRef(null);
  const note = useRef(null);
  const noteId = useId();
  const close = () => { setOpen(false); setPlace(null); };

  useLayoutEffect(() => {
    if (!open || !button.current || !note.current) return;
    const at = button.current.getBoundingClientRect();
    const box = note.current.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(at.left - 8, window.innerWidth - box.width - MARGIN));
    const below = at.bottom + 6;
    const above = at.top - box.height - 6;
    // Below when it fits, else above when that fits, else wherever keeps it all
    // on screen (the note scrolls inside itself past its maximum height).
    const fitsBelow = below + box.height <= window.innerHeight - MARGIN;
    const top = fitsBelow ? below : above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - MARGIN - box.height);
    setPlace({ left, top });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') close(); };
    const onPointer = (event) => { if (!holder.current?.contains(event.target) && !note.current?.contains(event.target)) close(); };
    // Only a new width (turning the phone) moves the (i): a phone's address bar
    // showing or hiding changes the height alone, and must not close the note.
    const width = window.innerWidth;
    const onResize = () => { if (window.innerWidth !== width) close(); };
    // A long note scrolls inside itself on a short screen (a phone held
    // sideways); that is reading it, not the page moving away from the (i).
    const onScroll = (event) => { if (!note.current?.contains(event.target)) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open]);

  return (
    // Inside a <label> (a switch row) a tap on the (i) must not flip the switch. A
    // click inside the note - a link in it - reaches here too, through the portal,
    // and is left to do what it does.
    <span className="info-tip" ref={holder} onClick={(event) => { if (!note.current?.contains(event.target)) event.preventDefault(); }}>
      <button ref={button} type="button" className={`info-tip-button${open ? ' is-open' : ''}`} aria-label={label} title={label}
        aria-expanded={open} aria-controls={open ? noteId : undefined} onClick={() => (open ? close() : setOpen(true))}>
        <Info size={17} aria-hidden="true"/>
      </button>
      {open && createPortal(
        <span ref={note} id={noteId} role="note" className="info-tip-note"
          style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}>{children}</span>,
        document.body
      )}
    </span>
  );
}
