import crypto from 'node:crypto';
import { config } from '../config.js';
import { portalOauthStates } from '../db/index.js';
import { hash, randomId } from '../lib/crypto.js';
import { now } from '../lib/time.js';
import { microsoftConfigured, normalizeEmail, roleForEmail } from './portal-auth.js';
import { refuseIfBlocked, signInAccount } from './account-login.js';
import { plainText } from '../domain/test-builder.js';

/**
 * Microsoft sign-in for any UPES account - students and faculty alike. It
 * signs in to the same account as email + password (the email decides the
 * role), and a block applies to it just the same. Only UPES email addresses
 * get in, and when AZURE_ALLOWED_TENANTS is set, only accounts from those
 * Microsoft directories.
 */
const baseUrl = (req) => config.publicBaseUrl || `${req.protocol}://${req.get('host')}`;
const callbackUrl = (req) => `${baseUrl(req)}/auth/microsoft/callback`;
const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(config.microsoft.tenantId)}/oauth2/v2.0`;
const safeReturnTo = (value) => (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/');
const codeChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');

function tenantClaims(idToken) {
  try { return JSON.parse(Buffer.from(String(idToken || '').split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

const ANY_DIRECTORY = new Set(['organizations', 'common', 'consumers']);

/**
 * Which address a Microsoft account signs in as. Any directory's own
 * administrators can type whatever they like into a user's `mail` - a
 * stranger's directory could claim a UPES address - but a user principal
 * name is always on a domain that directory has proved it owns. So `mail`
 * counts only from a directory this portal trusts (one on
 * AZURE_ALLOWED_TENANTS, or the single directory it is registered in);
 * otherwise the principal name decides.
 */
export function signInEmail(profile, tenant) {
  const principal = normalizeEmail(profile?.userPrincipalName);
  const mail = normalizeEmail(profile?.mail);
  const allowed = config.microsoft.allowedTenants;
  const trusted = allowed.length
    ? allowed.includes(String(tenant || '').toLowerCase())
    : !ANY_DIRECTORY.has(String(config.microsoft.tenantId || '').toLowerCase());
  return trusted && mail ? mail : principal;
}

export async function beginMicrosoftLogin(req, res) {
  if (!microsoftConfigured()) return res.redirect(`${baseUrl(req)}/?auth=microsoft-off`);
  const state = randomId();
  const verifier = randomId(48);
  await portalOauthStates().insertOne({
    _id: hash(state), codeVerifier: verifier, returnTo: safeReturnTo(req.query.returnTo), expiresAt: new Date(Date.now() + 10 * 60_000)
  });
  const url = new URL(`${authority()}/authorize`);
  url.search = new URLSearchParams({
    client_id: config.microsoft.clientId,
    response_type: 'code',
    redirect_uri: callbackUrl(req),
    response_mode: 'query',
    scope: 'openid profile email User.Read',
    state,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'select_account'
  }).toString();
  res.redirect(url.toString());
}

export async function finishMicrosoftLogin(req, res) {
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const pending = state && await portalOauthStates().findOneAndDelete({ _id: hash(state), expiresAt: { $gt: now() } });
  if (!pending || !code) return res.redirect(`${baseUrl(req)}/?auth=invalid`);

  try {
    const tokenResponse = await fetch(`${authority()}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.microsoft.clientId,
        client_secret: config.microsoft.clientSecret,
        code,
        redirect_uri: callbackUrl(req),
        grant_type: 'authorization_code',
        code_verifier: pending.codeVerifier
      })
    });
    const tokens = await tokenResponse.json();
    if (!tokenResponse.ok || !tokens.access_token) throw new Error(`token exchange failed: ${tokens.error_description || tokens.error || tokenResponse.status}`);

    const profileResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok) throw new Error('profile lookup failed');

    // The token came straight from Microsoft over TLS, so its claims can be
    // read without re-checking the signature.
    const claims = tenantClaims(tokens.id_token);
    const allowed = config.microsoft.allowedTenants;
    const tenant = String(claims.tid || '').toLowerCase();
    if (allowed.length && !allowed.includes(tenant)) {
      return res.redirect(`${baseUrl(req)}/?auth=not-allowed`);
    }
    const email = signInEmail(profile, tenant);
    if (!roleForEmail(email)) return res.redirect(`${baseUrl(req)}/?auth=not-allowed`);
    try { await refuseIfBlocked(email); } catch { return res.redirect(`${baseUrl(req)}/?auth=blocked`); }

    const name = plainText(profile.displayName || email).slice(0, 120) || email;
    await signInAccount(res, { email, name, role: roleForEmail(email) });
    res.redirect(`${baseUrl(req)}${pending.returnTo}`);
  } catch (error) {
    console.error('Microsoft sign-in failed:', error.message);
    res.redirect(`${baseUrl(req)}/?auth=failed`);
  }
}
