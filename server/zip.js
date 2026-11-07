// Minimal streaming ZIP writer (no compression: audio doesn't compress).
// Supports ZIP64 so archives and entries over 4 GB work.

import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, crc = 0) {
  crc = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

const MAX32 = 0xffffffff;

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Write a zip to a writable stream (e.g. an HTTP response).
 * entries: [{ name, path } | { name, data: Buffer }], written in order.
 */
export async function writeZip(out, entries, { signal } = {}) {
  let offset = 0;
  const central = [];
  const write = (buf) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    offset += buf.length;
    if (out.write(buf)) resolve();
    else { out.once('drain', resolve); out.once('close', () => reject(new Error('aborted'))); }
  });

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const size = e.data ? e.data.length : (await fs.promises.stat(e.path)).size;
    const big = size >= MAX32;
    const { time, date } = dosTime(e.mtime || new Date());
    const localOffset = offset;

    // Local header (sizes go in the data descriptor, since the CRC is computed while streaming).
    const extra = big ? Buffer.alloc(20) : Buffer.alloc(0);
    if (big) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(16, 2); }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(big ? 45 : 20, 4);
    lh.writeUInt16LE(0x0808, 6); // data descriptor + UTF-8 names
    lh.writeUInt16LE(0, 8); // stored
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(0, 14);
    lh.writeUInt32LE(big ? MAX32 : 0, 18);
    lh.writeUInt32LE(big ? MAX32 : 0, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(extra.length, 28);
    await write(Buffer.concat([lh, nameBuf, extra]));

    let crc = 0;
    if (e.data) {
      crc = crc32(e.data);
      await write(e.data);
    } else {
      for await (const chunk of fs.createReadStream(e.path, { highWaterMark: 1 << 20 })) {
        crc = crc32(chunk, crc);
        await write(chunk);
      }
    }

    // Data descriptor.
    const dd = Buffer.alloc(big ? 24 : 16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    if (big) { dd.writeBigUInt64LE(BigInt(size), 8); dd.writeBigUInt64LE(BigInt(size), 16); }
    else { dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12); }
    await write(dd);

    central.push({ nameBuf, size, crc, time, date, localOffset, big });
  }

  // Central directory.
  const cdStart = offset;
  for (const c of central) {
    const needOffset64 = c.localOffset >= MAX32;
    const z = [];
    if (c.big) z.push(BigInt(c.size), BigInt(c.size));
    if (needOffset64) z.push(BigInt(c.localOffset));
    const extra = Buffer.alloc(z.length ? 4 + z.length * 8 : 0);
    if (z.length) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(z.length * 8, 2);
      z.forEach((v, i) => extra.writeBigUInt64LE(v, 4 + i * 8));
    }
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(0x031e, 4); // made by: UNIX, spec 3.0
    h.writeUInt16LE(z.length ? 45 : 20, 6);
    h.writeUInt16LE(0x0808, 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.time, 12);
    h.writeUInt16LE(c.date, 14);
    h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.big ? MAX32 : c.size, 20);
    h.writeUInt32LE(c.big ? MAX32 : c.size, 24);
    h.writeUInt16LE(c.nameBuf.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt16LE(0, 32); // comment
    h.writeUInt16LE(0, 34); // disk
    h.writeUInt16LE(0, 36); // internal attrs
    h.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    h.writeUInt32LE(needOffset64 ? MAX32 : c.localOffset, 42);
    await write(Buffer.concat([h, c.nameBuf, extra]));
  }
  const cdSize = offset - cdStart;
  const needZip64 = central.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32 || central.some((c) => c.big || c.localOffset >= MAX32);

  if (needZip64) {
    const z64Offset = offset;
    const r = Buffer.alloc(56);
    r.writeUInt32LE(0x06064b50, 0);
    r.writeBigUInt64LE(44n, 4);
    r.writeUInt16LE(45, 12);
    r.writeUInt16LE(45, 14);
    r.writeUInt32LE(0, 16);
    r.writeUInt32LE(0, 20);
    r.writeBigUInt64LE(BigInt(central.length), 24);
    r.writeBigUInt64LE(BigInt(central.length), 32);
    r.writeBigUInt64LE(BigInt(cdSize), 40);
    r.writeBigUInt64LE(BigInt(cdStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    loc.writeBigUInt64LE(BigInt(z64Offset), 8);
    loc.writeUInt32LE(1, 16);
    await write(Buffer.concat([r, loc]));
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Math.min(central.length, 0xffff), 8);
  end.writeUInt16LE(Math.min(central.length, 0xffff), 10);
  end.writeUInt32LE(Math.min(cdSize, MAX32), 12);
  end.writeUInt32LE(Math.min(cdStart, MAX32), 16);
  end.writeUInt16LE(0, 20);
  await write(end);
}
