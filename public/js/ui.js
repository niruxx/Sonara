// UI primitives: toasts, context menus, modals, ripple + tilt effects, drag-sorting.
import { html, ic, el, esc } from './util.js';

// ───────── Toasts ─────────

export function toast(message, { type = 'info', ms = 2600 } = {}) {
  const t = el(html`<div class="toast ${type}">${ic(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'sparkles')}<span>${message}</span></div>`);
  document.getElementById('toasts').append(t);
  setTimeout(() => {
    t.classList.add('out');
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, ms);
}
export const toastError = (err) => toast(err?.message || String(err), { type: 'error', ms: 4000 });

// ───────── Context menus ─────────

let openMenuEl = null;
export function closeMenu() {
  if (!openMenuEl) return;
  const m = openMenuEl;
  openMenuEl = null;
  m.classList.add('out');
  m.addEventListener('animationend', () => m.remove(), { once: true });
}

/**
 * items: Array<{ icon, label, action, danger } | 'sep' | { head }>
 * at: MouseEvent | Element | {x, y}
 */
export function openMenu(at, items) {
  closeMenu();
  const m = el(html`<div class="menu" role="menu"></div>`);
  const scroll = items.length > 12 ? el('<div class="menu-scroll"></div>') : m;
  if (scroll !== m) m.append(scroll);
  for (const it of items) {
    if (it === 'sep') { m.append(el('<div class="menu-sep"></div>')); continue; }
    if (it.head) { m.insertBefore(el(html`<div class="menu-head">${it.head}</div>`), scroll === m ? null : scroll); continue; }
    const b = el(html`<button class="menu-item ${it.danger ? 'danger' : ''}" role="menuitem">${it.icon ? ic(it.icon) : ''}<span>${it.label}</span></button>`);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!it.keepOpen) closeMenu();
      it.action?.(e);
    });
    scroll.append(b);
  }
  document.body.append(m);

  let x, y;
  if (at instanceof Element) {
    const r = at.getBoundingClientRect();
    x = r.right; y = r.bottom + 6;
    m.style.setProperty('--ox', 'top right');
    x -= m.offsetWidth;
  } else {
    x = at.clientX ?? at.x; y = at.clientY ?? at.y;
  }
  const w = m.offsetWidth, h = m.offsetHeight;
  if (x + w > innerWidth - 8) { x = innerWidth - w - 8; }
  if (y + h > innerHeight - 8) { y = Math.max(8, y - h - (at instanceof Element ? at.offsetHeight + 12 : 0)); m.style.setProperty('--ox', 'bottom right'); }
  m.style.left = Math.max(8, x) + 'px';
  m.style.top = Math.max(8, y) + 'px';
  openMenuEl = m;
  m.querySelector('.menu-item')?.focus({ preventScroll: true });
  return m;
}

addEventListener('pointerdown', (e) => { if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu(); }, true);
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
addEventListener('resize', closeMenu);
addEventListener('scroll', closeMenu, true);

// ───────── Modals ─────────

/**
 * Opens a modal. `build(el, close)` wires it up; resolves with whatever close() receives.
 */
export function modal(markup, build) {
  return new Promise((resolve) => {
    const back = el(html`<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">${markup}</div></div>`);
    const box = back.firstElementChild;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      removeEventListener('keydown', onKey);
      back.classList.add('out');
      back.addEventListener('animationend', () => back.remove(), { once: true });
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    addEventListener('keydown', onKey);
    back.addEventListener('pointerdown', (e) => { if (e.target === back) close(null); });
    box.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    document.getElementById('overlays').append(back);
    build?.(box, close);
    box.querySelector('input, textarea')?.focus();
  });
}

export function confirmDialog({ title, message, confirm = 'Confirm', danger = false }) {
  return modal(html`
    <h3>${title}</h3><p>${message}</p>
    <div class="modal-actions">
      <button class="btn ghost" data-close>Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${confirm}</button>
    </div>`, (box, close) => box.querySelector('[data-ok]').addEventListener('click', () => close(true)));
}

/** fields: [{ name, label, type, value, textarea }] → resolves with { name: value } or null. */
export function formDialog({ title, message, fields, confirm = 'Save', validate }) {
  return modal(html`
    <h3>${title}</h3>${message ? html`<p>${message}</p>` : ''}
    <form>
      ${fields.map((f) => html`<div class="field">
        ${f.textarea
          ? html`<textarea name="${f.name}" placeholder=" ">${f.value || ''}</textarea>`
          : html`<input name="${f.name}" type="${f.type || 'text'}" value="${f.value || ''}" placeholder=" " autocomplete="off">`}
        <label>${f.label}</label></div>`)}
      <div class="form-error"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${confirm}</button>
      </div>
    </form>`, (box, close) => {
    const form = box.querySelector('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const err = validate ? await validate(values) : null;
      if (err) {
        const fe = form.querySelector('.form-error');
        fe.textContent = '';
        requestAnimationFrame(() => { fe.textContent = err; });
        return;
      }
      close(values);
    });
  });
}

// ───────── Ripple ─────────

addEventListener('pointerdown', (e) => {
  const target = e.target.closest('.btn, .icon-btn, .play-fab, .pb-play, .card-play, .chip');
  if (!target || document.body.classList.contains('reduce-motion')) return;
  const r = target.getBoundingClientRect();
  const size = Math.max(r.width, r.height);
  const rip = document.createElement('span');
  rip.className = 'ripple';
  rip.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  target.append(rip);
  rip.addEventListener('animationend', () => rip.remove(), { once: true });
});

// ───────── 3D tilt + spotlight on cards ─────────

let tiltEl = null;
addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  const card = e.target.closest?.('.card, .np-art');
  if (tiltEl && tiltEl !== card) resetTilt(tiltEl);
  tiltEl = card;
  if (!card || document.body.classList.contains('reduce-motion')) return;
  const r = card.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width, py = (e.clientY - r.top) / r.height;
  const max = card.classList.contains('np-art') ? 8 : 10;
  card.style.setProperty('--rx', `${(0.5 - py) * max}deg`);
  card.style.setProperty('--ry', `${(px - 0.5) * max}deg`);
  card.style.setProperty('--mx', `${px * 100}%`);
  card.style.setProperty('--my', `${py * 100}%`);
}, { passive: true });
function resetTilt(c) {
  c.style.setProperty('--rx', '0deg');
  c.style.setProperty('--ry', '0deg');
}
document.addEventListener('pointerleave', () => tiltEl && resetTilt(tiltEl));

// ───────── Drag to reorder ─────────

/** Makes children matching `selector` inside `container` drag-sortable. onMove(from, to). */
export function dragSort(container, selector, onMove) {
  let dragIdx = -1;
  const items = () => [...container.querySelectorAll(selector)];
  const clear = () => items().forEach((i) => i.classList.remove('drop-before', 'dragging'));
  container.addEventListener('dragstart', (e) => {
    const item = e.target.closest(selector);
    if (!item) return;
    dragIdx = items().indexOf(item);
    item.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragIdx));
  });
  container.addEventListener('dragover', (e) => {
    if (dragIdx < 0) return;
    e.preventDefault();
    const item = e.target.closest(selector);
    items().forEach((i) => i.classList.remove('drop-before'));
    if (item) item.classList.add('drop-before');
  });
  container.addEventListener('drop', (e) => {
    if (dragIdx < 0) return;
    e.preventDefault();
    const list = items();
    const item = e.target.closest(selector);
    let to = item ? list.indexOf(item) : list.length;
    if (to > dragIdx) to--;
    const from = dragIdx;
    dragIdx = -1;
    clear();
    if (to !== from && to >= 0) onMove(from, to);
  });
  container.addEventListener('dragend', () => { dragIdx = -1; clear(); });
}

export { esc };
