import { useCallback, useEffect, useState } from 'react';
import { detectWindowDetails } from '../lib/private-mode.js';

const RUNS = 3;

const VERDICT = {
  private: { title: 'Private window', tone: 'success', text: 'A test that needs a private window opens here.' },
  normal: { title: 'Normal window', tone: 'danger', text: 'A test that needs a private window is blocked here.' },
  mobile: { title: 'Could not tell', tone: 'warn', text: 'This phone browser gives no answer, so a test that needs a private window lets it through.' },
  no_extensions: { title: 'No extensions here', tone: 'success', text: 'This phone browser cannot run extensions, so there is nothing to switch off: a test that needs a private window opens here in a normal tab too.' },
  unknown: { title: 'Could not tell', tone: 'warn', text: 'This browser gives no answer, so a test that needs a private window lets it through.' }
};

/**
 * What the private-window check decides in this browser, for trying it on
 * the students' phones before a test (?page=window-check, no sign-in needed).
 * Browsers hide private windows on purpose, so the check is a best guess: it
 * runs a few times here, and an answer that changes between runs, or is the
 * same in a normal and a private window, means this browser cannot be judged.
 */
export function WindowCheckScreen() {
  const [runs, setRuns] = useState(null);
  const check = useCallback(async () => {
    setRuns(null);
    const results = [];
    // One after another: the check times storage writes, and two at once would slow each other.
    for (let run = 0; run < RUNS; run += 1) results.push(await detectWindowDetails());
    setRuns(results);
  }, []);
  useEffect(() => { check(); }, [check]);

  const first = runs?.[0];
  const steady = runs && runs.every((run) => run.kind === first.kind);
  const verdictOf = (run) => VERDICT[run.reason === 'no_extensions' ? 'no_extensions' : run.kind];
  const verdict = first && verdictOf(first);
  return (
    <section className="join-card card window-check">
      <p className="eyebrow">Private window check</p>
      <h1>{verdict ? verdict.title : 'Checking this window…'}</h1>
      {verdict && <p className={`notice ${verdict.tone === 'success' ? 'success' : verdict.tone === 'danger' ? 'danger' : ''}`}>{verdict.text}</p>}
      {runs && (
        <dl className="window-check-facts">
          <div><dt>Result</dt><dd>{steady ? `${verdict.title}, all ${RUNS} times` : `Not steady: ${runs.map((run) => verdictOf(run).title).join(' · ')}`}</dd></div>
          <div><dt>Browser</dt><dd>{first.reason === 'no_extensions' ? 'A phone browser with no extensions - not checked' : `${first.browserName || 'Not recognised'} on a ${first.mobile ? 'phone or tablet' : 'computer'}`}</dd></div>
          {first.reason !== 'no_extensions' && <div><dt>Time taken</dt><dd>{runs.map((run) => `${run.ms} ms`).join(' · ')}</dd></div>}
        </dl>
      )}
      <p className="help">
        To try a phone: open this page in a normal tab, then in a private (Incognito) tab. The first should say
        Normal window and the second Private window. If a browser gets either one wrong, or the answer is not steady,
        the check cannot judge that browser.
      </p>
      <button className="button button-secondary" type="button" disabled={!runs} onClick={check}>Check again</button>
    </section>
  );
}
