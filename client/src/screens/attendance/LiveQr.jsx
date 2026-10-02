import { useEffect, useMemo, useRef, useState } from 'react';
import { QR_COLOURS, QUIET, TILE_ROUND, qrLayers } from '../../../../src/domain/qr-art.js';

// Loaded with the first QR shown, not with every admin page.
let qrLibrary = null;
const loadQrLibrary = () => {
  qrLibrary ||= import('qrcode').then((module) => module.default || module).catch((error) => { qrLibrary = null; throw error; });
  return qrLibrary;
};

let svgCount = 0;
/** How long a change of code fades for (attendance.css: .att-qr-enter, .att-qr-leave), and a little over. */
const FADE_MS = 500;

/**
 * The code on its white tile. While it changes it is drawn in layers (see
 * qrLayers): what stays, solid, then the old code fading out and the new one
 * fading in. Then, until the next change, just the new code. Every shape
 * shares one gradient, laid across the whole code.
 */
function QrSvg({ layers, id }) {
  const [gradient] = useState(() => `att-qr-ink-${(svgCount += 1)}`);
  const [settled, setSettled] = useState(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(id), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [id]);
  const side = layers.size + QUIET * 2;
  const ink = `url(#${gradient})`;
  const fading = settled !== id && Boolean(layers.leave);
  return (
    <svg className="att-qr-code" viewBox={`${-QUIET} ${-QUIET} ${side} ${side}`} role="img" aria-label="Attendance QR code">
      <defs>
        <linearGradient id={gradient} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={layers.size} y2={layers.size}>
          <stop offset="0" stopColor={QR_COLOURS.from}/>
          <stop offset="1" stopColor={QR_COLOURS.to}/>
        </linearGradient>
      </defs>
      <rect x={-QUIET} y={-QUIET} width={side} height={side} rx={TILE_ROUND} fill={QR_COLOURS.paper}/>
      <path d={layers.rings} fill={QR_COLOURS.ring} fillRule="evenodd"/>
      <path d={layers.centres} fill={QR_COLOURS.centre}/>
      {fading ? <>
        <path d={layers.stay} fill={ink}/>
        {/* Keyed by the code, so each change starts its fade afresh. */}
        <path key={`leave-${id}`} className="att-qr-leave" d={layers.leave} fill={ink}/>
        <path key={`enter-${id}`} className="att-qr-enter" d={layers.all} fill={ink}/>
      </> : <path d={layers.all} fill={ink}/>}
    </svg>
  );
}

/**
 * The class QR. It changes every 2 seconds: the server sends the next minute of
 * codes with each refresh of the session, and this draws the one for the
 * moment it is - on the server's clock, so every screen showing it agrees -
 * fading from the last into the next. Should the codes run out (no refresh
 * for a minute), it says so rather than show a code that no longer works.
 */
export function LiveQr({ session }) {
  const { qr } = session;
  const [library, setLibrary] = useState(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [big, setBig] = useState(false);
  const offset = useRef(0);
  useEffect(() => { offset.current = Date.parse(session.serverTime) - Date.now(); }, [session.serverTime]);

  useEffect(() => {
    let live = true;
    loadQrLibrary().then((loaded) => { if (live) setLibrary(loaded); }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, []);

  // Woken just after each change of code.
  useEffect(() => {
    let timer;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      timer = window.setTimeout(tick, qr.stepMs - ((at + offset.current) % qr.stepMs) + 15);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [qr.stepMs]);

  // Full screen closes with a click anywhere, or Escape.
  useEffect(() => {
    if (!big) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setBig(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [big]);

  const step = Math.floor((now + offset.current) / qr.stepMs);
  const key = qr.keys[step - qr.from] || null;
  const link = qr.link.startsWith('/') ? `${window.location.origin}${qr.link}` : qr.link;
  const modules = useMemo(() => (library && key ? library.create(`${link}${key}`, { errorCorrectionLevel: 'M' }).modules : null), [library, link, key]);
  // The code shown before this one, to fade from. Kept so that working it out
  // twice for one code (as React may) gives the same answer.
  const memory = useRef({ modules: null, before: null });
  const layers = useMemo(() => {
    if (!modules) return null;
    if (memory.current.modules !== modules) memory.current = { modules, before: memory.current.modules };
    return qrLayers(modules, memory.current.before);
  }, [modules]);

  const code = layers ? <QrSvg layers={layers} id={key}/> : (
    <span className="att-qr-wait" role="status">{failed ? 'The QR could not load. Reload the page.' : key ? 'Loading the QR…' : 'Reconnecting…'}</span>
  );

  return (
    <div className="att-qr">
      <button className="att-qr-button" type="button" onClick={() => setBig(true)} disabled={!layers} aria-label="Show the QR full screen">
        {code}
      </button>
      {/* What the class sees on the projector: the class, the day, the QR - nothing else. */}
      {big && (
        <div className="att-qr-full" role="dialog" aria-label="Attendance QR" onClick={() => setBig(false)}>
          <h1>{session.title}</h1>
          <p>{new Date(session.createdAt).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
          <div className="att-qr-full-code">{code}</div>
        </div>
      )}
    </div>
  );
}
