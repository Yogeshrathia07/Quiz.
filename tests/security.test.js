import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { config } from '../src/config.js';
import { createLimiter, rejectDangerousKeys, sameOriginWrites, securityHeaders } from '../src/lib/security.js';
import { checkZip } from '../src/lib/zip-guard.js';
import { csvCell } from '../src/lib/csv.js';
import { safeEqual } from '../src/lib/crypto.js';
import { plainText } from '../src/domain/test-builder.js';
import { signInEmail } from '../src/auth/microsoft-login.js';

/** A request and response just real enough for a middleware. */
function run(middleware, { method = 'POST', headers = {}, body, secure = false } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const req = { method, body, secure, get: (name) => lower[name.toLowerCase()] };
  const res = {
    statusCode: 200, headers: {}, payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
    set(name, value) { if (typeof name === 'object') Object.assign(this.headers, name); else this.headers[name] = value; return this; }
  };
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { passed, res };
}

test('a change is taken only from the portal itself', () => {
  assert.ok(run(sameOriginWrites, { headers: { 'sec-fetch-site': 'same-origin' } }).passed);
  assert.ok(run(sameOriginWrites, { headers: { 'sec-fetch-site': 'none' } }).passed, 'typed into the address bar');
  assert.equal(run(sameOriginWrites, { headers: { 'sec-fetch-site': 'cross-site' } }).res.statusCode, 403, 'another site');
  assert.equal(run(sameOriginWrites, { headers: { 'sec-fetch-site': 'same-site' } }).res.statusCode, 403, 'a sibling subdomain');
  // An older browser: its Origin must be this host.
  assert.ok(run(sameOriginWrites, { headers: { origin: 'https://quiz.example.edu', host: 'quiz.example.edu' } }).passed);
  assert.equal(run(sameOriginWrites, { headers: { origin: 'https://evil.example', host: 'quiz.example.edu' } }).res.statusCode, 403);
  assert.equal(run(sameOriginWrites, { headers: { origin: 'null', host: 'quiz.example.edu' } }).res.statusCode, 403, 'a sandboxed page');
  // Not a browser at all (a script, a health check): nothing to ride on.
  assert.ok(run(sameOriginWrites, { headers: {} }).passed);
  // Reading is never refused.
  assert.ok(run(sameOriginWrites, { method: 'GET', headers: { 'sec-fetch-site': 'cross-site' } }).passed);
});

test('a body shaped to reach database operators, or the prototype, is refused', () => {
  assert.ok(run(rejectDangerousKeys, { body: { email: 'a@b.c', password: 'x', nested: [{ marks: 2 }] } }).passed);
  assert.equal(run(rejectDangerousKeys, { body: { email: { $ne: null } } }).res.statusCode, 400);
  assert.equal(run(rejectDangerousKeys, { body: { list: [{ deep: { $gt: '' } }] } }).res.statusCode, 400, 'however deep');
  assert.equal(run(rejectDangerousKeys, { body: JSON.parse('{"__proto__": {"isAdmin": true}}') }).res.statusCode, 400);
  assert.equal({}.isAdmin, undefined, 'and nothing was polluted');
  let deep = { leaf: 1 };
  for (let level = 0; level < 40; level += 1) deep = { deep };
  assert.equal(run(rejectDangerousKeys, { body: deep }).res.statusCode, 400, 'absurd nesting');
  assert.ok(run(rejectDangerousKeys, { body: undefined }).passed);
});

test('every response says what the page may load, and nothing may frame it', () => {
  const { res } = run(securityHeaders, { method: 'GET' });
  assert.match(res.headers['Content-Security-Policy'], /script-src 'self'(;|$)/);
  assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(res.headers['Content-Security-Policy'], /object-src 'none'/);
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Strict-Transport-Security'], undefined, 'not over plain http');
  const secure = run(securityHeaders, { method: 'GET', secure: true }).res;
  assert.match(secure.headers['Strict-Transport-Security'], /max-age=\d+/, 'https only, once seen over https');
  assert.match(secure.headers['Content-Security-Policy'], /upgrade-insecure-requests/);
});

test('the limiter counts per key, and lets go after its window', async () => {
  const limiter = createLimiter({ windowMs: 60, max: 3 });
  for (let index = 0; index < 3; index += 1) limiter.hit('net-a');
  assert.ok(limiter.waitFor('net-a') > 0, 'three is the limit');
  assert.equal(limiter.waitFor('net-b'), 0, 'another network is free');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(limiter.waitFor('net-a'), 0, 'and the window passes');
});

test('a zip bomb is refused from its own table of contents; a real workbook passes', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Marks').addRow(['Name', 'Q1']);
  const real = Buffer.from(await workbook.xlsx.writeBuffer());
  assert.ok(checkZip(real).entries > 0);
  // The same file, its first part claiming to unpack to 3 GB.
  const bomb = Buffer.from(real);
  const entry = bomb.indexOf(Buffer.from([0x50, 0x4B, 0x01, 0x02]));
  bomb.writeUInt32LE(3_000_000_000, entry + 24);
  assert.throws(() => checkZip(bomb), /too large unpacked/);
  assert.throws(() => checkZip(Buffer.from('not a zip at all, just text')), /not a zip/);
});

test('a CSV cell that looks like a formula stays text', () => {
  assert.equal(csvCell('=HYPERLINK("http://evil","x")'), `"'=HYPERLINK(""http://evil"",""x"")"`);
  assert.equal(csvCell('+91 98765'), `"'+91 98765"`);
  assert.equal(csvCell('@SUM(A1)'), `"'@SUM(A1)"`);
  assert.equal(csvCell('Asha Rao'), '"Asha Rao"');
  assert.equal(csvCell(-3), '"-3"', 'a number is a number');
  assert.equal(csvCell(null), '""');
});

test('names lose hidden characters, never the joiners Indian scripts need', () => {
  assert.equal(plainText('Asha\u202E oaR\u0007'), 'Asha oaR');
  assert.equal(plainText('\u0915\u094D\u200D\u0937'), '\u0915\u094D\u200D\u0937');
  assert.equal(plainText('  two   spaces\n'), 'two spaces');
});

test('secrets compare in constant time, and only equal ones match', () => {
  assert.ok(safeEqual('abc123', 'abc123'));
  assert.equal(safeEqual('abc123', 'abc124'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, ''), true);
});

test('Microsoft sign-in trusts an account\'s mail only from a trusted directory', () => {
  const saved = { ...config.microsoft, allowedTenants: [...config.microsoft.allowedTenants] };
  const profile = { mail: 'dean@upes.ac.in', userPrincipalName: 'someone@attacker.onmicrosoft.com' };
  try {
    // Any directory may sign in, none listed: the mail is whatever its admins typed.
    Object.assign(config.microsoft, { tenantId: 'organizations', allowedTenants: [] });
    assert.equal(signInEmail(profile, 'stranger-tenant'), 'someone@attacker.onmicrosoft.com');
    // Listed directories: theirs is trusted, any other is not.
    Object.assign(config.microsoft, { allowedTenants: ['upes-tenant'] });
    assert.equal(signInEmail(profile, 'upes-tenant'), 'dean@upes.ac.in');
    assert.equal(signInEmail(profile, 'stranger-tenant'), 'someone@attacker.onmicrosoft.com');
    // Registered in one directory only: that one is trusted.
    Object.assign(config.microsoft, { tenantId: '11111111-2222-3333-4444-555555555555', allowedTenants: [] });
    assert.equal(signInEmail(profile, 'whatever'), 'dean@upes.ac.in');
    assert.equal(signInEmail({ userPrincipalName: 'Student@Stu.UPES.ac.in' }, 'whatever'), 'student@stu.upes.ac.in', 'no mail: the principal name');
  } finally {
    Object.assign(config.microsoft, saved);
  }
});
