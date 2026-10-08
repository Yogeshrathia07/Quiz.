import { useRef, useState } from 'react';
import { leavingRules } from './leaving-rules.js';
import { isRetryable, post } from '../../lib/api.js';
import { durationLabel } from '../../lib/format.js';
import { LocationHelp, LocationPanel } from '../../components/LocationCheck.jsx';
import { locationPermission } from '../../lib/geo.js';
import { readDeviceSignals } from '../../lib/device.js';
import { fullscreenSupported, markBegan, requestTestFullscreen } from '../../lib/useAwayMonitor.js';
import { EndLine, TestHeader } from './StatusScreens.jsx';
import { InfoTip } from '../../components/InfoTip.jsx';

/** Begin waits this long for an answer before asking again: a stuck request is not left to hang. */
const START_TIMEOUT_MS = 8_000;
const START_TRIES = 5;
const wait = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

/** The venue step's own words, while waiting for Start and above Begin. */
export const venueIntro = (test) => `Your location confirms you are within ${test.locationRadiusMeters} m of the test venue.`;

/**
 * `location`: the venue check (components/LocationCheck), begun while the
 * student waited for Start (StudentScreen), so a reading found then is used
 * here with nothing asked again.
 */
export function TestLaunch({ test, code, reload, location, onStarted = () => {}, showToast, windowKind, deviceBlock = null, deviceChecking = false, onDeviceRefused }) {
  const [busy, setBusy] = useState(false);
  // Begin had to be asked again: the connection is slow, and the button says so.
  const [slow, setSlow] = useState(false);
  // The venue check is its own step above Begin (components/LocationCheck).
  // What the server says about the reading - too vague to place them - is kept
  // on the page too: a toast would be gone before the steps could be followed.
  const [serverProblem, setServerProblem] = useState('');
  const venueRef = useRef(null);
  const showVenue = () => venueRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const canFullscreen = fullscreenSupported();

  /**
   * Begin, asked again whenever it is stuck or the connection drops. Safe to
   * repeat: a second Begin gets the paper the first one made, never a second
   * paper, and the paper's clock waits until it is on this screen anyway.
   */
  const start = async (body) => {
    for (let round = 0; ; round += 1) {
      try {
        return await post(`/api/tests/${encodeURIComponent(code)}/start`, body, { timeoutMs: START_TIMEOUT_MS });
      } catch (error) {
        if (!isRetryable(error) || round >= START_TRIES - 1) throw error;
        setSlow(true);
        await wait(Math.min(4_000, 600 * 2 ** round));
      }
    }
  };

  const begin = async () => {
    setBusy(true);
    setSlow(false);
    setServerProblem('');
    try {
      // Found a moment ago with "Allow location": used as it is, nothing asked twice.
      let point = test.locationRequired ? location.fresh() : null;
      let locationError = null;
      // Not allowed yet: the phone's "use your location?" question comes first,
      // on the page as it is. Asked while the page was switching to fullscreen,
      // on some phones the question was hidden or dismissed by the switch - the
      // student never saw it, and the location was simply refused.
      if (test.locationRequired && !point && await locationPermission() !== 'granted') {
        try { point = await location.request(); } catch (error) { locationError = error; }
      }
      // Fullscreen is asked for while the tap still counts (a browser allows it
      // only for a few seconds after one); if that has passed, or it is
      // refused, the paper asks again - and a slow start is never counted as
      // leaving the test. Not when the location failed: the page stays as it
      // is, to show how to fix it - unless the server lets them in anyway.
      if (fullscreenSupported() && !locationError) await requestTestFullscreen();
      markBegan();
      // A refused or failed location is not the end: a student the admin has
      // given a location exception may begin without one, and only the server
      // knows that. iPhones refuse far more often (Location Services for
      // Safari is off by default), so this is where an exception matters most.
      if (test.locationRequired && !point && !locationError) {
        try { point = await location.request(); } catch (error) { locationError = error; }
      }
      try {
        // What this device is, for tests that allow only phones or only laptops:
        // the server decides here, whatever this page showed (domain/device.js).
        // No location: why not, as this page found it - the teacher's row shows it beside the exception that lets them in.
        const problem = test.locationRequired && !point ? (locationError || location.problem) : null;
        const started = await start({
          ...(point || {}), window: windowKind, device: readDeviceSignals(),
          ...(problem ? { locationProblem: { reason: problem.reason || 'unknown', asked: problem.asked ?? null } } : {})
        });
        // Start already returns the full authorised paper. Reusing it avoids a
        // second request per student right when the class presses Begin.
        if (started?.attempt) {
          onStarted(started.attempt);
          return;
        }
      } catch (error) {
        // The venue step above now says what went wrong and how to fix it.
        if (error.code === 'LOCATION_NEEDED' && locationError) { setBusy(false); showVenue(); return; }
        if (error.code === 'LOCATION_IMPRECISE') { setServerProblem(error.message); setBusy(false); showVenue(); return; }
        // Not this device: out of fullscreen, and the page says why (asked again).
        if (error.code === 'DEVICE_NOT_ALLOWED') {
          if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
          showToast(error.message);
          setBusy(false);
          onDeviceRefused?.();
          return;
        }
        throw error;
      }
      await reload();
    } catch (error) { showToast(error.message); setBusy(false); }
    finally { setSlow(false); }
  };

  // Phones only or laptops only, and this is not one: no Begin here.
  if (deviceBlock) return deviceBlock;

  // What a student needs before Begin, one line each; the detail of each sits behind its (i).
  const how = [
    test.strictTiming
      ? 'Change your answer as often as you like until you move on — after that it is final.'
      : 'Move between questions in any order and change your answers as often as you like.',
    test.untimed
      ? 'Submit when you are done; if your instructor closes the test first, your answers are submitted as they stand.'
      : test.endMode === 'each'
        ? 'Your clock starts when your paper appears on your screen. You get a warning 5 minutes and 1 minute before your time is up; then the answers you have given are submitted automatically.'
        : 'You get a warning 5 minutes and 1 minute before the end. When time runs out, the answers you have given are submitted automatically.'
  ].join(' ');
  const strictDetail = test.strictTimed === false
    ? 'Move on with Next when you are ready. You cannot go back to an earlier question. You can submit the whole test at any time.'
    : `Each question has its own timer. When it reaches zero, your answer as it stands is saved and the next question opens by itself.${test.strictNext ? ' You can move on early with Next.' : ' A timed question stays for its full time.'} You cannot go back. You can submit the whole test at any time.`;

  return (
    <section className="join-card card launch-card">
      <TestHeader test={test}/>
      <p className="eyebrow" style={{ color: 'var(--success)' }}>Test started</p>
      <div className="launch-title">
        <h2>Ready to begin</h2>
        <InfoTip label="How this paper works">{how}</InfoTip>
      </div>
      <ul className="launch-facts">
        <li>{test.questionCount} question{test.questionCount === 1 ? '' : 's'} · about {durationLabel(test.estimatedSeconds)}</li>
        <li><EndLine test={test} brief/></li>
        {test.strictTiming && (
          <li className="is-danger">
            <span>One question at a time — no going back</span>
            <InfoTip label="About one question at a time">{strictDetail}</InfoTip>
          </li>
        )}
        <li>
          <span>Stay on this page until you submit</span>
          <InfoTip label="What counts as leaving">
            Every time you leave is recorded and shown to your administrator: pressing Home, switching app or tab, pulling up
            another window, locking your screen{canFullscreen ? ', or leaving fullscreen' : ''}.{leavingRules(test)}
            {canFullscreen && ' If you drop out of fullscreen, the paper is hidden until you return to it.'}
            {' '}If your internet drops, keep going: your answers are kept on this device and sent when it is back. That is not counted as leaving.
          </InfoTip>
        </li>
        {!canFullscreen && (
          <li>
            <span>This browser has no fullscreen mode</span>
            <InfoTip label="About fullscreen">iPhones do not offer it. You can still sit the test, and leaving the page is still recorded — so stay on this tab until you submit.</InfoTip>
          </li>
        )}
      </ul>
      {test.locationRequired && (
        <div ref={venueRef} className="launch-venue">
          <LocationPanel check={location} intro={venueIntro(test)}/>
          {serverProblem && <LocationHelp problem={serverProblem}/>}
        </div>
      )}

      <button className="button button-success button-wide launch-begin" disabled={busy || deviceChecking} onClick={begin}>
        {deviceChecking ? 'Checking your device…' : slow ? 'Slow connection, still trying…' : canFullscreen ? <>Enter fullscreen &amp; begin</> : 'Begin test'}
      </button>
    </section>
  );
}
