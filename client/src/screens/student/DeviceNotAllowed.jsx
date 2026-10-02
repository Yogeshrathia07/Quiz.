import { Laptop, Smartphone } from 'lucide-react';
import { copyText } from '../../lib/format.js';
import { DEVICE_WORDS, RULE_WANTS } from '../../lib/device.js';

/**
 * Shown when a test is for phones only or laptops only and this device is
 * not one. Before registering there is a way on regardless - the check can
 * be wrong, and only a registered student can be given an exception - but
 * Begin still needs that exception. Once registered, the page opens by itself
 * the moment the teacher allows this device.
 *
 *   stage: 'join' (not registered yet), 'waiting' (registered), 'launch' (Begin), 'paper' (mid-test)
 */
export function DeviceNotAllowed({ test, rule, check, stage = 'join', guest = false, showToast, onRegisterAnyway }) {
  const wanted = RULE_WANTS[rule] || RULE_WANTS.laptop;
  const Icon = rule === 'phone' ? Smartphone : Laptop;
  const link = window.location.href;
  const seen = check?.device;
  const copy = async () => {
    try { await copyText(link); showToast?.('Link copied.'); } catch (error) { showToast?.(error.message); }
  };
  const registered = stage !== 'join';
  return (
    <section className={`join-card card device-card${stage === 'waiting' ? ' is-compact' : ''}`}>
      <p className="eyebrow device-card-eyebrow"><Icon size={15} aria-hidden="true"/>{rule === 'phone' ? 'Phones only' : 'Laptops only'}</p>
      <h1>Open this test on {wanted}</h1>
      <p>
        {test.title} can only be taken on {wanted}. This looks like a {DEVICE_WORDS[seen?.kind] || DEVICE_WORDS.unknown}
        {seen?.label ? ` (${seen.label})` : ''}.
        {stage === 'paper' && ' Your answers are saved: carry on on the device you began on.'}
        {stage === 'launch' && ' You cannot begin on this one.'}
      </p>
      {stage !== 'waiting' && (
        <ol className="private-steps">
          <li>Open this test link on {wanted}.</li>
          <li>{guest
            ? 'Sign out here first (that frees your seat), then join as a guest there.'
            : `Sign in there with the same account${registered ? ', and choose Continue here' : ''}.`}</li>
        </ol>
      )}
      <div className="link-box">
        <input className="text-input" readOnly value={link} aria-label="Test link" onFocus={(event) => event.target.select()}/>
        <button className="button button-primary" type="button" onClick={copy}>Copy link</button>
      </div>
      {registered ? (
        <p className="help">Is this wrong? Ask your teacher to allow this device - this page opens by itself when they do.</p>
      ) : (
        <p className="help">
          Is this wrong?{' '}
          <button className="link-button" type="button" onClick={onRegisterAnyway}>Register on this device anyway</button>
          {' '}- you still need your teacher to allow it before you can begin.
        </p>
      )}
      {seen?.facts && <p className="help device-card-facts">What this device reports: {seen.facts}.</p>}
    </section>
  );
}
