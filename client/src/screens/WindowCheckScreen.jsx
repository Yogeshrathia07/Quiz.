import { useCallback, useEffect, useState } from 'react';
import { InfoTip } from '../components/InfoTip.jsx';
import { detectWindowDetails } from '../lib/private-mode.js';
import { DEVICE_WORDS, checkThisDevice, readDeviceSignals } from '../lib/device.js';

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
/**
 * What the device check (src/domain/device.js) takes this device for, with
 * every signal it read and anything that disagreed, and whether a phones-only
 * or laptops-only test would let it begin. For trying students' phones and
 * laptops before a test.
 */
function DeviceCheckCard() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const check = useCallback(async () => {
    setResult(null);
    setError('');
    try { setResult(await checkThisDevice()); } catch (failure) { setError(failure.message); }
  }, []);
  useEffect(() => { check(); }, [check]);
  const signals = readDeviceSignals();
  const device = result?.device;
  const yes = (value) => (value === true ? 'yes' : value === false ? 'no' : 'not reported');
  return (
    <section className="join-card card window-check device-check">
      <p className="eyebrow">Device check</p>
      <div className="page-heading">
        <h1>{device ? `A ${DEVICE_WORDS[device.kind] || DEVICE_WORDS.unknown}` : error ? 'Could not check' : 'Checking this device…'}</h1>
        <InfoTip label="How a device is told apart">
          A phone or tablet is known by its touch screen (a phone&apos;s short side is under 600 points); a laptop by its
          mouse or trackpad, even with a touch screen. Try a phone in its normal mode and with “Desktop site” on.
        </InfoTip>
      </div>
      {error && <p className="notice danger">{error}</p>}
      {device && (
        <>
          <p className={`notice ${device.suspicious ? 'danger' : 'success'}`}>
            {device.suspicious ? 'Its signals disagree - the teacher sees this on the student’s row.' : 'Its signals agree.'}
          </p>
          <dl className="window-check-facts">
            <div><dt>Browser</dt><dd>{device.label}</dd></div>
            <div><dt>Phones-only test</dt><dd>{result.fits.phone ? 'Can begin' : 'Cannot begin'}</dd></div>
            <div><dt>Laptops-only test</dt><dd>{result.fits.laptop ? 'Can begin' : 'Cannot begin'}</dd></div>
            <div><dt>Signals</dt><dd>{device.facts || 'None reported'}</dd></div>
            {device.notes.map((note) => <div key={note}><dt>Note</dt><dd>{note}</dd></div>)}
          </dl>
          <details className="device-check-raw">
            <summary>Everything this browser reports</summary>
            <dl className="window-check-facts">
              <div><dt>Main pointer</dt><dd>{signals?.pointer === 'fine' ? 'Mouse or trackpad' : signals?.pointer === 'coarse' ? 'Finger (touch)' : signals?.pointer || 'Not reported'}</dd></div>
              <div><dt>Any mouse or trackpad</dt><dd>{yes(signals?.anyFine)}</dd></div>
              <div><dt>Can hover</dt><dd>{yes(signals?.hover)}</dd></div>
              <div><dt>Touch points</dt><dd>{signals?.touchPoints ?? 0}</dd></div>
              <div><dt>Screen</dt><dd>{signals?.screenW}×{signals?.screenH} at ×{signals?.dpr}</dd></div>
              <div><dt>Window</dt><dd>{window.innerWidth}×{window.innerHeight}</dd></div>
              <div><dt>Chrome’s “mobile”</dt><dd>{yes(signals?.chMobile)}</dd></div>
              <div><dt>System</dt><dd>{[signals?.platform, signals?.chPlatform].filter(Boolean).join(' / ') || 'Not reported'}</dd></div>
              <div><dt>User agent</dt><dd className="device-check-ua">{signals?.ua}</dd></div>
            </dl>
          </details>
        </>
      )}
      <button className="button button-secondary" type="button" disabled={!result && !error} onClick={check}>Check again</button>
    </section>
  );
}

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
    <div className="join-stack">
      <section className="join-card card window-check">
        <p className="eyebrow">Private window check</p>
        <div className="page-heading">
          <h1>{verdict ? verdict.title : 'Checking this window…'}</h1>
          <InfoTip label="How to try a phone">
            Open this page in a normal tab, then in a private (Incognito) tab. The first should say Normal window and the
            second Private window. If a browser gets either one wrong, or the answer is not steady, the check cannot judge that browser.
          </InfoTip>
        </div>
        {verdict && <p className={`notice ${verdict.tone === 'success' ? 'success' : verdict.tone === 'danger' ? 'danger' : ''}`}>{verdict.text}</p>}
        {runs && (
          <dl className="window-check-facts">
            <div><dt>Result</dt><dd>{steady ? `${verdict.title}, all ${RUNS} times` : `Not steady: ${runs.map((run) => verdictOf(run).title).join(' · ')}`}</dd></div>
            <div><dt>Browser</dt><dd>{first.reason === 'no_extensions' ? 'A phone browser with no extensions - not checked' : `${first.browserName || 'Not recognised'} on a ${first.mobile ? 'phone or tablet' : 'computer'}`}</dd></div>
            {first.reason !== 'no_extensions' && <div><dt>Time taken</dt><dd>{runs.map((run) => `${run.ms} ms`).join(' · ')}</dd></div>}
          </dl>
        )}
        <button className="button button-secondary" type="button" disabled={!runs} onClick={check}>Check again</button>
      </section>
      <DeviceCheckCard/>
    </div>
  );
}
