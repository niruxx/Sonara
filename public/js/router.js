// History-API router with animated view transitions and scroll restoration.

const routes = [];
let handler = null;
const scrolls = new Map();
let currentKey = 0;

/** pattern like '/album/:id' */
export function route(pattern, view) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
  routes.push({ re, names, view });
}

export function match(pathname) {
  for (const r of routes) {
    const m = pathname.match(r.re);
    if (m) return { view: r.view, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

export function onRoute(fn) { handler = fn; }

function currentScroller() { return document.querySelector('.main'); }

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.origin);
  if (url.pathname + url.search === location.pathname + location.search && !replace) return;
  saveScroll();
  currentKey = Date.now() + Math.random();
  history[replace ? 'replaceState' : 'pushState']({ key: currentKey }, '', url.pathname + url.search);
  handler?.(url, { scroll: 0 });
}

function saveScroll() {
  const sc = currentScroller();
  if (sc) scrolls.set(currentKey, sc.scrollTop);
}

addEventListener('popstate', (e) => {
  saveScroll();
  currentKey = e.state?.key ?? 0;
  handler?.(new URL(location.href), { scroll: scrolls.get(currentKey) ?? 0 });
});

// Intercept same-origin link clicks.
document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a || a.target || a.hasAttribute('download')) return;
  const href = a.getAttribute('href');
  if (!href.startsWith('/') || href.startsWith('/api/')) return;
  e.preventDefault();
  navigate(href);
});

export function start() {
  currentKey = history.state?.key ?? Date.now();
  history.replaceState({ key: currentKey }, '', location.pathname + location.search);
  handler?.(new URL(location.href), { scroll: 0 });
}
