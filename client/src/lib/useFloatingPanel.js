import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const GAP = 6;
const EDGE = 8;
/** As filters.css: at this width a dialog panel is a sheet from the bottom. */
const PHONE = '(max-width: 560px)';

/** How tall the panel is with nothing holding it in - even while something is. */
function naturalHeight(list) {
  const inside = [...list.children].reduce((sum, child) => sum + Math.max(child.offsetHeight, child.scrollHeight), 0);
  return Math.max(list.offsetHeight, list.scrollHeight, inside + list.offsetHeight - list.clientHeight);
}

/**
 * A panel drawn on <body> and placed against the button that opened it - a
 * menu, a filter. Drawn inside a table it was cut off by the table's scroll
 * box (and the control panel's rounded clip). It opens upward when there is
 * no room below, never runs off either side, follows the button when the
 * page scrolls, and closes on Escape or a click outside.
 *
 * It is never taller than the room on its side of the button: a long panel
 * scrolls inside itself instead of running off the bottom of the screen,
 * where its last options and its buttons could not be reached.
 *
 * With `dialog`, a panel that fits on neither side of the button - or any
 * panel on a phone - is not squeezed into the gap: it opens as a dialog
 * instead (`isDialog`; the caller's CSS centres it, or makes it a sheet from
 * the bottom on a phone), over a backdrop.
 *
 * Put `holder` on what wraps the button and `panel` on the panel, and give
 * the panel `style`: hidden on the first frame while it is measured, so it
 * never flashes in the wrong spot. A backdrop drawn behind the panel is
 * marked `data-panel-backdrop` and closes it with its own click, so the tap
 * that closes a panel never lands on what was underneath.
 */
export function useFloatingPanel(open, setOpen, align = 'right', { dialog = false } = {}) {
  const holder = useRef(null);
  const panel = useRef(null);
  const [position, setPosition] = useState(null);

  // `decide`: choose between beside-the-button and a dialog (on opening and on
  // resizing). A page scroll only moves a panel that is beside its button.
  const place = useCallback((decide = true) => {
    const button = holder.current?.getBoundingClientRect();
    const list = panel.current;
    if (!button || !list) return;
    const width = list.offsetWidth;
    const height = naturalHeight(list);
    const roomBelow = window.innerHeight - button.bottom - GAP - EDGE;
    const roomAbove = button.top - GAP - EDGE;
    const fitsBelow = height <= roomBelow;
    const fitsAbove = height <= roomAbove;
    const cramped = window.matchMedia?.(PHONE).matches || (!fitsBelow && !fitsAbove);
    setPosition((current) => {
      if (dialog && (decide ? cramped : current?.mode === 'dialog')) return current?.mode === 'dialog' ? current : { mode: 'dialog' };
      const below = fitsBelow || (!fitsAbove && roomBelow >= roomAbove);
      const maxHeight = Math.max(120, below ? roomBelow : roomAbove);
      const top = Math.max(EDGE, below ? button.bottom + GAP : button.top - GAP - Math.min(height, maxHeight));
      const preferred = align === 'left' ? button.left : button.right - width;
      const left = Math.min(Math.max(EDGE, preferred), window.innerWidth - width - EDGE);
      const unchanged = current?.mode === 'beside' && current.top === top && current.left === left && current.maxHeight === maxHeight;
      return unchanged ? current : { mode: 'beside', top, left, maxHeight };
    });
  }, [align, dialog]);

  useLayoutEffect(() => { if (open) place(true); else setPosition(null); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const inside = (target) => holder.current?.contains(target) || panel.current?.contains(target)
      || Boolean(target?.closest?.('[data-panel-backdrop]'));
    const onPointerDown = (event) => { if (!inside(event.target)) setOpen(false); };
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    // Scrolling the panel's own list is not the page moving.
    const onScroll = (event) => { if (!panel.current?.contains(event.target)) place(false); };
    const onResize = () => place(true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, place, setOpen]);

  // For a panel whose size changed while open (more columns, say).
  const reposition = useCallback(() => place(true), [place]);
  const isDialog = position?.mode === 'dialog';
  const style = !position
    ? { top: 0, left: 0, visibility: 'hidden' }
    : isDialog ? undefined : { top: position.top, left: position.left, maxHeight: position.maxHeight };
  return { holder, panel, style, isDialog, reposition };
}
