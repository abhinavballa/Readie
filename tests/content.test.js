// Tests for extension/content.js: page text extraction, rendering safety, and the chat panel.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadContentScript, settle } = require('./helpers');

const EMPTY_SESSION = { docs: [], messages: [], messageCount: 0, words: 0, chunkCount: 0 };

function page(body, title = 'Test page') {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}

test('extractPageText marks headings and skips menus, scripts and hidden parts', () => {
  const { window } = loadContentScript(page(`
    <nav>Home About Contact</nav>
    <h1>Main Title</h1>
    <p>First paragraph.</p>
    <script>var secret = 1;</script>
    <div aria-hidden="true">hidden stuff</div>
    <h2>  Second   section </h2>
    <ul><li>one</li><li>two</li></ul>
    <footer>Copyright</footer>
    <div id="readie-query-panel">Readie UI text</div>
  `));
  const text = window.extractPageText();
  assert.match(text, /^## Main Title\n+First paragraph\./);
  assert.match(text, /\n## Second section\n/);
  assert.match(text, /one\n+two/);
  for (const bad of ['Home About', 'secret', 'hidden stuff', 'Copyright', 'Readie UI text']) {
    assert.ok(!text.includes(bad), `should skip "${bad}"`);
  }
  assert.ok(!/\n{3,}/.test(text), 'no runs of blank lines');
});

test('extractPageText prefers the main article over the rest of the page', () => {
  const { window } = loadContentScript(page(`
    <div class="sidebar">Sidebar links and ads.</div>
    <article><h1>Story</h1><p>${'Body text of the story. '.repeat(30)}</p></article>
  `));
  const text = window.extractPageText();
  assert.match(text, /^## Story/);
  assert.ok(!text.includes('Sidebar links'));
});

test('a tiny <article> (e.g. a card) does not replace the whole page', () => {
  const { window } = loadContentScript(page(`
    <article>Card</article>
    <p>${'Main page content here. '.repeat(30)}</p>
  `));
  assert.match(window.extractPageText(), /Main page content here/);
});

test('isPdfPage detects Chrome\'s PDF viewer', () => {
  const pdf = loadContentScript(page('<embed type="application/pdf" src="x.pdf">'));
  assert.equal(pdf.window.isPdfPage(), true);
  const html = loadContentScript(page('<p>Hello</p><p>a</p><p>b</p>'));
  assert.equal(html.window.isPdfPage(), false);
});

test('escapeHtml neutralises markup and quotes', () => {
  const { window } = loadContentScript();
  assert.equal(window.escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(window.escapeHtml(null), '');
});

test('parseMarkdownContent renders code blocks and inline code without allowing HTML', () => {
  const { window } = loadContentScript();
  const html = window.parseMarkdownContent(
    'Use `npm test`.\n```js\nconst a = "<b>";\nif (a) {}\n```\n<script>alert(1)</script>');
  assert.match(html, /<code class="readie-inline-code">npm test<\/code>/);
  assert.match(html, /data-language="js"/);
  assert.match(html, /const a = &quot;&lt;b&gt;&quot;;\nif/, 'newlines kept inside code');
  assert.ok(!html.includes('<script>'));
  assert.match(html, /<br>/, 'newlines outside code become <br>');
});

test('opening the panel loads the conversation from the background', async () => {
  const { window, sent } = loadContentScript();
  window.__readieReply = (msg) => msg.action === 'getSession'
    ? { ...EMPTY_SESSION, messages: [
      { role: 'user', content: 'What is <b>this</b>?' },
      { role: 'assistant', content: 'An answer.', meta: { model: 'gpt-4o', tokens: 10 } }
    ], messageCount: 2 }
    : {};

  await window.openPanel();
  const doc = window.document;
  assert.ok(doc.getElementById('readie-query-panel'));
  assert.ok(sent.some(m => m.action === 'getSession'));

  const msgs = doc.querySelectorAll('.readie-message');
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].innerHTML, /What is &lt;b&gt;this&lt;\/b&gt;\?/, 'user text is escaped');
  assert.match(msgs[1].textContent, /An answer\./);
});

test('asking a question sends it with the selection and shows the answer', async () => {
  const { window, sent, run } = loadContentScript();
  window.__readieReply = (msg) => {
    if (msg.action === 'getSession') return EMPTY_SESSION;
    if (msg.action === 'ask') {
      return {
        userMessage: { role: 'user', content: msg.question },
        assistantMessage: { id: 7, role: 'assistant', content: 'Here is the explanation.',
          meta: { model: 'gpt-4o', tokens: 99, excerpts: 2, sources: ['page 3'] } }
      };
    }
    return {};
  };

  await window.openPanel();
  run(`pendingSelection = { image: 'data:image/png;base64,QQ==', pageUrl: location.href, pageTitle: 'T' }`);
  const doc = window.document;
  doc.getElementById('readie-question-input').value = '  Explain this  ';
  await window.submitQuestion();

  const ask = sent.find(m => m.action === 'ask');
  assert.equal(ask.question, 'Explain this');
  assert.equal(ask.selection.image, 'data:image/png;base64,QQ==');

  const text = doc.getElementById('readie-chat-history').textContent;
  assert.match(text, /Explain this/);
  assert.match(text, /Here is the explanation\./);
  assert.match(text, /2 excerpts \(page 3\)/);
  assert.equal(doc.querySelector('.readie-loading, .readie-message-loading'), null, 'loading indicator removed');
  assert.equal(doc.getElementById('readie-question-input').value, '');
  assert.equal(run('pendingSelection'), null, 'selection is used once');
});

test('a failed question shows the error and keeps the selection for a retry', async () => {
  const { window, run } = loadContentScript();
  window.__readieReply = (msg) => msg.action === 'getSession' ? EMPTY_SESSION
    : msg.action === 'ask' ? { error: 'Rate limit reached' } : {};

  await window.openPanel();
  run(`pendingSelection = { image: 'data:image/png;base64,QQ==', pageTitle: 'T' }`);
  window.document.getElementById('readie-question-input').value = 'Why?';
  await window.submitQuestion();

  assert.match(window.document.getElementById('readie-chat-history').textContent, /Rate limit reached/);
  assert.ok(run('pendingSelection'), 'selection restored');
  assert.equal(window.document.getElementById('readie-submit-btn').disabled, false);
});

test('empty questions are not sent', async () => {
  const { window, sent } = loadContentScript();
  window.__readieReply = () => EMPTY_SESSION;
  await window.openPanel();
  window.document.getElementById('readie-question-input').value = '   ';
  await window.submitQuestion();
  assert.ok(!sent.some(m => m.action === 'ask'));
});

test('the sources list shows pages in context and can remove one', async () => {
  const { window, sent } = loadContentScript();
  const session = { ...EMPTY_SESSION, words: 1234, docs: [
    { url: 'https://x.org/p.pdf', title: 'Paper <1>', source: 'pdf', numPages: 12, chunkCount: 30, truncated: false }
  ] };
  window.__readieReply = (msg) => msg.action === 'getSession' ? session : {};
  await window.openPanel();

  const sources = window.document.querySelector('.readie-sources');
  assert.match(sources.textContent, /1 page in context · 1,234 words/);
  assert.match(sources.innerHTML, /Paper &lt;1&gt;/);
  assert.match(sources.textContent, /12 pp · 30 chunks/);

  sources.querySelector('[data-remove-url]').click();
  await settle();
  const remove = sent.find(m => m.action === 'removePage');
  assert.equal(remove.pageUrl, 'https://x.org/p.pdf');
});

test('adding the current web page sends its text and title', async () => {
  const { window, sent } = loadContentScript(page('<h1>Doc</h1><p>Some body text.</p>', 'My Doc'));
  window.__readieReply = (msg) => msg.action === 'addWebPage'
    ? { ...EMPTY_SESSION, added: { title: 'My Doc', chunkCount: 1, words: 3 }, docs: [{}] }
    : EMPTY_SESSION;

  await window.addCurrentPage(false);
  const add = sent.find(m => m.action === 'addWebPage');
  assert.equal(add.title, 'My Doc');
  assert.equal(add.fresh, false);
  assert.match(add.text, /## Doc\n+Some body text\./);
});
