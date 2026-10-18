/** A repeated tap, the deadline, and a lost reply must not send overlapping final requests. */
export function createSubmissionFlight() {
  let flight = null;
  return (attemptId, send) => {
    if (flight?.attemptId === attemptId) return flight.promise;
    const current = { attemptId };
    current.promise = Promise.resolve().then(send).finally(() => {
      if (flight === current) flight = null;
    });
    flight = current;
    return current.promise;
  };
}

/** Retry only transient failures, and never retry a cancelled or superseded submission. */
export async function retrySubmission(send, { shouldRetry, pause, retryWait, onRetry, active = () => true, retries = 6 }) {
  for (let round = 0; active(); round += 1) {
    try { return await send(); }
    catch (error) {
      if (!active()) return null;
      if (!shouldRetry(error) || round >= retries) throw error;
      onRetry?.(error, round);
      await pause(retryWait(round));
    }
  }
  return null;
}
