// Lists every route of Sonara's JSON API (/api/…) by reading the server source.
// Used to check that docs/openapi.json-style descriptions (server/openapi.js) cover the whole API:
//   node scripts/list-routes.js            → one "METHOD /api/path" per line
//   node scripts/list-routes.js --check    → exit 1 if a route is missing from the OpenAPI spec (or vice versa)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');

export function listRoutes() {
  const files = fs.readdirSync(SERVER).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(SERVER, f), 'utf8'));
  const src = files.join('\n');
  const routers = new Set(['api']);
  for (const m of src.matchAll(/(?:export\s+)?const\s+(\w+)\s*=\s*express\.Router\(\)/g)) routers.add(m[1]);
  // Mounts: parent.use('/prefix', [middleware,] child) or parent.use(child)
  const mounts = [];
  for (const m of src.matchAll(/\b(\w+)\.use\(\s*(?:'([^']*)'\s*,\s*)?(?:\w+\s*,\s*)*(\w+)\s*\)/g)) {
    if (routers.has(m[1]) && routers.has(m[3])) mounts.push({ parent: m[1], prefix: m[2] || '', child: m[3] });
  }
  // Routers the app mounts under /api directly (the public share API).
  for (const m of src.matchAll(/\bapp\.use\(\s*'(\/api\/[^']*)'\s*,\s*(\w+)\s*\)/g)) {
    if (routers.has(m[2])) mounts.push({ parent: '__app', prefix: m[1], child: m[2] });
  }
  const prefixOf = (name, seen = new Set()) => {
    if (name === 'api') return ['/api'];
    if (name === '__app') return [''];
    if (seen.has(name)) return [];
    seen.add(name);
    return mounts.filter((x) => x.child === name).flatMap((x) => prefixOf(x.parent, seen).map((p) => p + x.prefix));
  };
  const out = new Set();
  for (const m of src.matchAll(/\b(\w+)\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)) {
    if (!routers.has(m[1])) continue;
    for (const p of prefixOf(m[1])) out.add(`${m[2].toUpperCase()} ${(p + m[3]).replace(/\/$/, '') || '/'}`);
  }
  // Routes registered on the app itself under /api.
  for (const m of src.matchAll(/\bapp\.(get|post|put|delete)\(\s*'(\/api\/[^']+)'/g)) out.add(`${m[1].toUpperCase()} ${m[2]}`);
  return [...out].filter((r) => !r.includes('/rest/')).sort((a, b) => a.split(' ')[1].localeCompare(b.split(' ')[1]) || a.localeCompare(b));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const routes = listRoutes();
  if (!process.argv.includes('--check')) {
    console.log(routes.join('\n'));
  } else {
    const { documentedRoutes } = await import('../server/openapi.js');
    const doc = new Set(documentedRoutes());
    const code = new Set(routes);
    const undocumented = routes.filter((r) => !doc.has(r));
    const stale = [...doc].filter((r) => !code.has(r));
    for (const r of undocumented) console.log(`not documented: ${r}`);
    for (const r of stale) console.log(`documented but not in the code: ${r}`);
    console.log(`${routes.length} routes, ${undocumented.length} undocumented, ${stale.length} stale`);
    process.exit(undocumented.length || stale.length ? 1 : 0);
  }
}
