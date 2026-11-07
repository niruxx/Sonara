// Sign-in and first-run setup screens (password, two-factor code, single sign-on).
import { api } from '../api.js';
import { html, el } from '../util.js';

const logo = html`<div class="logo-mark big"><span></span><span></span><span></span><span></span><span></span></div>`;

export function authView({ setup, onDone, passwordLogin = true, oidc = null }) {
  const loginError = new URLSearchParams(location.search).get('loginError');
  if (loginError) history.replaceState(null, '', '/');
  const showPassword = setup || passwordLogin;
  const v = el(html`<div class="auth"><div class="auth-card">
    ${logo}
    <h1>${setup ? 'Welcome to Sonara' : 'Sonara'}</h1>
    <p class="sub">${setup ? 'Create the admin account to get started.' : 'Sign in to your music.'}</p>
    ${showPassword ? html`<form>
      <div class="field"><input name="username" autocomplete="username" placeholder=" " required><label>Username</label></div>
      <div class="field"><input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" placeholder=" " required><label>Password</label></div>
      ${setup ? html`<div class="field"><input name="confirm" type="password" autocomplete="new-password" placeholder=" " required><label>Confirm password</label></div>` : ''}
      <div class="field" data-code-field hidden><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder=" "><label>6-digit code from your authenticator app</label></div>
      <div class="form-error">${loginError || ''}</div>
      <button class="btn primary" type="submit">${setup ? 'Create account' : 'Sign in'}</button>
    </form>` : html`<div class="form-error">${loginError || ''}</div>`}
    ${oidc && !setup ? html`${showPassword ? html`<div class="auth-or"><span>or</span></div>` : ''}
      <a class="btn ${showPassword ? '' : 'primary'}" href="/api/auth/oidc/start" style="width:100%;justify-content:center">${oidc.label}</a>` : ''}
  </div></div>`);
  const form = v.querySelector('form');
  if (!form) return v;
  const err = v.querySelector('.form-error');
  const codeField = v.querySelector('[data-code-field]');
  const fail = (msg) => { err.textContent = ''; requestAnimationFrame(() => { err.textContent = msg; }); };
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (setup && data.password !== data.confirm) return fail('Passwords do not match');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const body = { username: data.username, password: data.password };
      if (!codeField.hidden) body.code = data.code;
      const { user } = await api.post(setup ? '/auth/setup' : '/auth/login', body);
      v.querySelector('.auth-card').animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(1.05)', filter: 'blur(8px)' }], { duration: 350, easing: 'ease-in', fill: 'forwards' })
        .finished.then(() => onDone(user));
    } catch (ex) {
      if (ex.data?.needCode && codeField.hidden) {
        codeField.hidden = false;
        codeField.querySelector('input').focus();
        err.textContent = '';
      } else fail(ex.message);
      btn.disabled = false;
    }
  });
  return v;
}
