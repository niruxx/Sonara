// OpenID Connect single sign-on (Authentik, Authelia, Keycloak, Google, …).
// Authorization-code flow with PKCE. The identity comes from the provider's
// userinfo endpoint, fetched over TLS with the access token, so no JWT library is needed.

import crypto from 'node:crypto';
import { getConfig } from './config.js';
import { externalUser } from './auth.js';
import { log } from './logger.js';

let discovery = null; // { issuer, doc, at }
const pending = new Map(); // state -> { verifier, nonce, redirectUri, at }

export const oidcEnabled = () => {
  const c = getConfig();
  return !!(c.oidcIssuer && c.oidcClientId);
};

async function discover() {
  const issuer = getConfig().oidcIssuer.replace(/\/+$/, '');
  if (discovery?.issuer === issuer && Date.now() - discovery.at < 3600000) return discovery.doc;
  const r = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw Object.assign(new Error(`The sign-in provider did not answer (${r.status})`), { status: 502 });
  const doc = await r.json();
  if (!doc.authorization_endpoint || !doc.token_endpoint) throw Object.assign(new Error('The sign-in provider is missing endpoints'), { status: 502 });
  discovery = { issuer, doc, at: Date.now() };
  return doc;
}

export function baseUrl(req) {
  const pub = getConfig().publicUrl;
  return pub ? pub.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`;
}

const b64url = (buf) => buf.toString('base64url');

export async function startUrl(req) {
  const c = getConfig();
  const doc = await discover();
  const state = b64url(crypto.randomBytes(18));
  const verifier = b64url(crypto.randomBytes(32));
  const nonce = b64url(crypto.randomBytes(16));
  const redirectUri = `${baseUrl(req)}/api/auth/oidc/callback`;
  pending.set(state, { verifier, nonce, redirectUri, at: Date.now() });
  const u = new URL(doc.authorization_endpoint);
  u.search = new URLSearchParams({
    response_type: 'code', client_id: c.oidcClientId, redirect_uri: redirectUri, scope: 'openid profile email groups',
    state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
  }).toString();
  return u.toString();
}

/** Finish sign-in: returns the Sonara user row. */
export async function finish(query) {
  const c = getConfig();
  if (query.error) throw Object.assign(new Error(String(query.error_description || query.error)), { status: 400 });
  const p = pending.get(String(query.state || ''));
  pending.delete(String(query.state || ''));
  if (!p || Date.now() - p.at > 10 * 60000) throw Object.assign(new Error('The sign-in link expired. Try again.'), { status: 400 });
  const doc = await discover();
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code: String(query.code || ''), redirect_uri: p.redirectUri,
    client_id: c.oidcClientId, code_verifier: p.verifier,
  });
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (c.oidcClientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(c.oidcClientId)}:${encodeURIComponent(c.oidcClientSecret)}`).toString('base64')}`;
  }
  const tr = await fetch(doc.token_endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.access_token) {
    log.warn('[oidc] Token exchange failed:', tr.status, tok.error || '');
    throw Object.assign(new Error('The sign-in provider rejected the login'), { status: 401 });
  }
  let claims = {};
  if (doc.userinfo_endpoint) {
    const ur = await fetch(doc.userinfo_endpoint, { headers: { Authorization: `Bearer ${tok.access_token}` }, signal: AbortSignal.timeout(10000) });
    if (ur.ok) claims = await ur.json();
  }
  // Fall back to the id_token's claims (received directly from the token endpoint over TLS).
  if (!claims.sub && tok.id_token) {
    try { claims = JSON.parse(Buffer.from(tok.id_token.split('.')[1], 'base64url').toString('utf8')); } catch { /* ignore */ }
    if (claims.nonce && claims.nonce !== p.nonce) throw Object.assign(new Error('Sign-in check failed'), { status: 401 });
  }
  if (!claims.sub) throw Object.assign(new Error('The sign-in provider did not say who you are'), { status: 401 });
  const username = claims[c.oidcUsernameClaim || 'preferred_username'] || claims.preferred_username || claims.nickname || claims.email?.split('@')[0] || claims.sub;
  const groups = [].concat(claims.groups || claims.roles || []);
  const isAdmin = c.oidcAdminGroup ? groups.includes(c.oidcAdminGroup) : null;
  const user = externalUser({ source: 'oidc', externalId: claims.sub, username: String(username), isAdmin, autoCreate: !!c.oidcAutoCreate });
  if (!user) throw Object.assign(new Error(`There is no Sonara account for ${username}. Ask an admin to create one.`), { status: 403 });
  return user;
}

setInterval(() => {
  const cutoff = Date.now() - 10 * 60000;
  for (const [k, v] of pending) if (v.at < cutoff) pending.delete(k);
}, 60000).unref();
