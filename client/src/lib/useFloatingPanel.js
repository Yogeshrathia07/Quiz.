import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

const GAP = 6;
const EDGE = 8;

/**
 * A panel drawn on <body> and placed against the button that opened it - a
 * menu, a filter. Drawn inside a table it was cut off by the table's scroll
 * box (and the control panel's rounded clip). It opens upward when there is
 * no room below, never runs off either side, follows the button when the
 * page scrolls, and closes on Escape or a click outside.
 *
 * Put `holder` on what wraps the button and `panel` on the panel, and give
 * the panel `style`: hidden on the first frame while it is measured, so it
 * never flashes in the wrong spot.
 */
export function useFloatingPanel(open, setOpen, align = 'right') {
  const holder = useRef(null);
  const panel = useRef(null);
  const [position, setPosition] = useState(null);

  const place = useCallback(() => {
    const button = holder.current?.getBoundingClientRect();
    const list = panel.current;
    if (!button || !list) return;
    const { offsetWidth: width, offsetHeight: height } = list;
    const roomBelow = window.innerHeight - button.bottom;
    const top = roomBelow >= height + GAP + EDGE || roomBelow >= button.top
      ? button.bottom + GAP
      : button.top - GAP - height;
    const preferred = align === 'left' ? button.left : button.right - width;
    const left = Math.min(Math.max(EDGE, preferred), window.innerWidth - width - EDGE);
    setPosition({ top: Math.max(EDGE, top), left });
  }, [align]);

  useLayoutEffect(() => { if (open) place(); else setPosition(null); }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const inside = (target) => holder.current?.contains(target) || panel.current?.contains(target);
    const onPointerDown = (event) => { if (!inside(event.target)) setOpen(false); };
    const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, place, setOpen]);

  const style = position ? { top: position.top, left: position.left } : { top: 0, left: 0, visibility: 'hidden' };
  return { holder, panel, style };
}
