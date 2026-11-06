// Sign-in and first-run setup screens.
import { api } from '../api.js';
import { html, el } from '../util.js';

const logo = html`<div class="logo-mark big"><span></span><span></span><span></span><span></span><span></span></div>`;

export function authView({ setup, onDone }) {
  const v = el(html`<div class="auth"><div class="auth-card">
    ${logo}
    <h1>${setup ? 'Welcome to Sonara' : 'Sonara'}</h1>
    <p class="sub">${setup ? 'Create the admin account to get started.' : 'Sign in to your music.'}</p>
    <form>
      <div class="field"><input name="username" autocomplete="username" placeholder=" " required><label>Username</label></div>
      <div class="field"><input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder=" " required><label>Password</label></div>
      ${setup ? html`<div class="field"><input name="confirm" type="password" autocomplete="new-password" placeholder=" " required><label>Confirm password</label></div>` : ''}
      <div class="form-error"></div>
      <button class="btn primary" type="submit">${setup ? 'Create account' : 'Sign in'}</button>
    </form>
  </div></div>`);
  const form = v.querySelector('form');
  const err = v.querySelector('.form-error');
  const fail = (msg) => { err.textContent = ''; requestAnimationFrame(() => { err.textContent = msg; }); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (setup && data.password !== data.confirm) return fail('Passwords do not match');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { user } = await api.post(setup ? '/auth/setup' : '/auth/login', { username: data.username, password: data.password });
      v.querySelector('.auth-card').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(1.05)', filter: 'blur(8px)' }], { duration: 350, easing: 'ease-in', fill: 'forwards' })
        .finished.then(() => onDone(user));
    } catch (ex) {
      fail(ex.message);
      btn.disabled = false;
    }
  });
  return v;
}
