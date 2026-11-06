// Colour theming: the accent palette follows the album you're looking at,
// or the one that's playing.
import { paletteFrom, coverUrl, prefs } from './util.js';

const DEFAULT = ['#8b5cf6', '#ec4899', '#0ea5e9'];
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
  const [c1, c2, c3] = pal || DEFAULT;
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
