// End-to-end tests for adding/removing pages via the Alt+Shift+C context menu:
// the real content script talks to the real background worker (fake OpenAI).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, loadContentScript, settle } = require('./helpers');

function article(topic) {
  const body = Array.from({ length: 8 }, (_, i) =>
    `<p>The ${topic} ${topic}s paragraph ${i} explains ${topic} in some detail for readers.</p>`).join('');
  return `<!doctype html><html><head><title>${topic} article</title></head><body><h1>${topic}</h1>${body}</body></html>`;
}

// A browser tab on `url`, wired to the shared background `bg`
function openTab(bg, url, html) {
  const tab = loadContentScript(html || article(url.split('/').pop() || 'home'), url);
  tab.window.__readieReply = (msg) => bg.send(msg, { tab: { id: 1, url: tab.window.location.href } });
  return tab;
}

// Wait until the background has finished (indexing is async)
async function until(fn, ms = 3000) {
  const start = Date.now();
  while (!(await fn())) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await settle(10);
  }
}

async function openMenu(tab) {
  await tab.window.toggleContextMenu();
  const menu = tab.window.document.getElementById('readie-context-menu');
  assert.ok(menu, 'menu opened');
  return menu;
}

const labels = (menu) => [...menu.querySelectorAll('.readie-menu-label')].map(e => e.textContent);

function press(tab, key) {
  tab.window.document.dispatchEvent(new tab.window.KeyboardEvent('keydown', { key, bubbles: true }));
}

const toast = (tab) => tab.window.document.getElementById('readie-toast')?.textContent || '';

function setup() {
  const bg = loadBackground({ sync: { openaiApiKey: 'sk-test' } });
  const kb = () => bg.get('RAG').getKb();
  return { bg, kb };
}

test('menu on a new page offers to add it; pressing 1 adds it to context', async () => {
  const { bg, kb } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');

  const menu = await openMenu(tab);
  assert.match(menu.textContent, /Current context is empty/);
  assert.deepEqual(labels(menu), ['Add this page to context', 'New context window with this page',
    'New empty context window', 'Open chat']);

  press(tab, '1');
  assert.equal(tab.window.document.getElementById('readie-context-menu'), null, 'menu closes');
  await until(async () => (await kb()).docs.length === 1);
  await until(() => /Added:/.test(toast(tab)));

  const doc = (await kb()).docs[0];
  assert.equal(doc.url, 'https://site.com/volcano');
  assert.equal(doc.title, 'volcano article');
  assert.match(toast(tab), /“volcano article” — \d+ chunks\. 1 page in context\./);
  assert.equal(bg.badge.text, '1');
});

test('once added, the menu offers re-index and remove; re-index does not duplicate', async () => {
  const { bg, kb } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');
  await tab.window.addCurrentPage(false);

  const menu = await openMenu(tab);
  assert.match(menu.textContent, /Current context: 1 page · 0 messages/);
  assert.deepEqual(labels(menu).slice(0, 2), ['Re-index this page', 'Remove this page from context']);

  press(tab, '1'); // re-index
  await until(() => /Added:/.test(toast(tab)));
  await settle(50);
  assert.equal((await kb()).docs.length, 1);
});

test('"Remove this page" takes it out of context', async () => {
  const { bg, kb } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');
  await tab.window.addCurrentPage(false);

  await openMenu(tab);
  press(tab, '2');
  await until(async () => (await kb()).docs.length === 0);
  assert.equal(bg.badge.text, '');
  await settle();
  assert.match(toast(tab), /Removed this page/);

  // Menu is back to "Add"
  assert.equal(labels(await openMenu(tab))[0], 'Add this page to context');
});

test('pages from several tabs share one context; removing one keeps the others', async () => {
  const { bg, kb } = setup();
  const a = openTab(bg, 'https://site.com/volcano');
  const b = openTab(bg, 'https://other.org/violin');
  await a.window.addCurrentPage(false);
  await b.window.addCurrentPage(false);
  assert.match(toast(b), /2 pages in context/);

  // Tab A sees both pages
  assert.match((await openMenu(a)).textContent, /Current context: 2 pages/);
  press(a, '2'); // remove volcano
  await until(async () => (await kb()).docs.length === 1);
  assert.equal((await kb()).docs[0].url, 'https://other.org/violin');
});

test('"New context window with this page" forgets old pages and the conversation', async () => {
  const { bg, kb } = setup();
  const a = openTab(bg, 'https://site.com/volcano');
  await a.window.addCurrentPage(false);
  await bg.send({ action: 'ask', question: 'about volcanoes?' });

  const b = openTab(bg, 'https://other.org/violin');
  const menu = await openMenu(b);
  assert.match(menu.textContent, /1 page · 2 messages/);
  press(b, '2'); // New context window with this page
  await until(() => /New context window:/.test(toast(b)));

  const now = await kb();
  assert.deepEqual(now.docs.map(d => d.url), ['https://other.org/violin']);
  assert.equal((await bg.get('RAG').getMessages()).length, 0);
});

test('"New empty context window" clears everything', async () => {
  const { bg, kb } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');
  await tab.window.addCurrentPage(false);
  await bg.send({ action: 'ask', question: 'hi' });

  await openMenu(tab);
  press(tab, '4'); // with the page included: re-index, remove, new with page, new empty
  await until(async () => (await kb()).docs.length === 0);
  assert.equal((await bg.get('RAG').getMessages()).length, 0);
  await settle();
  assert.match(toast(tab), /new, empty context/);
});

test('in-page #anchors count as the same page', async () => {
  const { bg } = setup();
  const tab = openTab(bg, 'https://site.com/volcano#intro');
  await tab.window.addCurrentPage(false);
  const other = openTab(bg, 'https://site.com/volcano#results');
  assert.equal(labels(await openMenu(other))[0], 'Re-index this page');
});

test('Escape and clicking outside close the menu without changing anything', async () => {
  const { bg, kb } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');
  await openMenu(tab);
  press(tab, 'Escape');
  assert.equal(tab.window.document.getElementById('readie-context-menu'), null);

  await openMenu(tab);
  tab.window.document.body.dispatchEvent(new tab.window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(tab.window.document.getElementById('readie-context-menu'), null);
  assert.equal((await kb()).docs.length, 0);
});

test('the shortcut toggles the menu open and closed', async () => {
  const { bg } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');
  await tab.window.toggleContextMenu();
  assert.ok(tab.window.document.getElementById('readie-context-menu'));
  await tab.window.toggleContextMenu();
  assert.equal(tab.window.document.getElementById('readie-context-menu'), null);
});

test('adding without an API key shows an error and adds nothing', async () => {
  const bg = loadBackground();
  const tab = openTab(bg, 'https://site.com/volcano');
  tab.window.console.error = () => {};
  await tab.window.addCurrentPage(false);
  assert.match(toast(tab), /Could not add page: OpenAI API key not configured/);
  assert.equal((await bg.get('RAG').getKb()).docs.length, 0);
});

test('a second add while one is still indexing is refused, not doubled', async () => {
  const { bg, kb } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');
  const first = tab.window.addCurrentPage(false);
  await tab.window.addCurrentPage(false);
  assert.match(toast(tab), /busy/);
  await first;
  assert.equal((await kb()).docs.length, 1);
});

test('the chat panel shows the pages in context after adding', async () => {
  const { bg } = setup();
  const tab = openTab(bg, 'https://site.com/volcano');
  await tab.window.openPanel();
  assert.match(tab.window.document.querySelector('.readie-sources').textContent, /No pages in context/);

  await tab.window.addCurrentPage(false);
  await until(() => /1 page in context/.test(tab.window.document.querySelector('.readie-sources').textContent));
});
