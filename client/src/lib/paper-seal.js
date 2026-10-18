/**
 * Opening a sealed question (src/domain/paper-seal.js): the next questions of a
 * timed one-way paper travel ahead encrypted (AES-256-GCM), and the server gives
 * each one's key only in the last moments of the question before it. Opening
 * one is local and instant - no trip to the server at the moment of the change.
 *
 * Web Crypto needs a secure page (https, or localhost). Where it is missing,
 * nothing is opened ahead and the paper moves on as it always did.
 */

const fromBase64 = (text) => Uint8Array.from(atob(text), (character) => character.charCodeAt(0));

export const canOpenSealed = () => typeof globalThis.crypto?.subtle?.decrypt === 'function';

/** The question inside `sealed` ({ iv, data }), opened with `key` (base64): its view, as the paper shows it. */
export async function openSealed(sealed, key) {
  const cryptoKey = await globalThis.crypto.subtle.importKey('raw', fromBase64(key), 'AES-GCM', false, ['decrypt']);
  const plain = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) }, cryptoKey, fromBase64(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
