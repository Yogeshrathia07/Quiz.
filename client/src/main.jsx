import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import '@fontsource-variable/manrope';
import App from './App.jsx';

createRoot(document.querySelector('#root')).render(<React.StrictMode><App /></React.StrictMode>);

// Caches the app shell so reloading during a network drop still opens the test.
// Registered after load so it never competes with the first paint.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    // Do not allow a browser's HTTP cache to postpone a new shell (including
    // CSS-only visual releases). The service worker still keeps the app
    // usable offline after it has updated.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => undefined);
  });
}
