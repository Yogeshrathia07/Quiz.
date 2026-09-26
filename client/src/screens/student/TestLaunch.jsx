import { useState } from 'react';
import { leavingRules } from './leaving-rules.js';
import { post } from '../../lib/api.js';
import { durationLabel } from '../../lib/format.js';
import { getBrowserLocation } from '../../lib/geo.js';
import { fullscreenSupported, markBegan, requestTestFullscreen } from '../../lib/useAwayMonitor.js';
import { EndLine, TestHeader } from './StatusScreens.jsx';

export function TestLaunch({ test, code, reload, showToast, windowKind }) {
  const [busy, setBusy] = useState(false);
  // Why the venue check failed and what to do, kept on the page (a toast
  // would be gone before the steps could be followed).
  const [locationProblem, setLocationProblem] = useState('');
  const canFullscreen = fullscreenSupported();

  const begin = async () => {
    setBusy(true);
    setLocationProblem('');
    try {
      // Required wherever the browser has it. Asked for first, while the tap
      // still counts: a browser allows fullscreen only for a few seconds after
      // one, and finding the location can take longer than that. If it is
      // refused, the paper asks again - and a slow start is never counted as
      // leaving the test.
      if (fullscreenSupported()) await requestTestFullscreen();
      markBegan();
      // A refused or failed location is not the end: a student the admin has
      // given a location exception may begin without one, and only the server
      // knows that. iPhones refuse far more often (Location Services for
      // Safari is off by default), so this is where an exception matters most.
      let location = null;
      let locationError = null;
      if (test.locationRequired) {
        try { location = await getBrowserLocation(); } catch (error) { locationError = error; }
      }
      try {
        await post(`/api/tests/${encodeURIComponent(code)}/start`, { ...(location || {}), window: windowKind });
      } catch (error) {
        if (error.code === 'LOCATION_NEEDED' && locationError) { setLocationProblem(locationError.message); setBusy(false); return; }
        if (error.code === 'LOCATION_IMPRECISE') { setLocationProblem(error.message); setBusy(false); return; }
        throw error;
      }
      await reload();
    } catch (error) { showToast(error.message); setBusy(false); }
  };

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
      {test.locationRequired && (locationProblem ? (
        <div className="notice danger" role="alert">
          <strong>Your location is needed to begin</strong>
          <p className="help">{locationProblem}</p>
          <p className="help">Then press Begin again.</p>
        </div>
      ) : (
        <div className="notice">
          <strong>Venue check required</strong>
          <p className="help">Allow location access to confirm you are within {test.locationRadiusMeters} m of the test venue. When your phone asks, choose Allow (with Precise location on).</p>
        </div>
      ))}
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
        <button className="button button-success button-wide launch-begin" disabled={busy} onClick={begin}>
          Enter fullscreen &amp; begin
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
          <button className="button button-success button-wide launch-begin" disabled={busy} onClick={begin}>
            Begin test
          </button>
        </>
      )}
    </section>
  );
}
