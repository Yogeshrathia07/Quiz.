import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { browserInfo, browserLinkFor, inAppBrowser } from '../lib/geo.js';
import { CopyLink } from './LocationCheck.jsx';
import { InfoTip } from './InfoTip.jsx';

const STAY_KEY = 'quiz-stay-in-app';

/**
 * Whether to show the "open in your browser" page: this is an app's built-in
 * browser (lib/geo.js), and the student has not chosen to carry on here in
 * this tab. `stay()` remembers that choice for the tab, so a reload does not
 * ask again.
 */
export function useInAppGate() {
  const [inApp] = useState(() => inAppBrowser());
  const [stayed, setStayed] = useState(() => {
    try { return window.sessionStorage.getItem(STAY_KEY) === '1'; } catch { return false; }
  });
  const stay = () => {
    try { window.sessionStorage.setItem(STAY_KEY, '1'); } catch { /* storage blocked: asked again on reload */ }
    setStayed(true);
  };
  return { show: inApp && !stayed, stay };
}

/**
 * Opened from a QR scanner, Snapchat, Instagram, a payment app...: the link is
 * in that app's own built-in browser, where fullscreen and the location check
 * do not work. Shown before anything else - before signing in there for
 * nothing - with one tap to the phone's own browser at the same page, the
 * link to copy, and the app's own menu as a last resort. "Continue here
 * anyway" is for a browser taken for an app by mistake.
 */
export function OpenInBrowser({ url = window.location.href, onContinue, note = null }) {
  const { ios } = browserInfo();
  const target = ios ? 'Safari' : 'Chrome';
  const link = browserLinkFor(url);
  return (
    <section className="join-card card open-in-browser">
      <p className="eyebrow">Open in your browser</p>
      <div className="launch-title">
        <h1>Open this in {target}</h1>
        <InfoTip label="Why your browser">
          This link opened inside another app - a QR scanner, Snapchat, Instagram, a payment app. Apps like these cannot run the
          test properly: fullscreen and the location check do not work in them. Next time, scan with your phone&apos;s Camera app.
        </InfoTip>
      </div>
      <p>You opened this inside another app.</p>
      {link && (
        <a className="button button-primary button-wide open-in-browser-go" href={link}>
          <ExternalLink size={17} aria-hidden="true"/>Open in {target}
        </a>
      )}
      <p className="help">{link ? 'Nothing happened? ' : ''}Copy the link and paste it into {target}:</p>
      <CopyLink url={url}/>
      <p className="help">
        {ios ? 'Or tap ↗ or ⋯ in this app, then "Open in Safari".' : 'Or tap ⋮ in this app, then "Open in Chrome" or "Open in browser".'}
        {note ? ` ${note}` : ''}
      </p>
      <button className="button button-quiet button-small open-in-browser-stay" type="button" onClick={onContinue}>Continue here anyway</button>
    </section>
  );
}
