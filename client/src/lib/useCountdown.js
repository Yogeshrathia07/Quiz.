import { useEffect, useRef, useState } from 'react';
import { serverNow } from './server-clock.js';

/**
 * Counts down to `deadlineAt` on the *server's* clock (lib/server-clock.js),
 * so a device whose clock is wrong - or whose last reply was slow to arrive -
 * still sees the same remaining time as the server counts. `serverTime`, the
 * time stamped on the same response as the deadline, stands in until a reply
 * has given the clock a reading.
 */
export function useCountdown(deadlineAt, serverTime) {
  const fallback = useRef(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (serverTime) fallback.current = Date.parse(serverTime) - Date.now();
  }, [serverTime]);

  useEffect(() => {
    const timer = window.setInterval(() => tick((value) => value + 1), 250);
    return () => window.clearInterval(timer);
  }, []);

  // One more tick exactly at zero, so running out is seen at once rather
  // than on the next quarter second.
  useEffect(() => {
    const at = Date.parse(deadlineAt);
    if (!Number.isFinite(at)) return undefined;
    const msLeft = at - serverNow(fallback.current);
    if (msLeft <= 0 || msLeft > 2 ** 31 - 1) return undefined;
    const timer = window.setTimeout(() => tick((value) => value + 1), msLeft + 5);
    return () => window.clearTimeout(timer);
  }, [deadlineAt, serverTime]);

  const deadline = Date.parse(deadlineAt);
  if (!Number.isFinite(deadline)) return { secondsLeft: 0, isOver: false, known: false };
  const secondsLeft = (deadline - serverNow(fallback.current)) / 1000;
  return { secondsLeft, isOver: secondsLeft <= 0, known: true };
}
