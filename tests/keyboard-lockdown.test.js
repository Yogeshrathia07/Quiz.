import assert from 'node:assert/strict';
import test from 'node:test';
import { typingAllowed } from '../client/src/lib/useAwayMonitor.js';

const box = { tagName: 'TEXTAREA', readOnly: false };
const paper = { tagName: 'BUTTON' };
const key = (key, target = box, mods = {}) => ({ key, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

test('during a test, keys work only for typing a short answer', () => {
  for (const k of ['a', 'Z', '7', ' ', '?', 'Backspace', 'Enter', 'ArrowLeft', 'Delete']) assert.equal(typingAllowed(key(k)), true, k);
  for (const k of ['a', ' ', 'Enter', 'ArrowDown', 'Tab', 'F5']) assert.equal(typingAllowed(key(k, paper)), false, 'outside the box: ' + k);
  assert.equal(typingAllowed(key('c', box, { ctrlKey: true })), false, 'Ctrl+C');
  assert.equal(typingAllowed(key('v', box, { metaKey: true })), false, 'Cmd+V');
  assert.equal(typingAllowed(key('Tab', box, { altKey: true })), false, 'Alt+Tab');
  for (const k of ['F1', 'F5', 'F11', 'F12', 'Escape', 'Tab', 'Meta']) assert.equal(typingAllowed(key(k)), false, 'in the box: ' + k);
  assert.equal(typingAllowed(key('a', { tagName: 'TEXTAREA', readOnly: true })), false, 'a final answer');
});

test('a phone keyboard typing into the answer box is never blocked', () => {
  // Gboard and Samsung Keyboard send every key as "Unidentified" (code 229);
  // blocking those made Chrome on Android delete the word being typed.
  assert.equal(typingAllowed(key('Unidentified', box, { keyCode: 229 })), true, 'Android keyboard');
  assert.equal(typingAllowed(key('Process', box)), true, 'desktop IME');
  assert.equal(typingAllowed(key('a', box, { isComposing: true })), true, 'mid-composition');
  // Still only in the answer box, and never as a shortcut.
  assert.equal(typingAllowed(key('Unidentified', paper, { keyCode: 229 })), false, 'outside the box');
  assert.equal(typingAllowed(key('Unidentified', box, { keyCode: 229, ctrlKey: true })), false, 'with Ctrl');
  assert.equal(typingAllowed(key('Unidentified', { tagName: 'TEXTAREA', readOnly: true }, { keyCode: 229 })), false, 'a final answer');
});

test('developer-tools shortcuts are swallowed like any other key, in the answer box too', () => {
  for (const target of [paper, box]) {
    assert.equal(typingAllowed(key('F12', target)), false, 'F12');
    assert.equal(typingAllowed(key('I', target, { ctrlKey: true, shiftKey: true })), false, 'Ctrl+Shift+I');
    assert.equal(typingAllowed(key('u', target, { ctrlKey: true })), false, 'Ctrl+U');
    assert.equal(typingAllowed(key('i', target, { metaKey: true, altKey: true })), false, 'Cmd+Alt+I');
  }
});
