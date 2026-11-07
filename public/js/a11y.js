// Accessibility helpers: a live region for screen-reader announcements, and
// keyboard support for menus and dialogs (arrow keys, focus trapping, putting
// focus back where it was when they close).

let region = null;

/** Read a short message out to screen readers without moving focus. */
export function announce(message) {
  if (!region) {
    region = document.createElement('div');
    region.className = 'sr-only';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    document.body.append(region);
  }
  // Clear first so the same text twice in a row is still read.
  region.textContent = '';
  setTimeout(() => { region.textContent = message; }, 60);
}

const FOCUSABLE = 'button:not([disabled]):not([hidden]), [href], input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
export const focusables = (root) => [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null || n === document.activeElement);

/** Keep Tab inside `root` (for modal dialogs). Returns a function that undoes it. */
export function trapFocus(root) {
  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    const list = focusables(root);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0];
    const last = list[list.length - 1];
    if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (document.activeElement === last || !root.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
  };
  root.addEventListener('keydown', onKey);
  return () => root.removeEventListener('keydown', onKey);
}

/** Up/Down/Home/End move between menu items; letters jump to the next item starting with them. */
export function menuKeys(menu) {
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('.menu-item:not([disabled])')];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const k = e.key.toLowerCase();
      next = [...items.slice(i + 1), ...items.slice(0, i + 1)].find((b) => b.textContent.trim().toLowerCase().startsWith(k)) || null;
    }
    if (next) { e.preventDefault(); next.focus(); }
  });
}
