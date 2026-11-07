// Fetching URLs that people type in (podcast feeds, radio streams).
//
// Sonara fetches these on the user's behalf and passes the answer back, so a
// listener could otherwise point it at the router's admin page or anything else
// on the local network. Only admins may use private addresses; for everyone
// else the address is checked when the connection is made (after DNS, so a name
// can't resolve somewhere it shouldn't), and again on every redirect.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { userAgent } from './online.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return v4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const s = ip.toLowerCase();
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1]);
  return s === '::' || s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s) || s.startsWith('ff');
}

function lookupFor(allowPrivate) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = allowPrivate ? addrs : addrs.filter((a) => !isPrivateAddress(a.address));
      if (!list.length) return cb(httpError(400, 'That address is on a private network. Only admins can add those.'));
      if (options.all) cb(null, list);
      else cb(null, list[0].address, list[0].family);
    });
  };
}

/** Accept what people paste: feed://, itpc://, missing scheme. Returns a URL or throws a 400. */
export function cleanUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw httpError(400, 'Enter a web address');
  s = s.replace(/^(feed|itpc|pcast|podcast):\/\//i, 'https://').replace(/^feed:/i, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw httpError(400, "That doesn't look like a web address"); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'Only http and https addresses are supported');
  return u;
}

/**
 * GET a URL, following redirects. Resolves with the response (status < 400)
 * and the final URL. The caller must consume or destroy the response.
 */
export function openUrl(input, { headers = {}, allowPrivate = false, timeout = 15000, maxRedirects = 6, accept = '*/*' } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(httpError(400, 'Only http and https addresses are supported'));
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (!allowPrivate && net.isIP(host) && isPrivateAddress(host)) return reject(httpError(400, 'That address is on a private network. Only admins can add those.'));
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, {
        lookup: lookupFor(allowPrivate),
        headers: { 'User-Agent': userAgent(), Accept: accept, ...headers },
      }, (res) => {
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && loc) {
          res.resume();
          if (left <= 0) return reject(httpError(502, 'Too many redirects'));
          let next;
          try { next = new URL(loc, u); } catch { return reject(httpError(502, 'The server sent a broken redirect')); }
          return go(next, left - 1);
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(httpError(res.statusCode === 404 ? 404 : 502, `${u.hostname} answered ${res.statusCode}`));
        }
        res.setTimeout(Math.max(timeout, 30000), () => res.destroy(new Error('The connection went quiet')));
        resolve({ res, url: u });
      });
      req.setTimeout(timeout, () => req.destroy(httpError(504, `${u.hostname} took too long to answer`)));
      req.on('error', (err) => reject(err.status ? err : httpError(502, `Couldn't reach ${u.hostname}${err.code ? ` (${err.code})` : ''}`)));
    };
    try { go(input instanceof URL ? input : cleanUrl(input), maxRedirects); } catch (err) { reject(err); }
  });
}

/** Read a whole response into a Buffer, refusing anything over `limit` bytes. */
export function readBody(res, limit = 20 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on('data', (c) => {
      size += c.length;
      if (size > limit) { res.destroy(); reject(httpError(413, 'That file is too large')); return; }
      chunks.push(c);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

/** Fetch a URL as text (feeds, playlists). */
export async function fetchText(url, opts = {}) {
  const { res, url: final } = await openUrl(url, opts);
  if (res.statusCode === 304) { res.resume(); return { status: 304, headers: res.headers, url: final, text: '' }; }
  const buf = await readBody(res, opts.limit);
  return { status: res.statusCode, headers: res.headers, url: final, text: buf.toString('utf8') };
}

/** Fetch a small image and return { data, type }, or null if it isn't one. */
export async function fetchImage(url, opts = {}) {
  try {
    const { res } = await openUrl(url, { ...opts, accept: 'image/*', timeout: 10000 });
    const type = String(res.headers['content-type'] || '');
    if (!/^image\/(jpeg|jpg|png|webp)/i.test(type)) { res.resume(); return null; }
    return { data: await readBody(res, 8 * 1024 * 1024), type };
  } catch { return null; }
}
