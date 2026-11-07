// Users, password hashing (scrypt) and cookie sessions.

import crypto from 'node:crypto';
import { q, libraryScope } from './db.js';
import { getConfig } from './config.js';
import { log } from './logger.js';

export const COOKIE = 'sonara_session';
const DAY = 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

export function validateCredentials(username, password) {
  if (typeof username !== 'string' || !/^[\w.\-@]{2,32}$/.test(username)) {
    return 'Username must be 2–32 characters (letters, numbers, . _ - @).';
  }
  if (typeof password !== 'string' || password.length < 6) return 'Password must be at least 6 characters.';
  if (password.length > 256) return 'Password is too long.';
  return null;
}

export function userCount() {
  return q('SELECT COUNT(*) AS n FROM users').get().n;
}

// ───────── Permissions and library access ─────────

export const PERMISSIONS = {
  download: { label: 'Download music', default: true },
  share: { label: 'Create public share links', default: true },
  playlists: { label: 'Create and edit playlists', default: true },
  jukebox: { label: 'Control the server speakers and network speakers', default: false },
};

export function permissionsOf(u) {
  let p = {};
  try { p = JSON.parse(u?.permissions || '{}'); } catch { /* defaults */ }
  const out = {};
  for (const [k, def] of Object.entries(PERMISSIONS)) out[k] = u?.is_admin ? true : typeof p[k] === 'boolean' ? p[k] : def.default;
  return out;
}

export const can = (u, perm) => !!u && permissionsOf(u)[perm];

export function requirePermission(perm) {
  return (req, res, next) => {
    if (!can(req.user, perm)) return res.status(403).json({ error: `You don't have permission to ${PERMISSIONS[perm].label.toLowerCase()}` });
    next();
  };
}

/** Folders a user is limited to, or null for the whole library (admins always see everything). */
export function libraryDirsOf(u) {
  if (!u || u.is_admin || !u.library_dirs) return null;
  try {
    const d = JSON.parse(u.library_dirs);
    return Array.isArray(d) ? d.map(String) : null;
  } catch { return null; }
}

export function publicUser(u) {
  return u && {
    id: u.id, username: u.username, isAdmin: !!u.is_admin, createdAt: u.created_at, maxBitrate: u.max_bitrate || 0,
    permissions: permissionsOf(u), libraryDirs: libraryDirsOf({ ...u, is_admin: 0 }),
    twoFactor: !!u.totp_secret, authSource: u.auth_source || 'local', hasPassword: String(u.password_hash || '').startsWith('scrypt$'),
    shareActivity: !!u.share_activity,
  };
}

// ───────── Two-factor authentication (TOTP, RFC 6238) ─────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(s) {
  const clean = String(s).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
const usedCodes = new Map(); // `${secret}:${step}` -> expiry, so a code works only once
/** Accepts the current code and its neighbours (±30 s of clock drift). */
export function verifyTotp(secret, code) {
  const c = String(code || '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(c)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (const s of [step, step - 1, step + 1]) {
    const key = `${secret}:${s}`;
    if (usedCodes.has(key)) continue;
    const want = hotp(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c))) {
      usedCodes.set(key, Date.now() + 120000);
      return true;
    }
  }
  return false;
}
setInterval(() => { const now = Date.now(); for (const [k, t] of usedCodes) if (t < now) usedCodes.delete(k); }, 60000).unref();
export const totpUri = (secret, username) =>
  `otpauth://totp/${encodeURIComponent(`Sonara:${username}`)}?secret=${secret}&issuer=Sonara&algorithm=SHA1&digits=6&period=30`;

// ───────── External accounts (reverse proxy, single sign-on) ─────────

const NO_PASSWORD = '!external';

/** Find (or create) the account for an externally authenticated user. */
export function externalUser({ source, externalId, username, isAdmin = null, autoCreate }) {
  let u = externalId ? q('SELECT * FROM users WHERE auth_source = ? AND external_id = ?').get(source, String(externalId)) : null;
  if (!u && username) {
    u = q('SELECT * FROM users WHERE username = ?').get(username);
    if (u) q('UPDATE users SET auth_source = ?, external_id = ? WHERE id = ?').run(source, externalId ? String(externalId) : null, u.id);
  }
  if (!u) {
    if (!autoCreate) return null;
    let name = String(username || '').replace(/[^\w.\-@]/g, '_').slice(0, 32);
    if (name.length < 2) name = `user_${crypto.randomBytes(3).toString('hex')}`;
    for (let n = 2; q('SELECT 1 FROM users WHERE username = ?').get(name); n++) name = `${name.slice(0, 28)}_${n}`;
    const first = userCount() === 0;
    const { lastInsertRowid } = q('INSERT INTO users (username, password_hash, is_admin, created_at, auth_source, external_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, NO_PASSWORD, first || isAdmin ? 1 : 0, Date.now(), source, externalId ? String(externalId) : null);
    log.info(`[auth] Created ${name} from ${source} sign-in`);
    u = q('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  } else if (isAdmin != null && !!u.is_admin !== isAdmin) {
    // Group membership is the source of truth for admin rights, but never demote the last admin.
    const admins = q('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n;
    if (isAdmin || admins > 1) {
      q('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, u.id);
      u = q('SELECT * FROM users WHERE id = ?').get(u.id);
    }
  }
  return u;
}

const normIp = (ip) => String(ip || '').replace(/^::ffff:/, '');
function proxyUser(req) {
  const c = getConfig();
  if (!c.proxyAuthHeader) return null;
  const name = req.headers[c.proxyAuthHeader.toLowerCase()];
  if (!name || typeof name !== 'string') return null;
  const ip = normIp(req.socket.remoteAddress);
  const trusted = [].concat(c.proxyAuthTrusted || []).map(normIp);
  if (!trusted.includes(ip)) return null;
  return externalUser({ source: 'proxy', externalId: name, username: name, autoCreate: !!c.proxyAuthAutoCreate });
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
    token, userId, now, now + getConfig().sessionDays * DAY,
  );
  return token;
}

export function destroySession(token) {
  q('DELETE FROM sessions WHERE token = ?').run(token);
}

export function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: getConfig().sessionDays * DAY,
    path: '/',
  });
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Attaches req.user (or null) based on the session cookie (or a trusted proxy header). */
export function sessionMiddleware(req, res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const row = q(`
      SELECT u.*, s.expires_at AS session_expires FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
    if (row && row.session_expires > Date.now()) {
      req.user = row;
      req.sessionToken = token;
      // Sliding expiry: extend if more than a day has passed.
      const fresh = Date.now() + getConfig().sessionDays * DAY;
      if (fresh - row.session_expires > DAY) q('UPDATE sessions SET expires_at = ? WHERE token = ?').run(fresh, token);
    } else if (row) {
      destroySession(token);
    }
  }
  if (!req.user) {
    try {
      const u = proxyUser(req);
      if (u) { req.user = u; req.proxyAuth = true; }
    } catch (err) { log.warn('[auth] Proxy sign-in failed:', err.message); }
  }
  // Users limited to some folders only see those tracks (see libraryScope in db.js).
  const dirs = libraryDirsOf(req.user);
  if (dirs) return libraryScope.run({ dirs, userId: req.user.id }, next);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in' });
  if (!req.user.is_admin) return res.status(403).json({ error: 'Admins only' });
  next();
}

// Simple in-memory brute-force protection for the login endpoint.
const attempts = new Map();
export function loginRateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const entry = attempts.get(key) || { count: 0, reset: now + 15 * 60 * 1000 };
  if (now > entry.reset) Object.assign(entry, { count: 0, reset: now + 15 * 60 * 1000 });
  if (entry.count >= 10) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }
  entry.count++;
  attempts.set(key, entry);
  res.on('finish', () => {
    if (res.statusCode < 400) attempts.delete(key);
  });
  next();
}

setInterval(() => q('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 6 * 60 * 60 * 1000).unref();
