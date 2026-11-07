// DLNA / UPnP speakers: find MediaRenderers on the local network (SSDP) and
// play to them over AVTransport. Each renderer shows up as a Sonara Connect
// device with its own server-side queue. The renderer fetches audio from a
// signed, expiring stream URL, so it doesn't need to sign in.

import dgram from 'node:dgram';
import { getConfig } from './config.js';
import { log } from './logger.js';
import { ServerPlayer, registerServerDevice, removeServerDevice } from './connect.js';
import { signedStreamPath, lanBaseUrl } from './public.js';

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const AVT = 'urn:schemas-upnp-org:service:AVTransport:1';
const RC = 'urn:schemas-upnp-org:service:RenderingControl:1';

const renderers = new Map(); // udn -> { device, location, lastSeen }
let timer = null;

const xmlEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const tag = (xml, name) => xml.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'i'))?.[1]?.trim() ?? null;
const hms = (sec) => {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const secs = (t) => {
  const m = String(t || '').match(/(\d+):(\d+):(\d+)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
};

async function soap(url, service, action, args = {}) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
<s:Body><u:${action} xmlns:u="${service}">${Object.entries(args).map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(url, {
    method: 'POST', body, signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"` },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${action} failed: ${tag(text, 'errorDescription') || r.status}`);
  return text;
}

class DlnaBackend {
  constructor({ avt, rc, host }) {
    Object.assign(this, { avt, rc, host });
    this.poll = null;
    this.wasPlaying = false;
    this.expectStop = false;
  }

  #startPolling() {
    clearInterval(this.poll);
    this.poll = setInterval(async () => {
      try {
        const info = await soap(this.avt, AVT, 'GetTransportInfo', { InstanceID: 0 });
        const st = tag(info, 'CurrentTransportState');
        if (st === 'PLAYING') {
          this.wasPlaying = true;
          const pos = await soap(this.avt, AVT, 'GetPositionInfo', { InstanceID: 0 });
          this.onTime?.(secs(tag(pos, 'RelTime')));
        } else if ((st === 'STOPPED' || st === 'NO_MEDIA_PRESENT') && this.wasPlaying && !this.expectStop) {
          this.wasPlaying = false;
          this.onEnded?.();
        }
      } catch { /* renderer busy or gone; try again */ }
    }, 1500);
    this.poll.unref();
  }

  async load(t, startSec, volume) {
    const format = getConfig().dlnaFormat === 'original' ? 'original' : 'mp3';
    const base = lanBaseUrl(this.host);
    const url = base + signedStreamPath(t.id, { format });
    const mime = format === 'mp3' ? 'audio/mpeg' : 'audio/*';
    const meta = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">`
      + `<item id="sonara-${t.id}" parentID="0" restricted="1"><dc:title>${xmlEsc(t.title)}</dc:title><dc:creator>${xmlEsc(t.artist)}</dc:creator>`
      + `<upnp:artist>${xmlEsc(t.artist)}</upnp:artist><upnp:album>${xmlEsc(t.album)}</upnp:album>`
      + `<upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo="http-get:*:${mime}:*">${xmlEsc(url)}</res></item></DIDL-Lite>`;
    this.expectStop = true;
    try { await soap(this.avt, AVT, 'Stop', { InstanceID: 0 }); } catch { /* not playing */ }
    await soap(this.avt, AVT, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: meta });
    await this.setVolume(volume).catch(() => {});
    await soap(this.avt, AVT, 'Play', { InstanceID: 0, Speed: 1 });
    this.wasPlaying = false;
    if (startSec > 1) setTimeout(() => this.seek(startSec).catch(() => {}), 1500);
    setTimeout(() => { this.expectStop = false; }, 3000);
    this.#startPolling();
  }
  async pause() { this.expectStop = true; await soap(this.avt, AVT, 'Pause', { InstanceID: 0 }); }
  async resume() { await soap(this.avt, AVT, 'Play', { InstanceID: 0, Speed: 1 }); setTimeout(() => { this.expectStop = false; }, 2000); }
  async seek(sec) { await soap(this.avt, AVT, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: hms(sec) }); }
  async setVolume(v) { if (this.rc) await soap(this.rc, RC, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: Math.round(v * 100) }); }
  async stop() { this.expectStop = true; clearInterval(this.poll); await soap(this.avt, AVT, 'Stop', { InstanceID: 0 }); }
  shutdown() { clearInterval(this.poll); }
}

async function describe(location) {
  const r = await fetch(location, { signal: AbortSignal.timeout(5000) });
  const xml = await r.text();
  const udn = tag(xml, 'UDN');
  const name = tag(xml, 'friendlyName') || 'Network speaker';
  const base = tag(xml, 'URLBase') || location;
  let avt = null, rc = null;
  for (const m of xml.matchAll(/<(?:\w+:)?service>([\s\S]*?)<\/(?:\w+:)?service>/gi)) {
    const type = tag(m[1], 'serviceType') || '';
    const ctl = tag(m[1], 'controlURL');
    if (!ctl) continue;
    const url = new URL(ctl, base).toString();
    if (type.includes(':AVTransport:')) avt = url;
    if (type.includes(':RenderingControl:')) rc = url;
  }
  return udn && avt ? { udn, name, avt, rc, host: new URL(location).hostname } : null;
}

function search() {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('message', (msg) => {
      const loc = String(msg).match(/^location:\s*(.+)$/im)?.[1]?.trim();
      if (loc) found.add(loc);
    });
    sock.on('error', () => { try { sock.close(); } catch { /* ignore */ } resolve([...found]); });
    sock.bind(0, () => {
      const m = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2',
        'ST: urn:schemas-upnp-org:device:MediaRenderer:1', '', ''].join('\r\n'));
      sock.send(m, SSDP_PORT, SSDP_ADDR);
      setTimeout(() => sock.send(m, SSDP_PORT, SSDP_ADDR), 500);
    });
    setTimeout(() => { try { sock.close(); } catch { /* ignore */ } resolve([...found]); }, 3500);
  });
}

export async function discoverRenderers() {
  if (!getConfig().dlna) return [];
  const locations = await search();
  const now = Date.now();
  for (const loc of locations) {
    try {
      const d = await describe(loc);
      if (!d) continue;
      const known = renderers.get(d.udn);
      if (known) { known.lastSeen = now; continue; }
      const id = `dlna-${d.udn.replace(/^uuid:/, '').replace(/[^\w-]/g, '').slice(0, 36)}`;
      const device = new ServerPlayer({ id, name: d.name, kind: 'dlna', backend: new DlnaBackend(d) });
      renderers.set(d.udn, { device, location: loc, lastSeen: now });
      registerServerDevice(device);
      log.info(`[dlna] Found ${d.name}`);
    } catch { /* not a usable renderer */ }
  }
  // Forget renderers that stopped answering (unless they're playing).
  for (const [udn, r] of renderers) {
    if (now - r.lastSeen > 16 * 60000 && !r.device.playing) {
      r.device.backend.shutdown();
      removeServerDevice(r.device.id);
      renderers.delete(udn);
    }
  }
  return [...renderers.values()].map((r) => ({ id: r.device.id, name: r.device.name }));
}

export function setupDlna() {
  clearInterval(timer);
  if (!getConfig().dlna) {
    for (const r of renderers.values()) { r.device.backend.shutdown(); removeServerDevice(r.device.id); }
    renderers.clear();
    return;
  }
  discoverRenderers().catch((err) => log.warn('[dlna] Discovery failed:', err.message));
  timer = setInterval(() => discoverRenderers().catch(() => {}), 5 * 60000);
  timer.unref();
}

export const dlnaStatus = () => ({ enabled: !!getConfig().dlna, renderers: [...renderers.values()].map((r) => ({ id: r.device.id, name: r.device.name })) });
