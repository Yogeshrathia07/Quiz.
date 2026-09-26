/**
 * Phone browsers that cannot run extensions at all. A private window is
 * required to switch extensions off; where there are none, the private-window
 * check has nothing to protect and could only turn a student away with a
 * wrong guess, so it is skipped.
 *
 * - On an iPhone or iPad only Safari runs extensions: Chrome (CriOS), Firefox
 *   (FxiOS), Edge (EdgiOS) and Opera there have none.
 * - On Android: Chrome, Samsung Internet (content blockers only), Opera and
 *   Brave have none. Firefox, Edge, Yandex, Kiwi and other Chromium browsers
 *   do run them, so they are still checked.
 *
 * `brands` is navigator.userAgentData.brands' names, where the browser has it.
 */
export function phoneWithoutExtensions(userAgent = '', brands = []) {
  if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(userAgent)) return true;
  if (!/Android/i.test(userAgent)) return false;
  if (/Firefox|EdgA|YaBrowser|Kiwi/.test(userAgent)) return false;
  if (/SamsungBrowser|OPR\//.test(userAgent)) return true;
  return brands.some((brand) => ['Google Chrome', 'Opera', 'Brave', 'Samsung Internet'].includes(brand));
}
