import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, LocateFixed, MapPin, RotateCw } from 'lucide-react';
import { LocationProblem, browserInfo, getBrowserLocation, imprecision, knownProblem, locationPermission } from '../lib/geo.js';

/** A reading this recent is used as it is; an older one is taken again. */
const FRESH_MS = 60_000;

/**
 * The venue check before a test or an attendance mark, done as its own step.
 *
 * Asked out of the blue - the moment Begin was tapped - many students tapped
 * "Don't Allow" by reflex, and an iPhone never asks again after that. So the
 * page says first what is coming and asks only when the student taps Allow
 * location. Where the answer is already known it does not wait for a tap:
 * allowed, the location is found straight away with nothing to answer;
 * blocked, or inside another app, the way out is on screen from the start.
 * Coming back from Settings looks again.
 */
export function useLocationCheck(enabled) {
  const [phase, setPhase] = useState('idle'); // idle | asking | found | problem
  const [reading, setReading] = useState(null);
  const [problem, setProblem] = useState(null);
  const readAt = useRef(0);
  const inflight = useRef(null);

  const request = useCallback(() => {
    if (inflight.current) return inflight.current;
    setPhase('asking');
    const run = getBrowserLocation().then((point) => {
      readAt.current = Date.now();
      setReading(point);
      setProblem(imprecision(point));
      setPhase('found');
      return point;
    }, (error) => {
      setProblem(error);
      setPhase('problem');
      throw error;
    }).finally(() => { inflight.current = null; });
    inflight.current = run;
    return run;
  }, []);

  const fresh = useCallback(() => (reading && Date.now() - readAt.current < FRESH_MS ? reading : null), [reading]);

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    const known = knownProblem();
    if (known) {
      setProblem(known);
      setPhase('problem');
      return undefined;
    }
    const look = async () => {
      const state = await locationPermission();
      if (!alive || inflight.current) return;
      if (state === 'granted' && !(readAt.current && Date.now() - readAt.current < FRESH_MS)) request().catch(() => {});
      if (state === 'denied') { setProblem(new LocationProblem('denied')); setPhase('problem'); }
    };
    look();
    const onVisible = () => { if (!document.hidden) look(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [enabled, request]);

  return { phase, reading, problem, request, fresh };
}

/** The page's own link, to open in a real browser. */
function CopyLink() {
  const [copied, setCopied] = useState(false);
  const field = useRef(null);
  const url = window.location.href;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard here: select it, so a long-press copies it.
      field.current?.focus();
      field.current?.select();
    }
  };
  return (
    <div className="location-copy">
      <input ref={field} className="text-input" readOnly value={url} aria-label="Link to this page" onFocus={(event) => event.target.select()}/>
      <button type="button" className="button button-secondary button-small" onClick={copy}>
        {copied ? <Check size={15} aria-hidden="true"/> : <Copy size={15} aria-hidden="true"/>}{copied ? 'Copied' : 'Copy link'}
      </button>
    </div>
  );
}

/** Why the location could not be had, and the numbered steps out of it. */
export function LocationHelp({ problem, children }) {
  if (!problem) return null;
  const title = typeof problem === 'string' ? problem : problem.title || problem.message;
  const steps = typeof problem === 'string' ? [] : problem.steps || [];
  return (
    <div className={`notice location-help${problem.reason === 'imprecise' ? '' : ' danger'}`} role="alert">
      <strong>{title}</strong>
      {steps.length > 0 && <ol className="location-steps">{steps.map((step) => <li key={step}>{step}</li>)}</ol>}
      {problem.copyLink && <CopyLink/>}
      {children}
    </div>
  );
}

/**
 * The venue step on a page: what is about to be asked and the button that
 * asks it; then either "found" or the way to fix what went wrong.
 */
export function LocationPanel({ check, intro }) {
  const { phase, reading, problem, request } = check;
  const asking = phase === 'asking';
  const tryIt = () => { request().catch(() => {}); };
  if (phase === 'found' && !problem) {
    return (
      <div className="notice success location-ok" role="status">
        <MapPin size={16} aria-hidden="true"/>
        <span><strong>Location found</strong> - accurate to ±{Math.round(reading.accuracyMeters)} m.</span>
      </div>
    );
  }
  if (problem) {
    const label = problem.reason === 'inapp' ? 'Try here anyway' : problem.reason === 'imprecise' ? 'Check again' : 'Try again';
    return (
      <LocationHelp problem={problem}>
        <div className="location-actions">
          <button type="button" className="button button-secondary button-small location-retry" disabled={asking} onClick={tryIt}>
            <LocateFixed size={15} aria-hidden="true"/>{asking ? 'Finding your location…' : label}
          </button>
          {/* A setting changed in Settings often counts only once the page is
              loaded again - an iPhone keeps refusing until then. */}
          {problem.reason === 'denied' && (
            <button type="button" className="button button-quiet button-small location-reload" onClick={() => window.location.reload()}>
              <RotateCw size={15} aria-hidden="true"/>Reload page
            </button>
          )}
        </div>
      </LocationHelp>
    );
  }
  return (
    <div className="notice location-ask">
      <strong>Venue check</strong>
      <p className="help">
        {intro} Tap <strong>Allow location</strong> - when your phone asks, choose <strong>Allow</strong>
        {browserInfo().ios ? ', with Precise Location on' : ''}.
      </p>
      <button type="button" className="button button-primary button-small location-allow" disabled={asking} onClick={tryIt}>
        <LocateFixed size={15} aria-hidden="true"/>{asking ? 'Finding your location…' : 'Allow location'}
      </button>
    </div>
  );
}
