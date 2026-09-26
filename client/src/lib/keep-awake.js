import { useEffect } from 'react';
import media from 'nosleep.js/src/media.js';

/**
 * iPhones and iPads before 18.4 accept a wake lock in Safari (and every iOS
 * browser, which all run on Safari's engine) but do not honour it outside an
 * app added to the home screen: the screen still dims and locks.
 */
function wakeLockUnreliable() {
  const agent = navigator.userAgent;
  const apple = /iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1);
  if (!apple || navigator.standalone) return false;
  const version = agent.match(/OS (\d+)_(\d+)/) || agent.match(/Version\/(\d+)\.(\d+)/);
  if (!version) return true;
  const [major, minor] = [Number(version[1]), Number(version[2])];
  return major < 18 || (major === 18 && minor < 4);
}

/**
 * A tiny silent video playing in a loop keeps a phone's screen on where there
 * is no working wake lock (the NoSleep.js technique; its video, MIT). It sits
 * off screen, and a tap starts it - browsers only play video after one.
 */
function silentVideo() {
  const video = document.createElement('video');
  video.setAttribute('title', 'Keeping the screen on');
  video.setAttribute('playsinline', '');
  video.setAttribute('muted', '');
  video.setAttribute('aria-hidden', 'true');
  video.muted = true;
  for (const [type, src] of [['webm', media.webm], ['mp4', media.mp4]]) {
    const source = document.createElement('source');
    source.src = src;
    source.type = `video/${type}`;
    video.append(source);
  }
  Object.assign(video.style, { position: 'fixed', left: '-100px', top: '-100px', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  video.addEventListener('loadedmetadata', () => {
    if (video.duration <= 1) video.loop = true;
    else video.addEventListener('timeupdate', () => { if (video.currentTime > 0.5) video.currentTime = Math.random(); });
  });
  document.body.append(video);
  return video;
}

/**
 * Keeps the screen on - and so the phone or laptop awake - while `enabled`:
 * from the waiting room until the paper is handed in. A screen that dims and
 * locks by itself mid-question would otherwise count as leaving the test.
 *
 * The browser's Screen Wake Lock does it wherever it works (Chrome, Edge,
 * Samsung Internet, Firefox, Safari 18.4 on). It needs a secure (https) page,
 * and it is dropped whenever the page is hidden - and sometimes by the system,
 * in battery saver - so it is taken again as soon as the page is back, a
 * moment after it is dropped, and on the next touch. Elsewhere the silent
 * video does it.
 */
export function useKeepAwake(enabled) {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined') return undefined;
    let stopped = false;
    let lock = null;
    let video = null;
    const useVideo = !navigator.wakeLock?.request || wakeLockUnreliable();

    const takeLock = () => {
      if (stopped || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      navigator.wakeLock.request('screen').then((granted) => {
        if (stopped) { granted.release().catch(() => {}); return; }
        lock = granted;
        granted.addEventListener('release', () => {
          if (lock === granted) lock = null;
          window.setTimeout(takeLock, 1_000);
        });
      }, () => { /* refused for now: tried again on the next touch or return */ });
    };
    const playVideo = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      video = video || silentVideo();
      if (video.paused) video.play().catch(() => { /* needs a tap first: the next one starts it */ });
    };
    const keep = () => (useVideo ? playVideo() : takeLock());

    keep();
    document.addEventListener('visibilitychange', keep);
    document.addEventListener('fullscreenchange', keep);
    // A touch or a key is what the video needs to start, and a good moment to
    // take back a lock the system dropped.
    document.addEventListener('pointerdown', keep, true);
    document.addEventListener('keydown', keep, true);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', keep);
      document.removeEventListener('fullscreenchange', keep);
      document.removeEventListener('pointerdown', keep, true);
      document.removeEventListener('keydown', keep, true);
      lock?.release().catch(() => {});
      if (video) { video.pause(); video.remove(); }
    };
  }, [enabled]);
}
