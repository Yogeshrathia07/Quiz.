import { useEffect, useState } from 'react';
import { reloadFresh } from './app-shell.js';

/**
 * Notices when the server has a newer build than the one this tab is running.
 *
 * A React page downloads its code once, when the tab opens. React re-renders
 * what the DATA says, but nothing tells an open tab that the CODE on the
 * server changed - so after a deploy every open tab kept the old version until
 * someone pressed refresh. This asks the server every minute (and whenever the
 * tab comes back into view) which build it is serving, by reading the hashed
 * script name from the page, and compares it with the one running here.
 *
 * It only offers a one-tap Update banner and never reloads by itself. A
 * reload mid-test would drop the student out of fullscreen and count as
 * leaving, so a student sitting a paper sees the banner after submitting.
 *
 * A portal page opens from the service worker's saved copy (public/sw.js),
 * which can be one version behind: so it also checks a few seconds after
 * opening, and Update has the saved copy replaced before reloading.
 */
const CHECK_EVERY_MS = 60_000;
const SCRIPT = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/;

let examInProgress = false;
const listeners = new Set();
/** The attempt screen says when a paper is open, so no update ever interrupts it. */
export function setExamInProgress(value) {
  if (examInProgress === Boolean(value)) return;
  examInProgress = Boolean(value);
  listeners.forEach((listener) => listener(examInProgress));
}

/** Whether a paper is open right now - the header hides its way out while it is. */
export function useExamInProgress() {
  const [sitting, setSitting] = useState(examInProgress);
  useEffect(() => {
    listeners.add(setSitting);
    setSitting(examInProgress);
    return () => { listeners.delete(setSitting); };
  }, []);
  return sitting;
}

const runningBuild = () => {
  const script = document.querySelector('script[type="module"][src*="/assets/"]');
  return script ? new URL(script.getAttribute('src'), window.location.origin).pathname : null;
};

async function serverBuild() {
  const response = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } });
  if (!response.ok) return null;
  const match = SCRIPT.exec(await response.text());
  return match ? new URL(match[1], window.location.origin).pathname : null;
}

export function useAppUpdate() {
  const [available, setAvailable] = useState(false);
  const [sitting, setSitting] = useState(examInProgress);

  useEffect(() => {
    listeners.add(setSitting);
    return () => { listeners.delete(setSitting); };
  }, []);

  useEffect(() => {
    const current = runningBuild();
    // Dev server (no hashed build) has hot reload already.
    if (!current || !import.meta.env.PROD) return undefined;
    let stopped = false;

    const check = async () => {
      try {
        const latest = await serverBuild();
        if (stopped || !latest || latest === current) return;
        // Let the offline cache fetch the new files too.
        navigator.serviceWorker?.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
        // Never reload on its own: a half-filled "Create a test" form would be lost.
        setAvailable(true);
      } catch { /* offline: try again next time */ }
    };

    const onVisibility = () => { if (!document.hidden) check(); };
    const soon = window.setTimeout(check, 4_000);
    const timer = window.setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      window.clearTimeout(soon);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return { updateAvailable: available && !sitting, applyUpdate: () => { void reloadFresh(); } };
}
