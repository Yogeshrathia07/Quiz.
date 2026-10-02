import { useRef, useState } from 'react';
import { leavingRules } from './leaving-rules.js';
import { post } from '../../lib/api.js';
import { durationLabel } from '../../lib/format.js';
import { LocationHelp, LocationPanel, useLocationCheck } from '../../components/LocationCheck.jsx';
import { locationPermission } from '../../lib/geo.js';
import { readDeviceSignals } from '../../lib/device.js';
import { fullscreenSupported, markBegan, requestTestFullscreen } from '../../lib/useAwayMonitor.js';
import { EndLine, TestHeader } from './StatusScreens.jsx';

export function TestLaunch({ test, code, reload, onStarted = () => {}, showToast, windowKind, deviceBlock = null, deviceChecking = false, onDeviceRefused }) {
  const [busy, setBusy] = useState(false);
  // The venue check is its own step above Begin (components/LocationCheck).
  // What the server says about the reading - too vague to place them - is kept
  // on the page too: a toast would be gone before the steps could be followed.
  const location = useLocationCheck(Boolean(test.locationRequired));
  const [serverProblem, setServerProblem] = useState('');
  const venueRef = useRef(null);
  const showVenue = () => venueRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const canFullscreen = fullscreenSupported();

  const begin = async () => {
    setBusy(true);
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
        const started = await post(`/api/tests/${encodeURIComponent(code)}/start`, { ...(point || {}), window: windowKind, device: readDeviceSignals() });
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
  };

  // Phones only or laptops only, and this is not one: no Begin here.
  if (deviceBlock) return deviceBlock;

  return (
    <section className="join-card card">
      <TestHeader test={test}/>
      <p className="eyebrow" style={{ color: 'var(--success)' }}>Test started</p>
      <h2>Ready to begin</h2>
      <p>
        {test.questionCount} question{test.questionCount === 1 ? '' : 's'}, about {durationLabel(test.estimatedSeconds)} of work.
        {' '}<EndLine test={test}/>{!test.untimed && ' Begin as soon as you can.'}
      </p>
      <div className="notice">
        <strong>How this paper works</strong>
        <p className="help">
          {test.strictTiming
            ? 'Change your answer as often as you like until you move on — after that it is final.'
            : 'Move between questions in any order and change your answers as often as you like.'}
          {test.untimed
            ? ' Submit when you are done; if your instructor closes the test first, your answers are submitted as they stand.'
            : ' You get a warning 5 minutes and 1 minute before the end. When time runs out, the answers you have given are submitted automatically.'}
        </p>
      </div>
      {test.strictTiming && (
        <div className="notice danger">
          <strong>Strict timing: one question at a time</strong>
          <p className="help">
            Each question has its own timer. When it reaches zero, your answer as it stands is saved and the
            next question opens by itself.
            {test.strictNext ? ' You can move on early with Next.' : ' You cannot move on early: each question stays for its full time.'}
            {' '}<strong>You cannot go back</strong> to an earlier question. You can submit the whole test at any time.
          </p>
        </div>
      )}
      {test.locationRequired && (
        <div ref={venueRef} className="launch-venue">
          <LocationPanel check={location} intro={`Your location confirms you are within ${test.locationRadiusMeters} m of the test venue.`}/>
          {serverProblem && <LocationHelp problem={serverProblem}/>}
        </div>
      )}
      <div className="notice">
        <strong>Stay on this page until you submit</strong>
        <p className="help">
          Every time you leave is recorded and shown to your administrator: pressing Home, switching app or
          tab, pulling up another window, locking your screen, or leaving fullscreen.
          {leavingRules(test)}
          {canFullscreen && ' If you drop out of fullscreen, the paper is hidden until you return to it.'}
        </p>
      </div>

      {canFullscreen ? (
        <button className="button button-success button-wide launch-begin" disabled={busy || deviceChecking} onClick={begin}>
          {deviceChecking ? 'Checking your device…' : <>Enter fullscreen &amp; begin</>}
        </button>
      ) : (
        <>
          <div className="notice">
            <strong>This browser has no fullscreen mode.</strong>
            <p className="help">
              iPhones do not offer it. You can still sit the test, and leaving the page is still recorded —
              so stay on this tab until you submit.
            </p>
          </div>
          <button className="button button-success button-wide launch-begin" disabled={busy || deviceChecking} onClick={begin}>
            {deviceChecking ? 'Checking your device…' : 'Begin test'}
          </button>
        </>
      )}
    </section>
  );
}
