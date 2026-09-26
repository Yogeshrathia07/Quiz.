import { copyText } from '../../lib/format.js';

/**
 * Shown instead of the test when it must be taken in a private window and
 * this is not one. Extensions are off in Incognito, so helper extensions that
 * read or capture the paper cannot run.
 */
export function PrivateWindowRequired({ test, showToast, onDeclare, midTest = false }) {
  const link = window.location.href;
  const phone = /android|iphone|ipad/i.test(navigator.userAgent);
  const copy = async () => {
    try { await copyText(link); showToast('Link copied. Paste it into the Incognito window.'); } catch (error) { showToast(error.message); }
  };
  return (
    <section className="join-card card private-card">
      <p className="eyebrow" style={{ color: 'var(--brand-dark)' }}>{test.code}</p>
      <h1>Open this test in an Incognito window</h1>
      <p>
        {test.title} must be taken in a private window, where browser extensions are switched off.
        {midTest && ' Your administrator has just turned this on. Your answers are saved: open the link there and carry on where you left off.'}
      </p>
      <ol className="private-steps">
        {phone ? (
          <>
            <li><strong>Chrome / Edge:</strong> tap <b>⋮</b> (Edge: <b>☰</b>) → <b>New Incognito tab</b> / <b>New InPrivate tab</b>.</li>
            <li><strong>Samsung Internet:</strong> tap the tabs button → <b>Turn on Secret mode</b>.</li>
            <li><strong>Safari:</strong> tap the tabs button → <b>Private</b>.</li>
          </>
        ) : (
          <>
            <li><strong>Chrome / Edge / Brave:</strong> press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd> (Mac: <kbd>⌘</kbd> + <kbd>Shift</kbd> + <kbd>N</kbd>).</li>
            <li><strong>Firefox:</strong> press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>. <strong>Safari:</strong> File → New Private Window.</li>
          </>
        )}
        <li>Paste this test link there and sign in.</li>
      </ol>
      <div className="link-box">
        <input className="text-input" readOnly value={link} onFocus={(event) => event.target.select()}/>
        <button className="button button-primary" type="button" onClick={copy}>Copy link</button>
      </div>
      <p className="help">Turn off “Allow in Incognito” for your extensions. Your administrator can see which window you used.</p>
      <p className="help private-declare">
        Already in an Incognito window? Some computers hide it from this check.{' '}
        <button className="link-button" type="button" onClick={onDeclare}>Continue in this window</button>
        {' '}— your administrator will see that it could not be verified.
      </p>
    </section>
  );
}
