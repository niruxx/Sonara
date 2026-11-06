// Users, password hashing (scrypt) and cookie sessions.

import crypto from 'node:crypto';
import { q } from './db.js';
import { getConfig } from './config.js';

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

export function publicUser(u) {
  return u && { id: u.id, username: u.username, isAdmin: !!u.is_admin, createdAt: u.created_at };
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

/** Attaches req.user (or null) based on the session cookie. */
export function sessionMiddleware(req, _res, next) {
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
