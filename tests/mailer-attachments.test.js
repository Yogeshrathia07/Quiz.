import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';
import { sendMail } from '../src/lib/mailer.js';

test('Brevo receives the PNG attachment only when one was composed; no real mail is sent', async () => {
  const before = { apiKey: config.brevo.apiKey, senderEmail: config.brevo.senderEmail, fetch: globalThis.fetch };
  const calls = [];
  config.brevo.apiKey = 'unit-test-placeholder';
  config.brevo.senderEmail = 'sender@example.test';
  globalThis.fetch = async (_url, request) => { calls.push(JSON.parse(request.body)); return { ok: true }; };
  try {
    const mail = { to: 'student@example.test', subject: 'Test', text: 'Test', html: '<p>Test</p>' };
    await sendMail(mail);
    assert.equal(calls[0].attachment, undefined);
    await sendMail({ ...mail, attachments: [{ name: 'class-analysis-TEST.png', content: 'PNGBASE64' }] });
    assert.deepEqual(calls[1].attachment, [{ name: 'class-analysis-TEST.png', content: 'PNGBASE64' }]);
    assert.equal(calls[1].to[0].email, mail.to);
  } finally {
    config.brevo.apiKey = before.apiKey;
    config.brevo.senderEmail = before.senderEmail;
    globalThis.fetch = before.fetch;
  }
});
