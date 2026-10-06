import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 8;
const EDGE = 8;

/**
 * One tooltip for the whole app. Anything with `data-tip` shows it the moment
 * the pointer is on it, or it has keyboard focus - a browser's own title
 * waits a second or more. A small card above it (below when there is no room
 * above), kept on screen; `data-tip-tone` ('ok', 'warn', 'danger', 'info')
 * gives it a coloured edge to match the sign it explains.
 */
export function HoverTips() {
  const [tip, setTip] = useState(null);
  const card = useRef(null);
  const [place, setPlace] = useState(null);

  useEffect(() => {
    let current = null;
    const show = (event) => {
      const element = event.target?.closest?.('[data-tip]');
      if (!element || element === current || !element.dataset.tip) return;
      current = element;
      setPlace(null);
      setTip({ text: element.dataset.tip, tone: element.dataset.tipTone || null, rect: element.getBoundingClientRect() });
    };
    const hide = (event) => {
      if (!current || (event.relatedTarget && current.contains(event.relatedTarget))) return;
      current = null;
      setTip(null);
    };
    const clear = () => { current = null; setTip(null); };
    document.addEventListener('pointerover', show);
    document.addEventListener('pointerout', hide);
    document.addEventListener('focusin', show);
    document.addEventListener('focusout', hide);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      document.removeEventListener('pointerover', show);
      document.removeEventListener('pointerout', hide);
      document.removeEventListener('focusin', show);
      document.removeEventListener('focusout', hide);
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, []);

  // Measured once drawn: centred on its sign, inside the window either way.
  useLayoutEffect(() => {
    if (!tip || !card.current) return;
    const { width, height } = card.current.getBoundingClientRect();
    const above = tip.rect.top - GAP - height >= EDGE;
    const centre = tip.rect.left + tip.rect.width / 2;
    setPlace({
      left: Math.min(Math.max(EDGE, centre - width / 2), window.innerWidth - width - EDGE),
      top: above ? tip.rect.top - GAP - height : tip.rect.bottom + GAP,
      above
    });
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div
      ref={card}
      className={`hover-tip${tip.tone ? ` is-${tip.tone}` : ''}${place ? (place.above ? ' is-above' : ' is-below') : ''}`}
      role="tooltip"
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {tip.text}
    </div>,
    document.body
  );
}
