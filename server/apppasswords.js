// App passwords: one per client app (Symfonium on the phone, Feishin on the laptop…), so apps
// never hold the account password and each one can be revoked on its own.
//
// They're random and shown once. They are stored as given, like session tokens, because
// Subsonic's token sign-in sends md5(password + salt), which only works if the server knows
// the password.

import crypto from 'node:crypto';
import express from 'express';
import { q } from './db.js';

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no 0/o, 1/l: easy to type on a phone

/** 24 random characters in groups of four, e.g. "k7qp-2mxa-…" (~120 bits). */
export function newAppPassword() {
  const bytes = crypto.randomBytes(24);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
  return chars.match(/.{4}/g).join('-');
}

export const appPasswordsOf = (userId) => q('SELECT id, secret FROM app_passwords WHERE user_id = ?').all(userId);

/** The app password of a user that `matches(secret)`, or null. */
export function findAppPassword(userId, matches) {
  for (const row of appPasswordsOf(userId)) if (matches(row.secret)) return row;
  return null;
}

/** Look an app password up by its value alone (OpenSubsonic apiKey). Returns { id, user_id } or null. */
export function appPasswordByKey(key) {
  if (typeof key !== 'string' || key.length < 10 || key.length > 200) return null;
  return q('SELECT id, user_id FROM app_passwords WHERE secret = ?').get(key) || null;
}

const lastTouch = new Map();
/** Remember when (and from which app) a password was last used; written at most once a minute. */
export function touchAppPassword(id, client) {
  const now = Date.now();
  if (now - (lastTouch.get(id) || 0) < 60000) return;
  lastTouch.set(id, now);
  q('UPDATE app_passwords SET last_used_at = ?, last_client = ? WHERE id = ?').run(now, String(client || '').slice(0, 80) || null, id);
}

// ───────── Routes (/api/me/app-passwords) ─────────

export const appPasswordsApi = express.Router();

appPasswordsApi.get('/', (req, res) => {
  res.json(q(`SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, last_client AS lastClient
    FROM app_passwords WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id));
});

// Body: { name }. The password is in the response and never shown again.
appPasswordsApi.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Give it a name, such as the app or device it’s for' });
  if (q('SELECT COUNT(*) AS n FROM app_passwords WHERE user_id = ?').get(req.user.id).n >= 50) {
    return res.status(400).json({ error: 'You have 50 app passwords already. Delete some you no longer use.' });
  }
  const password = newAppPassword();
  const { lastInsertRowid } = q('INSERT INTO app_passwords (user_id, name, secret, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, password, Date.now());
  res.json({ id: Number(lastInsertRowid), name, password, createdAt: Date.now(), lastUsedAt: null, lastClient: null });
});

appPasswordsApi.delete('/:id', (req, res) => {
  const r = q('DELETE FROM app_passwords WHERE id = ? AND user_id = ?').run(Number(req.params.id) || 0, req.user.id);
  if (!r.changes) return res.status(404).json({ error: 'App password not found' });
  res.json({ ok: true });
});
