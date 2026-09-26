import { useEffect, useRef } from 'react';

// Where an extension's own files are served from.
const EXTENSION_URL = /^(chrome|moz|safari-web|safari|edge|ms-browser)-extension:\/\//i;
// Marks common extensions leave on <html> or <body> (Grammarly, LanguageTool,
// Dark Reader, ColorZilla, password managers).
const MARKER_ATTRIBUTE = /^(data-new-gr-c-s|data-gr-ext|data-grammarly|data-lt-installed|data-darkreader|cz-shortcut-listen|data-dashlane|data-lastpass|data-1p-)/i;
// What the portal itself puts outside its root: the menu layer, the silent
// video that keeps the screen on (keep-awake.js), and what it marks as its own.
const OURS = 'head, body, #root, [data-portal], .menu-floating, video[title="Keeping the screen on"], script, noscript, link, style, template';
// An added subtree is looked through only this far - the paper's own
// re-renders add small ones, and this runs on every change.
const MAX_NODES_LOOKED_AT = 300;

/** What an element says about an extension, as a short note - or null. */
function signOf(element) {
  const tag = element.tagName.toLowerCase();
  // The portal uses no custom elements: one with a dash in its name was put here.
  if (tag.includes('-')) return `<${tag}>`;
  for (const name of ['src', 'href']) {
    const value = element.getAttribute(name);
    if (value && EXTENSION_URL.test(value)) return `${tag} from ${value.split('/').slice(0, 3).join('/')}`;
  }
  const parent = element.parentNode;
  if ((parent === document.body || parent === document.documentElement) && !element.matches(OURS)) {
    return `<${tag}${element.id ? `#${element.id}` : ''}> added to the page`;
  }
  return null;
}

function markerOn(element) {
  const found = [...(element?.attributes || [])].find((attribute) => MARKER_ATTRIBUTE.test(attribute.name));
  return found ? `${found.name} on <${element.tagName.toLowerCase()}>` : null;
}

function signsIn(root, report) {
  if (root.nodeType !== 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let looked = 0;
  for (let node = root; node && looked < MAX_NODES_LOOKED_AT; node = walker.nextNode(), looked += 1) {
    const sign = signOf(node);
    if (sign) report(sign);
  }
}

/**
 * Watches the test page for a browser extension at work: an element it adds
 * (a custom element, anything loaded from an extension, something put straight
 * onto the page outside the portal), or a mark it leaves on the page. That is
 * the risk a private window is required for, seen directly - in any window.
 * It cannot see an extension that only reads the page without changing it.
 * `onFound(note)` gets a short description, once per different sign.
 */
export function useExtensionWatch({ enabled, onFound }) {
  const foundRef = useRef(onFound);
  foundRef.current = onFound;
  useEffect(() => {
    if (!enabled || typeof MutationObserver === 'undefined') return undefined;
    const seen = new Set();
    const report = (note) => {
      if (!note || seen.has(note)) return;
      seen.add(note);
      foundRef.current(note);
    };
    // What was already there when the paper opened: extensions add theirs as the page loads.
    signsIn(document.documentElement, report);
    report(markerOn(document.documentElement));
    report(markerOn(document.body));
    // Two observers: one element's options replace each other on a single one.
    const added = new MutationObserver((changes) => {
      for (const change of changes) for (const node of change.addedNodes) signsIn(node, report);
    });
    const marked = new MutationObserver((changes) => {
      for (const change of changes) report(markerOn(change.target));
    });
    added.observe(document.documentElement, { childList: true, subtree: true });
    marked.observe(document.documentElement, { attributes: true });
    if (document.body) marked.observe(document.body, { attributes: true });
    return () => { added.disconnect(); marked.disconnect(); };
  }, [enabled]);
}
