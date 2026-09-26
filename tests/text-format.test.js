import assert from 'node:assert/strict';
import test from 'node:test';
import { blocksOf, continueList, toggleBold, toggleList } from '../client/src/lib/text-format.js';
import { oneLine, plainText, tidyLines } from '../src/domain/rich-text.js';
import { buildTest } from '../src/domain/test-builder.js';

test('Bold wraps the selection, and unwraps it again', () => {
  const on = toggleBold('Name the output', 9, 15);
  assert.equal(on.text, 'Name the **output**');
  assert.equal(on.text.slice(on.start, on.end), 'output');
  const off = toggleBold(on.text, on.start, on.end);
  assert.equal(off.text, 'Name the output');
  const empty = toggleBold('Pick one ', 9, 9);
  assert.equal(empty.text.slice(empty.start, empty.end), 'bold text', 'a placeholder to type over');
});

test('bullet and numbered lists go on the selected lines, and come off again', () => {
  const text = 'Steps:\nCompare\nDiscard\nRepeat';
  const bullets = toggleList(text, 8, text.length, 'bullet');
  assert.equal(bullets.text, 'Steps:\n- Compare\n- Discard\n- Repeat');
  assert.equal(toggleList(bullets.text, 8, bullets.text.length, 'bullet').text, text, 'pressed again: plain lines');
  const numbers = toggleList(bullets.text, 8, bullets.text.length, 'numbered');
  assert.equal(numbers.text, 'Steps:\n1. Compare\n2. Discard\n3. Repeat', 'bullets become numbers');
  const start = toggleList('Intro\n', 6, 6, 'numbered');
  assert.equal(start.text, 'Intro\n1. ', 'an empty line starts a list');
});

test('Enter continues a list, and ends it on an empty item', () => {
  assert.equal(continueList('- one', 5).text, '- one\n- ');
  assert.equal(continueList('1. one', 6).text, '1. one\n2. ');
  assert.equal(continueList('1. one\n2. ', 10).text, '1. one\n', 'an empty item ends the list');
  assert.equal(continueList('plain line', 10), null, 'outside a list: a plain Enter');
  assert.equal(continueList('- one', 2), null, 'not at the end of the line: a plain Enter');
});

test('question text splits into paragraphs, bullet lists and numbered lists', () => {
  const blocks = blocksOf('Look at the steps:\n- Compare\n- Discard\nThen answer.\n3. third\n4. fourth');
  assert.deepEqual(blocks.map((block) => block.kind), ['p', 'ul', 'p', 'ol']);
  assert.deepEqual(blocks[1].items, ['Compare', 'Discard']);
  assert.equal(blocks[3].start, 3, 'a numbered list keeps its first number');
  assert.deepEqual(blocksOf('Line one\nLine two')[0].lines, ['Line one', 'Line two'], 'a new line is a line break');
});

test('the server keeps a question\'s lines, and spreadsheets get plain text', () => {
  assert.equal(tidyLines('  Steps:  \r\n- one\n\n\n\n-   two  '), 'Steps:\n- one\n\n- two');
  assert.equal(plainText('Pick **every** answer:\n- A\n* B'), 'Pick every answer:\n• A\n• B');
  assert.equal(oneLine('Steps:\n- one'), 'Steps: • one');
  const built = buildTest({
    title: 'Formatting', instructions: '', durationMinutes: 10, questionMix: { mcq: 1, msq: 0, short: 0 },
    questions: [{ prompt: 'Which is **fastest**?\n- sorted input\n- n items', type: 'mcq', options: ['A', 'B'], correctOptions: ['0'] }]
  });
  assert.equal(built.questions[0].prompt, 'Which is **fastest**?\n- sorted input\n- n items');
});
