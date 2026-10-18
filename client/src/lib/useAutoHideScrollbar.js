import { useCallback, useEffect, useRef } from 'react';

/** Reveal a native thumb during use, then hide it without re-rendering the
 * list on each scroll event. Keep the gutter so the content never jumps. */
export function useAutoHideScrollbar() {
  const pending = useRef(null);
  const target = useRef(null);
  const reveal = useCallback((event) => {
    const element = event.currentTarget;
    if (target.current && target.current !== element) delete target.current.dataset.scrollActive;
    target.current = element;
    element.dataset.scrollActive = 'true';
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => {
      delete element.dataset.scrollActive;
      target.current = null;
    }, 1000);
  }, []);
  useEffect(() => () => {
    window.clearTimeout(pending.current);
    if (target.current) delete target.current.dataset.scrollActive;
  }, []);
  return { onScroll: reveal, onPointerEnter: reveal, onFocusCapture: reveal };
}
