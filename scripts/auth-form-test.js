'use strict';

/**
 * Dom-level regression test for the Sign Up / Log In forms.
 *
 * Loads the real public/index.html + public/app.js in jsdom (no browser needed)
 * and exercises:
 *   - field presence + required flags for Log In and Sign Up
 *   - client-side validation (name, email, password length, confirm match)
 *   - the independent show/hide "eye" toggles (value + caret preserved,
 *     aria-label flips, no form submit, passwords hidden by default)
 *   - that a mismatched confirmation never reaches the server
 *   - that the confirm value / plain-text password are never part of the payload
 *     or written to the console
 *
 * Run with: node scripts/auth-form-test.js   (wired into `npm test`)
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

let failures = 0;
let checks = 0;

function ok(condition, message) {
  checks += 1;
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${message}`);
  }
}

function eq(actual, expected, message) {
  ok(actual === expected, `${message}${actual === expected ? '' : ` (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`}`);
}

/* ------------------------------------------------------------------ *
 * Harness: boot the SPA in jsdom with a scriptable fetch stub
 * ------------------------------------------------------------------ */

const calls = [];
let fetchImpl = () => ({ status: 200, body: {} });
const consoleLines = [];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let dom;
let win;

async function boot() {
  dom = new JSDOM(html, {
    url: 'http://localhost/#/auth',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    resources: undefined,
  });
  win = dom.window;

  // jsdom has no layout engine / media stack — stub the bits the SPA touches.
  win.scrollTo = () => {};
  win.HTMLMediaElement.prototype.pause = () => {};
  win.HTMLMediaElement.prototype.play = () => Promise.resolve();
  win.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  ['log', 'info', 'warn', 'error'].forEach((level) => {
    win.console[level] = (...args) => {
      consoleLines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
  });

  win.fetch = async (url, options = {}) => {
    const entry = { url: String(url), options };
    calls.push(entry);
    if (entry.url.includes('/api/meta')) {
      return jsonResponse(200, { categories: [], reportReasons: [], maxVideoMb: 80, user: null });
    }
    const result = fetchImpl(entry);
    return jsonResponse(result.status, result.body);
  };

  win.eval(appJs);

  // boot() kicks off an async /api/meta call, then renders the current route.
  await settle();
}

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function el(selector) {
  return win.document.querySelector(selector);
}

function click(node) {
  node.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

async function submitForm() {
  const form = el('#auth-form');
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
}

function type(selector, value) {
  const node = el(selector);
  node.value = value;
  node.dispatchEvent(new win.Event('input', { bubbles: true }));
}

const authCalls = () => calls.filter((c) => c.url.includes('/api/auth/'));
const errorText = () => (el('[data-error]') ? el('[data-error]').textContent : '');

/* ------------------------------------------------------------------ */

(async function run() {
  await boot();

  /* ---------------------------- Log In ---------------------------- */
  console.log('\nLog In form (default tab)');
  ok(!!el('#auth-form'), 'auth form renders at #/auth');
  eq(el('#auth-name'), null, 'no name field on the Log In form');
  eq(el('#auth-confirm'), null, 'no confirm-password field on the Log In form');

  const email = el('#auth-email');
  const password = el('#auth-password');
  ok(!!email && email.type === 'email', 'email input uses type="email"');
  ok(!!email && email.required, 'email is required');
  ok(!!password, 'password input exists');
  eq(password.type, 'password', 'password is hidden (type=password) by default');
  ok(password.required, 'password is required');

  const loginEyes = win.document.querySelectorAll('#auth-form .eye-btn');
  eq(loginEyes.length, 1, 'exactly one eye toggle on the Log In form');
  const loginEye = loginEyes[0];
  eq(loginEye.getAttribute('type'), 'button', 'eye toggle is type="button" (cannot submit the form)');
  eq(loginEye.getAttribute('aria-label'), 'Show password', 'eye toggle is labelled "Show password"');
  eq(loginEye.getAttribute('aria-pressed'), 'false', 'eye toggle reports aria-pressed="false"');
  eq(loginEye.getAttribute('aria-controls'), 'auth-password', 'eye toggle points at the password input');

  console.log('\nLog In: show/hide toggle');
  type('#auth-password', 'secret123');
  click(loginEye);
  eq(el('#auth-password').type, 'text', 'first click reveals the password');
  eq(el('#auth-password').value, 'secret123', 'revealing does not clear or change the value');
  eq(loginEye.getAttribute('aria-label'), 'Hide password', 'label flips to "Hide password"');
  eq(loginEye.getAttribute('aria-pressed'), 'true', 'aria-pressed flips to "true"');
  click(loginEye);
  eq(el('#auth-password').type, 'password', 'second click hides the password again');
  eq(el('#auth-password').value, 'secret123', 'value still unchanged after hiding');
  eq(loginEye.getAttribute('aria-label'), 'Show password', 'label flips back to "Show password"');
  eq(loginEye.getAttribute('aria-pressed'), 'false', 'aria-pressed back to "false"');
  click(loginEye);
  click(loginEye);
  click(loginEye);
  eq(el('#auth-password').value, 'secret123', 'value survives repeated toggles');
  eq(authCalls().length, 0, 'toggling visibility never submits / calls the auth API');

  console.log('\nLog In: validation');
  type('#auth-email', 'not-an-email');
  await submitForm();
  ok(/valid email/i.test(errorText()), 'invalid email is rejected with a readable message');
  eq(authCalls().length, 0, 'invalid email does not reach the server');
  ok(!!el('#auth-password'), 'form is still rendered after a validation error');

  type('#auth-email', 'meera@example.com');
  type('#auth-password', '');
  await submitForm();
  ok(/enter your password/i.test(errorText()), 'empty password is rejected');
  eq(authCalls().length, 0, 'empty password does not reach the server');

  console.log('\nLog In: submit payload + session');
  fetchImpl = () => ({ status: 401, body: { error: 'Email or password is incorrect.' } });
  type('#auth-password', 'wrongpass1');
  await submitForm();
  ok(/incorrect/i.test(errorText()), 'server error message is shown to the user');
  const failedLogin = authCalls().slice(-1)[0];
  eq(failedLogin.url, '/api/auth/login', 'login posts to /api/auth/login');
  const failedBody = JSON.parse(failedLogin.options.body);
  eq(Object.keys(failedBody).sort().join(','), 'email,password', 'login payload is email + password only (no name)');

  fetchImpl = () => ({
    status: 200,
    body: { token: 'tok_login', user: { id: 'usr_1', name: 'Meera K', handle: 'meera-k', role: 'creator', avatarColor: '#6366f1' } },
  });
  type('#auth-password', 'secret123');
  await submitForm();
  eq(win.localStorage.getItem('ts_token'), 'tok_login', 'successful login stores the session token');

  /* ---------------------------- Sign Up --------------------------- */
  console.log('\nSign Up form');
  // Fresh page so the session from the login test above does not redirect
  // #/auth straight to the profile.
  await boot();
  click(win.document.querySelector('[data-mode="signup"]'));
  await settle();

  const nameInput = el('#auth-name');
  const confirmInput = el('#auth-confirm');
  const pw = el('#auth-password');
  ok(!!nameInput, 'Sign Up shows a full-name field');
  ok(!!nameInput && nameInput.required, 'full name is required');
  ok(/full name/i.test((el('label[for="auth-name"]') || {}).textContent || ''), 'name label reads "Full name"');
  ok(!!pw && pw.required, 'password is required');
  ok(!!confirmInput, 'Sign Up shows a confirm-password field');
  ok(!!confirmInput && confirmInput.required, 'confirm password is required');
  eq(pw.type, 'password', 'password starts hidden');
  eq(confirmInput.type, 'password', 'confirm password starts hidden');
  eq(el('#auth-email').value, 'meera@example.com', 'email typed earlier is preserved when switching tabs');

  const eyes = Array.from(win.document.querySelectorAll('#auth-form .eye-btn'));
  eq(eyes.length, 2, 'Sign Up has two separate eye toggles');
  const pwEye = eyes.find((b) => b.dataset.toggle === 'auth-password');
  const confirmEye = eyes.find((b) => b.dataset.toggle === 'auth-confirm');
  ok(!!pwEye && !!confirmEye, 'one eye toggle controls password, the other controls confirm password');
  eq(pwEye.getAttribute('aria-label'), 'Show password', 'password eye is labelled "Show password"');
  eq(confirmEye.getAttribute('aria-label'), 'Show confirm password', 'confirm eye is labelled "Show confirm password"');
  eq(pwEye.getAttribute('type'), 'button', 'password eye is type="button"');
  eq(confirmEye.getAttribute('type'), 'button', 'confirm eye is type="button"');

  console.log('\nSign Up: independent toggles preserve values');
  type('#auth-password', 'secret123');
  type('#auth-confirm', 'secret123');
  const before = authCalls().length;

  click(confirmEye);
  eq(el('#auth-confirm').type, 'text', 'confirm eye reveals only the confirm field');
  eq(el('#auth-password').type, 'password', 'password field stays hidden');
  eq(el('#auth-confirm').value, 'secret123', 'confirm value is preserved when revealed');
  eq(el('#auth-password').value, 'secret123', 'password value is untouched');
  eq(confirmEye.getAttribute('aria-label'), 'Hide confirm password', 'confirm eye label flips to "Hide confirm password"');

  click(pwEye);
  eq(el('#auth-password').type, 'text', 'password eye reveals the password field');
  eq(el('#auth-confirm').type, 'text', 'confirm stays visible (independent state)');
  eq(el('#auth-password').value, 'secret123', 'password value preserved when revealed');
  eq(el('#auth-confirm').value, 'secret123', 'confirm value preserved');

  click(confirmEye);
  eq(el('#auth-confirm').type, 'password', 'confirm eye hides only confirm');
  eq(el('#auth-password').type, 'text', 'password stays visible while confirm is hidden');
  click(pwEye);
  eq(el('#auth-password').type, 'password', 'password eye hides the password');
  eq(el('#auth-password').value, 'secret123', 'value survives both toggles');
  eq(el('#auth-confirm').value, 'secret123', 'confirm value survives both toggles');
  eq(authCalls().length, before, 'no auth API call was made by any toggle');

  console.log('\nSign Up: validation');
  type('#auth-name', '');
  await submitForm();
  ok(/full name/i.test(errorText()), 'missing full name is rejected');
  eq(authCalls().length, before, 'missing name does not reach the server');

  type('#auth-name', 'Meera K');
  type('#auth-email', 'meera@');
  await submitForm();
  ok(/valid email/i.test(errorText()), 'invalid email is rejected');

  type('#auth-email', 'meera@example.com');
  type('#auth-password', 'short');
  type('#auth-confirm', 'short');
  await submitForm();
  ok(/at least 8/i.test(errorText()), 'password shorter than 8 characters is rejected');

  type('#auth-password', 'secret123');
  type('#auth-confirm', 'secret124');
  await submitForm();
  ok(/do not match/i.test(errorText()), 'mismatched passwords are rejected');
  eq(authCalls().length, before, 'mismatched passwords never reach the server');

  type('#auth-confirm', '');
  await submitForm();
  ok(/confirm/i.test(errorText()), 'empty confirmation is rejected');

  console.log('\nSign Up: successful registration payload');
  fetchImpl = () => ({
    status: 201,
    body: { token: 'tok_signup', user: { id: 'usr_2', name: 'Meera K', handle: 'meera-k', role: 'creator', avatarColor: '#6366f1' } },
  });
  type('#auth-confirm', 'secret123');
  await submitForm();

  const signupCall = authCalls().slice(-1)[0];
  eq(signupCall.url, '/api/auth/signup', 'signup posts to /api/auth/signup');
  const signupBody = JSON.parse(signupCall.options.body);
  eq(Object.keys(signupBody).sort().join(','), 'email,name,password', 'signup payload carries name + email + password');
  eq(signupBody.name, 'Meera K', 'full name is sent to the server');
  eq(signupBody.email, 'meera@example.com', 'email is sent to the server');
  ok(!('confirmPassword' in signupBody) && !('confirm' in signupBody), 'confirm password is never sent or stored');
  eq(win.localStorage.getItem('ts_token'), 'tok_signup', 'registration stores the session token');

  console.log('\nSecurity: no plain-text password in console output');
  const leaked = consoleLines.filter((line) => line.includes('secret123'));
  eq(leaked.length, 0, 'password never appears in console output');

  /* ---------------------------- summary --------------------------- */
  console.log(`\n${checks - failures}/${checks} auth-form checks passed`);
  if (failures) {
    console.error(`\n${failures} auth-form check(s) FAILED`);
    process.exit(1);
  }
  console.log('Auth form test passed.');
  process.exit(0);
})().catch((err) => {
  console.error('Auth form test crashed:', err);
  process.exit(1);
});
