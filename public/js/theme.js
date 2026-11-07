// Colour theming: the accent palette follows the album you're looking at,
// or the one that's playing.
import { paletteFrom, coverUrl, prefs } from './util.js';

/** Colour themes, used when colours don't follow the album art (and when nothing has art). */
export const THEMES = {
  aurora: { name: 'Aurora', colors: ['#8b5cf6', '#ec4899', '#0ea5e9'] },
  sunset: { name: 'Sunset', colors: ['#f97316', '#e11d48', '#facc15'] },
  ocean: { name: 'Ocean', colors: ['#0ea5e9', '#14b8a6', '#6366f1'] },
  forest: { name: 'Forest', colors: ['#22c55e', '#84cc16', '#0d9488'] },
  rose: { name: 'Rose', colors: ['#f43f5e', '#d946ef', '#fb7185'] },
  ember: { name: 'Ember', colors: ['#ef4444', '#f59e0b', '#b91c1c'] },
  mono: { name: 'Monochrome', colors: ['#a1a1aa', '#e4e4e7', '#71717a'] },
};

/** Two companion colours for a custom accent: rotate its hue either way. */
function fromAccent(hex) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  let h = 0, sat = 0;
  if (max !== min) {
    const d = max - min;
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  const hsl = (dh) => `hsl(${(h + dh + 360) % 360} ${Math.round(sat * 100)}% ${Math.round(l * 100)}%)`;
  return [hex, hsl(40), hsl(-50)];
}

export function themeColors() {
  const custom = prefs.get('accentCustom', '');
  if (/^#[0-9a-f]{6}$/i.test(custom)) return fromAccent(custom);
  return (THEMES[prefs.get('themePreset', 'aurora')] || THEMES.aurora).colors;
}
const root = document.documentElement;
let pageCover;      // undefined = no page override
let playingCover = null;
let applied = null;
let seq = 0;

async function apply() {
  const cover = pageCover !== undefined && pageCover !== null ? pageCover : playingCover;
  if (cover === applied) return;
  applied = cover;
  const my = ++seq;
  const ambient = document.querySelector('.ambient-cover');
  const dynamic = prefs.get('dynamicColor', true);
  const pal = dynamic && cover ? await paletteFrom(coverUrl(cover)) : null;
  if (my !== seq) return;
  const [c1, c2, c3] = pal || themeColors();
  root.style.setProperty('--c1', c1);
  root.style.setProperty('--c2', c2);
  root.style.setProperty('--c3', c3);
  if (ambient) {
    if (dynamic && cover) {
      ambient.style.backgroundImage = `url("${coverUrl(cover)}")`;
      ambient.classList.add('show');
    } else {
      ambient.classList.remove('show');
    }
  }
}

/** Called by detail views (album/artist/playlist). */
export function setPalette(cover) { pageCover = cover || null; apply(); }
/** Called on every route change before the new view renders. */
export function clearPagePalette() { pageCover = undefined; }
export function settlePalette() { apply(); }
export function setPlayingCover(cover) { playingCover = cover || null; apply(); }
export function refreshTheme() { applied = Symbol('force'); apply(); }
