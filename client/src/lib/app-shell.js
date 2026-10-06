/**
 * Reloads onto the newest version of the portal. The service worker opens
 * portal pages from its saved copy of the page (public/sw.js), so first it is
 * asked to fetch the page fresh - then the reload opens that one. Without a
 * service worker (or if it does not answer within a few seconds) it simply
 * reloads.
 */
export async function reloadFresh() {
  const worker = navigator.serviceWorker?.controller;
  if (worker) {
    await new Promise((resolve) => {
      const done = () => {
        window.clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('message', onMessage);
        resolve();
      };
      const onMessage = (event) => { if (event.data === 'shell-refreshed') done(); };
      const timer = window.setTimeout(done, 3_000);
      navigator.serviceWorker.addEventListener('message', onMessage);
      worker.postMessage('refresh-shell');
    });
  }
  window.location.reload();
}
