import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Expand, Maximize, Minimize, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';


/**
 * Every picture loads once: the paper fetches all of its pictures as it
 * opens (useImagesSettled), and each one shown on a question waits on the same
 * load rather than starting another. Resolves true when loaded, false when
 * it could not be.
 */
const loads = new Map();
export function loadImage(url) {
  if (!url) return Promise.resolve(false);
  if (!loads.has(url)) {
    const image = new Image();
    image.decoding = 'async';
    const done = new Promise((resolve) => {
      image.onload = () => resolve(true);
      image.onerror = () => { loads.delete(url); resolve(false); };
    });
    image.src = url;
    loads.set(url, done);
  }
  return loads.get(url);
}

/**
 * The paper's pictures come down this many at a time, in the paper's order,
 * so the first question's is not held up behind the last one's. A picture on
 * the question open now (QuestionImage) does not wait its turn.
 */
const LOADS_AT_ONCE = 3;

/**
 * Which of these pictures have finished arriving (loaded, or given up on):
 * a Set of their addresses, growing as each one lands. The paper waits on it
 * before telling the server a question is on screen, so a question's clock
 * does not run while its picture is still on its way.
 */
export function useImagesSettled(urls) {
  const key = urls.join('\n');
  const [settled, setSettled] = useState(() => new Set());
  useEffect(() => {
    let alive = true;
    const queue = key ? key.split('\n') : [];
    const next = () => {
      const url = alive ? queue.shift() : null;
      if (!url) return;
      loadImage(url).then(() => {
        if (!alive) return;
        setSettled((current) => (current.has(url) ? current : new Set(current).add(url)));
        next();
      });
    };
    for (let slot = 0; slot < LOADS_AT_ONCE; slot += 1) next();
    return () => { alive = false; };
  }, [key]);
  return settled;
}

/**
 * A question's picture on the page. Room is kept for it at its own shape
 * while it loads, so nothing on the question moves when it arrives, and it
 * says so meanwhile. A tap opens it big (ImageViewer); a picture that did not
 * load can be tried again.
 */
export function QuestionImage({ image, label = 'Picture for this question', compact = false }) {
  const [state, setState] = useState('loading');
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const src = attempt ? `${image.url}?retry=${attempt}` : image.url;
  useEffect(() => {
    let alive = true;
    setState('loading');
    loadImage(src).then((ok) => { if (alive) setState(ok ? 'ready' : 'failed'); });
    return () => { alive = false; };
  }, [src]);
  return (
    <figure className={`q-image is-${state}${compact ? ' is-compact' : ''}`} style={{ '--q-image-ratio': `${image.width} / ${image.height}`, '--q-image-r': image.width / image.height, '--q-image-width': `${image.width}px` }}>
      <button type="button" className="q-image-button" disabled={state === 'loading'}
        onClick={() => (state === 'failed' ? setAttempt((value) => value + 1) : setOpen(true))}
        aria-label={state === 'failed' ? `${label} did not load: try again` : `${label}: open it bigger`}>
        {state === 'ready' && <img src={src} width={image.width} height={image.height} alt={label} decoding="async"/>}
        {state === 'loading' && <span className="q-image-note"><span className="q-image-spinner" aria-hidden="true"/>Loading picture…</span>}
        {state === 'failed' && <span className="q-image-note"><RotateCw size={16} aria-hidden="true"/>The picture did not load. Tap to try again.</span>}
        {state === 'ready' && <span className="q-image-open" aria-hidden="true"><Expand size={15}/></span>}
      </button>
      {open && <ImageViewer image={{ ...image, url: src }} label={label} onClose={() => setOpen(false)}/>}
    </figure>
  );
}

/** How far in a picture may be zoomed, and each step of the − and + buttons. */
const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const STEP = 1.5;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/**
 * A picture over the whole screen, as big as fits. Bigger and smaller with
 * two fingers (pinch), the mouse wheel or a trackpad, − and +, or a double
 * tap - always about the point under the fingers or the pointer; dragged
 * around with one finger or the mouse once it is bigger than the screen, and
 * never dragged off it. Full screen where the page is not in full screen
 * already - in a test it already is, and changing which part of the page
 * fills the screen would count as leaving it. Closes with ×, Escape, or a tap
 * beside the picture.
 */
export function ImageViewer({ image, label, onClose }) {
  const shell = useRef(null);
  const stage = useRef(null);
  const closeButton = useRef(null);
  const [fit, setFit] = useState(null);
  // The picture's zoom and how far it has been moved from the middle, in screen pixels.
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [fullscreen, setFullscreen] = useState(false);
  const canFullscreen = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled) && !document.fullscreenElement;
  const latest = useRef({ view, fit });
  latest.current = { view, fit };

  const measure = useCallback(() => {
    const box = stage.current?.getBoundingClientRect();
    if (!box) return;
    const ratio = image.width / image.height;
    // Inside the stage's padding (theme.css: 12px each side).
    const width = Math.max(40, Math.min(box.width - 24, (box.height - 24) * ratio));
    setFit({ width, height: width / ratio, stageWidth: box.width, stageHeight: box.height, left: box.left, top: box.top });
  }, [image.width, image.height]);
  useLayoutEffect(() => { measure(); }, [measure, fullscreen]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);

  /** Kept on screen: a picture bigger than the stage moves only as far as its edges. */
  const bounded = useCallback((next, sizing = latest.current.fit) => {
    if (!sizing) return next;
    const zoom = clamp(next.zoom, MIN_ZOOM, MAX_ZOOM);
    const roomX = Math.max(0, (sizing.width * zoom - sizing.stageWidth + 24) / 2);
    const roomY = Math.max(0, (sizing.height * zoom - sizing.stageHeight + 24) / 2);
    return { zoom, x: clamp(next.x, -roomX, roomX), y: clamp(next.y, -roomY, roomY) };
  }, []);

  /** To `zoom`, keeping the point at (clientX, clientY) where it is on the screen. */
  const zoomAt = useCallback((zoom, clientX, clientY) => {
    setView((current) => {
      const sizing = latest.current.fit;
      if (!sizing) return current;
      const next = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
      const px = clientX - (sizing.left + sizing.stageWidth / 2);
      const py = clientY - (sizing.top + sizing.stageHeight / 2);
      const scale = next / current.zoom;
      return bounded({ zoom: next, x: px - (px - current.x) * scale, y: py - (py - current.y) * scale }, sizing);
    });
  }, [bounded]);
  const middle = () => {
    const sizing = latest.current.fit;
    return sizing ? [sizing.left + sizing.stageWidth / 2, sizing.top + sizing.stageHeight / 2] : [0, 0];
  };
  const zoomIn = () => zoomAt(view.zoom * STEP, ...middle());
  const zoomOut = () => zoomAt(view.zoom / STEP, ...middle());

  // The wheel and a trackpad (a pinch there arrives as a wheel with Ctrl held): zoom where the pointer is.
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const onWheel = (event) => {
      event.preventDefault();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0018));
      zoomAt(latest.current.view.zoom * factor, event.clientX, event.clientY);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // Fingers and the mouse: one moves the picture, two pinch it; a double tap zooms in or back.
  const pointers = useRef(new Map());
  const gesture = useRef({ moved: false, lastTap: 0, pinch: null });
  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button > 0) return;
    try { stage.current?.setPointerCapture?.(event.pointerId); } catch { /* a pointer the browser no longer tracks */ }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 1) gesture.current.moved = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: latest.current.view.zoom, mid: [(a.x + b.x) / 2, (a.y + b.y) / 2] };
    }
  };
  const onPointerMove = (event) => {
    const before = pointers.current.get(event.pointerId);
    if (!before) return;
    const now = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, now);
    if (Math.hypot(now.x - before.x, now.y - before.y) > 2) gesture.current.moved = true;
    if (pointers.current.size >= 2 && gesture.current.pinch) {
      const [a, b] = [...pointers.current.values()];
      const mid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const pinch = gesture.current.pinch;
      const zoom = pinch.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance));
      // Pan with the fingers' middle, then zoom about it.
      setView((current) => bounded({ ...current, x: current.x + mid[0] - pinch.mid[0], y: current.y + mid[1] - pinch.mid[1] }));
      pinch.mid = mid;
      zoomAt(zoom, mid[0], mid[1]);
      return;
    }
    if (latest.current.view.zoom > 1) setView((current) => bounded({ ...current, x: current.x + now.x - before.x, y: current.y + now.y - before.y }));
  };
  const onPointerUp = (event) => {
    const wasDown = pointers.current.has(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) gesture.current.pinch = null;
    if (!wasDown || pointers.current.size > 0 || gesture.current.moved) return;
    const at = Date.now();
    if (at - gesture.current.lastTap < 320) {
      gesture.current.lastTap = 0;
      zoomAt(latest.current.view.zoom > 1 ? 1 : 2.5, event.clientX, event.clientY);
      return;
    }
    gesture.current.lastTap = at;
    // A single tap beside the picture closes it (after a moment, in case a second tap follows).
    if (!event.target.closest?.('img')) {
      window.setTimeout(() => { if (gesture.current.lastTap === at) onClose(); }, 320);
    }
  };

  // Keys: Escape closes, + and - zoom. The page behind holds still.
  useEffect(() => {
    const before = document.activeElement;
    closeButton.current?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === '+' || event.key === '=') zoomIn();
      if (event.key === '-') zoomOut();
    };
    document.addEventListener('keydown', onKey, true);
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      root.style.overflow = previous;
      before?.focus?.();
    };
  }, [onClose]); // eslint-disable-line react-hooks/exhaustive-deps

  // Leaving: out of the full screen this opened (never one it did not).
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      if (document.fullscreenElement && document.fullscreenElement === shell.current) document.exitFullscreen?.().catch(() => {});
    };
  }, []);
  // A new size of screen: the picture fits again, wherever it was.
  useEffect(() => { setView((current) => bounded(current)); }, [fit, bounded]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement === shell.current) document.exitFullscreen?.().catch(() => {});
    else shell.current?.requestFullscreen?.().catch(() => {});
  };

  return createPortal(
    <div ref={shell} className="image-viewer" role="dialog" aria-modal="true" aria-label={label}>
      <div className="image-viewer-bar">
        <span className="image-viewer-zoom">{Math.round(view.zoom * 100)}%</span>
        <button type="button" className="image-viewer-button" onClick={zoomOut} disabled={view.zoom <= MIN_ZOOM + 0.001} aria-label="Smaller" title="Smaller"><ZoomOut size={18} aria-hidden="true"/></button>
        <button type="button" className="image-viewer-button" onClick={zoomIn} disabled={view.zoom >= MAX_ZOOM - 0.001} aria-label="Bigger" title="Bigger"><ZoomIn size={18} aria-hidden="true"/></button>
        {(canFullscreen || fullscreen) && (
          <button type="button" className="image-viewer-button" onClick={toggleFullscreen} aria-label={fullscreen ? 'Leave full screen' : 'Full screen'} title={fullscreen ? 'Leave full screen' : 'Full screen'}>
            {fullscreen ? <Minimize size={18} aria-hidden="true"/> : <Maximize size={18} aria-hidden="true"/>}
          </button>
        )}
        <button ref={closeButton} type="button" className="image-viewer-button is-close" onClick={onClose} aria-label="Close" title="Close"><X size={20} aria-hidden="true"/></button>
      </div>
      <div ref={stage} className={`image-viewer-stage${view.zoom > 1 ? ' is-zoomed' : ''}`}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        {fit && (
          <img src={image.url} alt={label} draggable="false"
            style={{ width: fit.width, height: fit.height, transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}/>
        )}
      </div>
      <p className="image-viewer-hint">Pinch, scroll or double-tap to zoom · drag to move</p>
    </div>,
    document.body
  );
}
