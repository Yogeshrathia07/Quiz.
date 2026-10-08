import { useLayoutEffect, useRef } from 'react';

/**
 * A dashboard tab exactly one screen tall - wider than a phone, nothing below
 * the fold: the element gets `--ov-fit`, the height the window has left under
 * the header, and its stylesheet shares that out (the Test tab: .ov.is-fit;
 * the Analysis tab: .an). On a phone the page simply scrolls.
 */
export function useFitToScreen(enabled = true) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return undefined;
    const fit = () => {
      const main = element.closest('main');
      const below = main ? parseFloat(getComputedStyle(main).paddingBottom) || 0 : 0;
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.setProperty('--ov-fit', `${Math.floor(window.innerHeight - top - below)}px`);
    };
    fit();
    window.addEventListener('resize', fit);
    // A title that wraps, or the tabs moving to their own row, moves the top.
    const head = document.querySelector('.dashboard-head');
    const observer = head && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    observer?.observe(head);
    return () => {
      window.removeEventListener('resize', fit);
      observer?.disconnect();
      element.style.removeProperty('--ov-fit');
    };
  }, [enabled]);
  return ref;
}
