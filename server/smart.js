// Smart playlists: rules → SQL (always with bound parameters).
//
// rules: { match: 'all' | 'any', rules: [{ field, op, value, value2? }] }
// The generated WHERE clause expects the track query aliases used in api.js:
//   t = tracks, f = favorites, r = ratings, pc = per-user play counts, an = audio analysis.

const TEXT = 'text', NUM = 'num', DATE = 'date', BOOL = 'bool', LIST = 'list';

export const FIELDS = {
  title: { type: TEXT, label: 'Title', sql: 't.title' },
  artist: { type: LIST, label: 'Artist', table: "SELECT name AS v FROM track_artists WHERE track_id = t.id AND role = 'artist'" },
  albumArtist: { type: TEXT, label: 'Album artist', sql: 't.album_artist' },
  album: { type: TEXT, label: 'Album', sql: 't.album' },
  genre: { type: LIST, label: 'Genre', table: 'SELECT genre AS v FROM track_genres WHERE track_id = t.id' },
  year: { type: NUM, label: 'Year', sql: 't.year' },
  rating: { type: NUM, label: 'Rating', sql: 'COALESCE(r.rating, 0)' },
  playCount: { type: NUM, label: 'Play count', sql: 'COALESCE(pc.n, 0)' },
  lastPlayed: { type: DATE, label: 'Last played', sql: 'pc.last' },
  addedAt: { type: DATE, label: 'Date added', sql: 't.added_at' },
  favorite: { type: BOOL, label: 'Favorite', sql: '(f.track_id IS NOT NULL)' },
  duration: { type: NUM, label: 'Length (minutes)', sql: '(t.duration / 60.0)' },
  bitrate: { type: NUM, label: 'Bitrate (kbps)', sql: '(t.bitrate / 1000.0)' },
  lossless: { type: BOOL, label: 'Lossless', sql: '(t.lossless = 1)' },
  releaseType: { type: TEXT, label: 'Release type', sql: "(CASE WHEN t.compilation = 1 THEN 'compilation' ELSE COALESCE(t.release_type, 'album') END)" },
  codec: { type: TEXT, label: 'Format', sql: 't.codec' },
  bpm: { type: NUM, label: 'Tempo (BPM)', sql: 'an.bpm' },
  key: { type: TEXT, label: 'Key', sql: 'an.musical_key' },
  camelot: { type: TEXT, label: 'Key (Camelot)', sql: 'an.camelot' },
  energy: { type: NUM, label: 'Energy (0–100)', sql: '(an.energy * 100)' },
};

export const OPS = {
  [TEXT]: ['is', 'isNot', 'contains', 'notContains', 'startsWith', 'endsWith'],
  [LIST]: ['is', 'isNot', 'contains', 'notContains'],
  [NUM]: ['eq', 'ne', 'gt', 'lt', 'between'],
  [DATE]: ['inLast', 'notInLast', 'before', 'after', 'never'],
  [BOOL]: ['isTrue', 'isFalse'],
};

export const SORTS = {
  random: 'RANDOM()',
  title: 't.title COLLATE NOCASE',
  artist: 't.artist COLLATE NOCASE, t.album COLLATE NOCASE, t.disc_no, t.track_no',
  album: 't.album COLLATE NOCASE, t.disc_no, t.track_no',
  year: 't.year DESC, t.album_id, t.disc_no, t.track_no',
  added: 't.added_at DESC',
  lastPlayed: 'pc.last IS NULL, pc.last DESC',
  leastRecent: 'pc.last IS NOT NULL, pc.last ASC',
  mostPlayed: 'COALESCE(pc.n, 0) DESC',
  rating: 'COALESCE(r.rating, 0) DESC, RANDOM()',
  bpm: 'an.bpm IS NULL, an.bpm',
  energy: 'an.energy IS NULL, an.energy DESC',
};

const escLike = (s) => String(s).replace(/[\\%_]/g, (m) => '\\' + m);
const DAY = 86400000;

export class RuleError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/** Validate and normalise incoming rules. */
export function cleanRules(input) {
  const match = input?.match === 'any' ? 'any' : 'all';
  const list = Array.isArray(input?.rules) ? input.rules.slice(0, 30) : [];
  const rules = [];
  for (const r of list) {
    const field = FIELDS[r?.field];
    if (!field) throw new RuleError(`Unknown field: ${r?.field}`);
    if (!OPS[field.type].includes(r.op)) throw new RuleError(`“${field.label}” can't use “${r.op}”`);
    const out = { field: r.field, op: r.op };
    if (field.type === TEXT || field.type === LIST) {
      out.value = String(r.value ?? '').trim().slice(0, 200);
      if (!out.value) throw new RuleError(`Enter a value for “${field.label}”`);
    } else if (field.type === NUM) {
      out.value = Number(r.value);
      if (!Number.isFinite(out.value)) throw new RuleError(`“${field.label}” needs a number`);
      if (r.op === 'between') {
        out.value2 = Number(r.value2);
        if (!Number.isFinite(out.value2)) throw new RuleError(`“${field.label}” needs two numbers`);
      }
    } else if (field.type === DATE) {
      if (r.op === 'inLast' || r.op === 'notInLast') {
        out.value = Math.max(1, Math.min(36500, Math.round(Number(r.value) || 0)));
      } else if (r.op === 'before' || r.op === 'after') {
        const d = Date.parse(r.value);
        if (!Number.isFinite(d)) throw new RuleError(`“${field.label}” needs a date`);
        out.value = new Date(d).toISOString().slice(0, 10);
      }
    }
    rules.push(out);
  }
  return { match, rules };
}

/** Build { where, params } for cleaned rules. */
export function buildWhere(spec) {
  const params = {};
  let n = 0;
  const p = (v) => { const k = `sp${n++}`; params[k] = v; return `$${k}`; };
  const parts = spec.rules.map((r) => {
    const f = FIELDS[r.field];
    if (f.type === LIST) {
      const exact = r.op === 'is' || r.op === 'isNot';
      const cond = exact ? `v = ${p(r.value)} COLLATE NOCASE` : `v LIKE ${p(`%${escLike(r.value)}%`)} ESCAPE '\\'`;
      const exists = `EXISTS (SELECT 1 FROM (${f.table}) WHERE ${cond})`;
      return r.op === 'isNot' || r.op === 'notContains' ? `NOT ${exists}` : exists;
    }
    const c = f.sql;
    switch (r.op) {
      case 'is': return `${c} = ${p(r.value)} COLLATE NOCASE`;
      case 'isNot': return `(${c} IS NULL OR ${c} != ${p(r.value)} COLLATE NOCASE)`;
      case 'contains': return `${c} LIKE ${p(`%${escLike(r.value)}%`)} ESCAPE '\\'`;
      case 'notContains': return `(${c} IS NULL OR ${c} NOT LIKE ${p(`%${escLike(r.value)}%`)} ESCAPE '\\')`;
      case 'startsWith': return `${c} LIKE ${p(`${escLike(r.value)}%`)} ESCAPE '\\'`;
      case 'endsWith': return `${c} LIKE ${p(`%${escLike(r.value)}`)} ESCAPE '\\'`;
      case 'eq': return `${c} = ${p(r.value)}`;
      case 'ne': return `(${c} IS NULL OR ${c} != ${p(r.value)})`;
      case 'gt': return `${c} > ${p(r.value)}`;
      case 'lt': return `${c} < ${p(r.value)}`;
      case 'between': return `${c} BETWEEN ${p(Math.min(r.value, r.value2))} AND ${p(Math.max(r.value, r.value2))}`;
      // Dates are resolved when the playlist is opened, so "last 30 days" stays current.
      case 'inLast': return `${c} >= ${p(Date.now() - r.value * DAY)}`;
      case 'notInLast': return `(${c} IS NULL OR ${c} < ${p(Date.now() - r.value * DAY)})`;
      case 'before': return `${c} < ${p(Date.parse(r.value))}`;
      case 'after': return `${c} >= ${p(Date.parse(r.value) + DAY)}`;
      case 'never': return `${c} IS NULL`;
      case 'isTrue': return `${c}`;
      case 'isFalse': return `NOT ${c}`;
      default: throw new RuleError(`Unknown operator ${r.op}`);
    }
  });
  if (!parts.length) return { where: '', params };
  return { where: `WHERE (${parts.join(spec.match === 'any' ? ' OR ' : ' AND ')})`, params };
}

/** Field/operator catalogue for the editor UI. */
export const catalogue = () => ({
  fields: Object.entries(FIELDS).map(([k, f]) => ({ key: k, label: f.label, type: f.type, ops: OPS[f.type] })),
  sorts: Object.keys(SORTS),
});
