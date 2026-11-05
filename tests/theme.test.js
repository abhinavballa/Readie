// Tests for the configurable theme: theme.js, theme.css, overlay.css and the popup.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');
const { loadContentScript, settle } = require('./helpers');

const EXT = path.join(__dirname, '..', 'extension');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');
const attrs = (window) => ({
  theme: window.document.documentElement.getAttribute('data-readie-theme'),
  accent: window.document.documentElement.getAttribute('data-readie-accent')
});

test('pages default to the system theme and blue accent', async () => {
  const { window } = loadContentScript();
  await settle();
  assert.deepEqual(attrs(window), { theme: 'system', accent: 'blue' });
});

test('saved theme and accent are applied on page load', async () => {
  const { window } = loadContentScript(undefined, undefined, { sync: { theme: 'dark', accent: 'rose' } });
  await settle();
  assert.deepEqual(attrs(window), { theme: 'dark', accent: 'rose' });
});

test('unknown saved values fall back to the defaults', async () => {
  const { window } = loadContentScript(undefined, undefined, { sync: { theme: 'neon', accent: 'chartreuse' } });
  await settle();
  assert.deepEqual(attrs(window), { theme: 'system', accent: 'blue' });
});

test('changing the theme in settings updates open pages live', async () => {
  const { window, chrome } = loadContentScript();
  await settle();
  await chrome.storage.sync.set({ theme: 'light', accent: 'green' });
  for (const fn of chrome.storage.onChanged.listeners) {
    fn({ theme: { newValue: 'light' }, accent: { newValue: 'green' } }, 'sync');
  }
  await settle();
  assert.deepEqual(attrs(window), { theme: 'light', accent: 'green' });

  // Unrelated changes are ignored
  await chrome.storage.sync.set({ theme: 'dark' });
  for (const fn of chrome.storage.onChanged.listeners) fn({ openaiApiKey: {} }, 'sync');
  await settle();
  assert.equal(attrs(window).theme, 'light');
});

// ---------- CSS ----------

function tokenBlock(css, selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, 'missing ' + selector);
  const body = css.slice(start, css.indexOf('}', start));
  return new Set(body.match(/--readie-[a-z0-9-]+(?=:)/g));
}

test('dark mode defines every color the light theme defines', () => {
  const css = read('theme.css');
  const light = tokenBlock(css, ':root');
  const darkExplicit = tokenBlock(css, ':root[data-readie-theme="dark"]');
  const darkSystem = tokenBlock(css, ':root:not([data-readie-theme="light"])');

  light.delete('--readie-accent'); // the accent is shared by both themes
  for (const t of light) {
    assert.ok(darkExplicit.has(t), `${t} missing from dark theme`);
    assert.ok(darkSystem.has(t), `${t} missing from system-dark theme`);
  }
  assert.deepEqual([...darkExplicit].sort(), [...darkSystem].sort(), 'both dark blocks match');
});

test('every accent in theme.js has a color in theme.css and a swatch in the popup', () => {
  const ctx = vm.createContext({ document: { documentElement: { setAttribute() {} } }, chrome: undefined });
  vm.runInContext(read('theme.js'), ctx);
  const accents = vm.runInContext('READIE_ACCENTS', ctx);
  const css = read('theme.css');
  const popup = read('popup.html');
  for (const a of accents) {
    assert.match(css, new RegExp(`data-readie-accent="${a}"\\]\\s*\\{ --readie-accent: #`), a);
    assert.match(popup, new RegExp(`name="accent" value="${a}"`), a);
  }
});

test('every variable used in the stylesheets is defined', () => {
  const defined = new Set(read('theme.css').match(/--readie-[a-z0-9-]+(?=:)/g));
  for (const file of ['overlay.css', 'popup.html']) {
    for (const used of read(file).matchAll(/var\((--readie-[a-z0-9-]+)\)/g)) {
      assert.ok(defined.has(used[1]), `${file} uses undefined ${used[1]}`);
    }
  }
});

test('overlay.css has no hard-coded theme colors outside the code blocks', () => {
  const css = read('overlay.css');
  const outside = css.slice(0, css.indexOf('/* Code Block Styles */')) +
    css.slice(css.indexOf('/* ---------- Session UI'));
  const leftovers = outside.split('\n')
    .filter(l => /#[0-9a-fA-F]{3,8}\b|:\s*white\b/.test(l))
    .filter(l => !l.includes('#readie-'))           // id selectors
    .filter(l => !/color: #ffffff;/.test(l));       // toast text, white on both themes
  assert.deepEqual(leftovers, []);
});

test('the manifest loads the theme before the other styles and scripts', () => {
  const cs = JSON.parse(read('manifest.json')).content_scripts[0];
  assert.equal(cs.js[0], 'theme.js');
  assert.equal(cs.css[0], 'theme.css');
});

// ---------- Popup ----------

async function loadPopup(sync = {}) {
  const html = read('popup.html')
    .replace(/<link rel="stylesheet"[^>]*>/, '')
    .replace(/<script src="[^"]*"><\/script>/g, '');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://test/popup.html' });
  const { window } = dom;
  const store = { ...sync };
  const changed = [];
  window.chrome = {
    storage: {
      sync: {
        async get(keys) { const o = {}; for (const k of [].concat(keys)) if (k in store) o[k] = store[k]; return o; },
        async set(items) { Object.assign(store, items); changed.push(items); }
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      async sendMessage(msg) {
        if (msg.action === 'getSession') return { docs: [], messageCount: 0 };
        if (msg.action === 'getTrainingStats') return { satisfactory: 0, unsatisfactory: 0, total: 0 };
        return {};
      }
    }
  };
  const ctx = dom.getInternalVMContext();
  new vm.Script(read('theme.js')).runInContext(ctx);
  new vm.Script(read('popup.js')).runInContext(ctx);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle(50);
  return { window, store, changed };
}

test('the popup shows the saved theme and saves a new choice', async () => {
  const { window, store } = await loadPopup({ theme: 'dark', accent: 'purple' });
  const doc = window.document;
  assert.equal(doc.querySelector('input[name="theme"]:checked').value, 'dark');
  assert.equal(doc.querySelector('input[name="accent"]:checked').value, 'purple');
  assert.deepEqual(attrs(window), { theme: 'dark', accent: 'purple' });

  const light = doc.querySelector('input[name="theme"][value="light"]');
  light.checked = true;
  light.dispatchEvent(new window.Event('change'));
  const orange = doc.querySelector('input[name="accent"][value="orange"]');
  orange.checked = true;
  orange.dispatchEvent(new window.Event('change'));
  await settle();

  assert.equal(store.theme, 'light');
  assert.equal(store.accent, 'orange');
  assert.deepEqual(attrs(window), { theme: 'light', accent: 'orange' }, 'popup updates itself right away');
});

test('the popup defaults to System and Blue', async () => {
  const { window } = await loadPopup();
  assert.equal(window.document.querySelector('input[name="theme"]:checked').value, 'system');
  assert.equal(window.document.querySelector('input[name="accent"]:checked').value, 'blue');
});
