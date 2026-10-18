import { useEffect, useState } from 'react';
import { BRAND } from '../brand.js';
import { TicTacToe } from './TicTacToe.jsx';

/** The picture is kept by the service worker (sw.js) when it installs, so it shows while the server is away. */
export const OFFLINE_PICTURE = '/server-offline.webp';

/**
 * What a page shows when the server cannot be reached as it opens (App.jsx):
 * the server is off, or what stands in front of it (the tunnel) answered for
 * it - or this device has no connection at all. It asks again by itself, and
 * the page opens the moment the server answers - unless a game of tic-tac-toe
 * is under way: then it says the server is back and waits for Open the page.
 * A test link never comes here: the paper held on the device opens instead.
 */
export function ServerOffline({ deviceOffline = false, back = false, onOpen, onPlaying }) {
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    const before = document.title;
    document.title = `${back ? 'Server is back' : deviceOffline ? 'No connection' : 'Server offline'} · ${BRAND.name}`;
    return () => { document.title = before; };
  }, [deviceOffline, back]);
  useEffect(() => { onPlaying?.(playing); }, [playing, onPlaying]);
  return (
    <section className="server-offline" aria-labelledby="server-offline-title">
      <div className="server-offline-message">
        <span className="server-offline-disc" aria-hidden="true"><img className="server-offline-picture" src={OFFLINE_PICTURE} alt="" width="220" height="220"/></span>
        <h1 id="server-offline-title">{deviceOffline ? 'No connection' : 'Server offline'}</h1>
        <p>{deviceOffline ? 'Check your internet connection.' : 'Studied too hard. Taking a quick nap.'}</p>
        {back ? (
          <p className="server-offline-back" role="status">
            The server is back.
            <button type="button" className="button button-primary button-small" onClick={onOpen}>Open the page</button>
          </p>
        ) : (
          <p className="server-offline-note" role="status">
            This page opens by itself when it is back.
          </p>
        )}
      </div>
      <TicTacToe onPlaying={setPlaying}/>
    </section>
  );
}
