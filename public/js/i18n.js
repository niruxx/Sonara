// Translations.
//
// The English text is the key: t('Albums') looks 'Albums' up in the current
// language and falls back to the English when there's no translation yet, so
// screens can be translated bit by bit. Placeholders look like {name}.
//
// Counted phrases go through plural(n, 'song') which looks up '{n} songs'. A
// translation for it can be a string or an object keyed by Intl.PluralRules
// categories: { one: '{n} canción', other: '{n} canciones' }.
//
// Adding a language: copy public/js/locales/es.js, translate the values and add
// the language to LANGUAGES below.

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'de', name: 'Deutsch' },
];

const KEY = 'sonara.lang';
let current = 'en';
let dict = {};
let rules = new Intl.PluralRules('en');

/** The language chosen in Settings: a code from LANGUAGES, or 'auto' (follow the browser). */
export function langPref() {
  try { return JSON.parse(localStorage.getItem(KEY)) || 'auto'; } catch { return 'auto'; }
}
export function setLangPref(code) {
  try { localStorage.setItem(KEY, JSON.stringify(code)); } catch { /* storage full or blocked */ }
}

function resolve(pref) {
  const codes = LANGUAGES.map((l) => l.code);
  if (pref && pref !== 'auto' && codes.includes(pref)) return pref;
  for (const l of navigator.languages || [navigator.language || 'en']) {
    const base = String(l).toLowerCase().split('-')[0];
    if (codes.includes(base)) return base;
  }
  return 'en';
}

/** Load the chosen language. Call once before the first render. */
export async function loadLocale(pref = langPref()) {
  const code = resolve(pref);
  try {
    dict = code === 'en' ? {} : (await import(`./locales/${code}.js`)).default;
    current = code;
  } catch (err) {
    console.warn(`Could not load the ${code} translation`, err);
    dict = {};
    current = 'en';
  }
  rules = new Intl.PluralRules(current);
  document.documentElement.lang = current;
  return current;
}

/** The active language code ('en', 'es'…), for Intl formatting. */
export const locale = () => current;

const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? (typeof vars[k] === 'number' ? vars[k].toLocaleString(current) : vars[k]) : m)) : s);

/** Translate an English UI string. */
export function t(key, vars) {
  let s = dict[key];
  if (s && typeof s === 'object') s = s[rules.select(Number(vars?.n) || 0)] ?? s.other;
  return fill(s ?? key, vars);
}

const IRREGULAR = { person: 'people', 'new song': 'new songs' };

/** "1 song" / "3 songs", translated. */
export function plural(n, word, pluralWord = IRREGULAR[word] || `${word}s`) {
  const key = `{n} ${pluralWord}`;
  const entry = dict[key];
  if (entry != null) return t(key, { n });
  return `${n.toLocaleString(current)} ${n === 1 ? word : pluralWord}`;
}

/** Short, friendly date: "3 Mar" this year, "3 Mar 2023" otherwise. */
export function fmtDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(current, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}
