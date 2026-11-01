// Tests for extension/background.js: message handlers, PDF flow, prompts and history.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, settle } = require('./helpers');

const API = { openaiApiKey: 'sk-test' };

function paragraph(topic, n = 6) {
  return Array.from({ length: n }, (_, i) =>
    `The ${topic} ${topic}s topic sentence ${i} describes ${topic} carefully and at length.`).join(' ');
}

const ARTICLE = `## Overview\n${paragraph('neuron')}\n## Training\n${paragraph('gradient')}\n## Results\n${paragraph('accuracy')}`;

function setup(opts = {}) {
  return loadBackground({ sync: { ...API }, ...opts });
}

// Chat requests that are the main answer (not the screenshot transcription)
const answerCalls = (openai) => openai.calls.chat.filter(c => c.model === 'gpt-4o');

test('getSession on a fresh install is empty', async () => {
  const { send } = setup();
  const s = await send({ action: 'getSession' });
  assert.equal(s.docs.length, 0);
  assert.equal(s.messageCount, 0);
  assert.deepEqual([...s.messages], []);
  assert.equal(s.mode, 'keep');
  assert.equal(s.currentPageIncluded, false);
});

test('addWebPage indexes the page, ignores #fragments, and updates the badge', async () => {
  const { send, badge } = setup();
  const res = await send({ action: 'addWebPage', title: '  Neural Nets  ', text: ARTICLE },
    { tab: { id: 1, url: 'https://ex.com/post#section-2' } });

  assert.equal(res.error, undefined);
  assert.equal(res.docs.length, 1);
  assert.equal(res.added.url, 'https://ex.com/post');
  assert.equal(res.added.title, 'Neural Nets');
  assert.equal(res.added.source, 'webpage');
  assert.ok(res.chunkCount >= 3);
  assert.equal(badge.text, '1');

  // Same page with a different anchor counts as included
  const s = await send({ action: 'getSession' }, { tab: { id: 1, url: 'https://ex.com/post#other' } });
  assert.equal(s.currentPageIncluded, true);
});

test('page title falls back to the URL', async () => {
  const { send } = setup();
  const res = await send({ action: 'addWebPage', title: '', text: ARTICLE },
    { tab: { id: 1, url: 'https://ex.com/untitled' } });
  assert.equal(res.added.title, 'https://ex.com/untitled');
});

test('addWebPage with fresh=true starts a new context first', async () => {
  const { send, get } = setup();
  await send({ action: 'addWebPage', title: 'A', text: ARTICLE }, { tab: { url: 'https://a.com/' } });
  await get('RAG').addMessage({ role: 'user', content: 'old question' });

  const res = await send({ action: 'addWebPage', title: 'B', text: ARTICLE, fresh: true },
    { tab: { url: 'https://b.com/' } });
  assert.deepEqual(res.docs.map(d => d.url), ['https://b.com/']);
  assert.equal(res.messageCount, 0);
});

test('without an API key, adding a page and asking both fail clearly', async () => {
  const { send } = loadBackground();
  const a = await send({ action: 'addWebPage', title: 'A', text: ARTICLE });
  assert.match(a.error, /API key not configured/);
  const b = await send({ action: 'ask', question: 'hi' });
  assert.match(b.error, /API key not configured/);
});

test('addPdf extracts via the offscreen document, labels pages, then closes it', async () => {
  const pdf = {
    title: 'A Paper',
    numPages: 3,
    truncated: false,
    pages: [
      { page: 1, text: paragraph('abstract') },
      { page: 2, text: paragraph('method') },
      { page: 3, text: paragraph('conclusion') }
    ]
  };
  let request = null;
  const { send, offscreen, get } = setup({ pdfResult: (msg) => { request = msg; return pdf; } });

  const res = await send({ action: 'addPdf', title: 'paper.pdf' }, { tab: { url: 'https://x.org/paper.pdf' } });
  assert.equal(res.error, undefined);
  assert.equal(res.added.title, 'A Paper', 'PDF metadata title wins');
  assert.equal(res.added.source, 'pdf');
  assert.equal(res.added.numPages, 3);
  assert.equal(request.action, 'extractPdfText');
  assert.equal(request.url, 'https://x.org/paper.pdf');
  assert.equal(request.maxChars, get('RAG').MAX_DOC_CHARS);
  assert.equal(offscreen.created, 1);
  assert.equal(offscreen.closed, 1);

  const kb = await get('RAG').getKb();
  assert.ok(kb.chunks.every(c => /^pages? \d/.test(c.label)), 'every chunk cites a page');
});

test('PDF reader errors are passed through and the offscreen doc still closes', async () => {
  const { send, offscreen } = setup({ pdfResult: { error: 'No text found in this PDF (it may be a scanned image).' } });
  const res = await send({ action: 'addPdf', title: 'scan.pdf' }, { tab: { url: 'https://x.org/scan.pdf' } });
  assert.match(res.error, /scanned image/);
  assert.equal(offscreen.closed, 1);
});

test('removePage and newSession update the context and badge', async () => {
  const { send, badge } = setup();
  await send({ action: 'addWebPage', title: 'A', text: ARTICLE }, { tab: { url: 'https://a.com/' } });
  await send({ action: 'addWebPage', title: 'B', text: ARTICLE }, { tab: { url: 'https://b.com/' } });
  assert.equal(badge.text, '2');

  let s = await send({ action: 'removePage', pageUrl: 'https://a.com/#x' }, { tab: { url: 'https://b.com/' } });
  assert.deepEqual(s.docs.map(d => d.url), ['https://b.com/']);
  assert.equal(badge.text, '1');

  s = await send({ action: 'newSession' });
  assert.equal(s.docs.length, 0);
  assert.equal(badge.text, '');
});

test('ask without pages: plain system prompt, answer stored in history', async () => {
  const { send, openai } = setup();
  openai.state.answer = 'Photosynthesis turns light into sugar.';
  const res = await send({ action: 'ask', question: 'What is photosynthesis?' });

  assert.equal(res.error, undefined);
  assert.equal(res.userMessage.content, 'What is photosynthesis?');
  assert.equal(res.assistantMessage.content, 'Photosynthesis turns light into sugar.');
  assert.equal(res.assistantMessage.meta.excerpts, 0);
  assert.equal(res.assistantMessage.meta.tokens, 42);
  assert.equal(openai.calls.embeddings.length, 0, 'no retrieval without pages');

  const [call] = answerCalls(openai);
  assert.equal(call.messages[0].role, 'system');
  assert.doesNotMatch(call.messages[0].content, /<excerpts>/);
  assert.deepEqual(call.messages.at(-1), { role: 'user', content: 'What is photosynthesis?' });

  const s = await send({ action: 'getSession' });
  assert.deepEqual(s.messages.map(m => m.role), ['user', 'assistant']);
});

test('ask with pages: relevant excerpts and sources go into the system prompt', async () => {
  const { send, openai } = setup();
  await send({ action: 'addWebPage', title: 'Neural Nets', text: ARTICLE }, { tab: { url: 'https://ex.com/nn' } });

  const res = await send({ action: 'ask', question: 'How does gradient training work?' });
  assert.ok(res.assistantMessage.meta.excerpts > 0);
  assert.ok(res.assistantMessage.meta.sources.includes('Training'));

  const system = answerCalls(openai)[0].messages[0].content;
  assert.match(system, /<excerpts>/);
  assert.match(system, /"Neural Nets" \(web page, https:\/\/ex\.com\/nn\)/);
  assert.match(system, /\[Excerpt \d+ — "Neural Nets", Training\]/);
  assert.match(system, /gradient/);
});

test('the retrieval query combines the selection, the previous question and the new one', async () => {
  const { send, openai } = setup();
  await send({ action: 'addWebPage', title: 'NN', text: ARTICLE }, { tab: { url: 'https://ex.com/nn' } });
  await send({ action: 'ask', question: 'first question about neurons' });

  openai.calls.embeddings.length = 0;
  await send({ action: 'ask', question: 'and the follow-up' });
  const query = openai.calls.embeddings[0].input[0];
  assert.match(query, /first question about neurons/);
  assert.match(query, /and the follow-up/);
});

test('a screenshot is transcribed once; only the latest image is sent as an image', async () => {
  const { send, openai } = setup();
  openai.state.transcription = 'Equation 3: loss = sum of squares';

  const sel1 = { image: 'data:image/png;base64,ONE', pageUrl: 'https://p.com/', pageTitle: 'Paper' };
  const r1 = await send({ action: 'ask', question: 'Explain this', selection: sel1 });
  assert.equal(r1.userMessage.selection.text, 'Equation 3: loss = sum of squares');

  const transcriptions = openai.calls.chat.filter(c => c.model === 'gpt-4o-mini');
  assert.equal(transcriptions.length, 1);
  assert.equal(transcriptions[0].messages[0].content[0].image_url.url, 'data:image/png;base64,ONE');

  const sel2 = { image: 'data:image/png;base64,TWO', pageUrl: 'https://p.com/', pageTitle: 'Paper' };
  await send({ action: 'ask', question: 'And this one?', selection: sel2 });

  const msgs = answerCalls(openai).at(-1).messages;
  const withImages = msgs.filter(m => Array.isArray(m.content));
  assert.equal(withImages.length, 1, 'only one image in the request');
  assert.equal(withImages[0].content[0].image_url.url, 'data:image/png;base64,TWO');

  // The older screenshot is replaced by its transcription
  const older = msgs.find(m => typeof m.content === 'string' && m.content.includes('Earlier I selected'));
  assert.ok(older);
  assert.match(older.content, /Equation 3: loss = sum of squares/);
  assert.match(older.content, /on "Paper"/);
});

test('a failed transcription does not block the answer', async () => {
  const { send, openai } = setup();
  openai.state.failNext = { status: 500, message: 'transcription down' };
  const res = await send({ action: 'ask', question: 'What is this?',
    selection: { image: 'data:image/png;base64,X', pageTitle: 'T' } });
  assert.equal(res.error, undefined);
  assert.equal(res.userMessage.selection.text, '');
  assert.equal(answerCalls(openai).length, 1);
});

test('only the last 20 messages of history are sent', async () => {
  const { send, openai, get } = setup();
  const RAG = get('RAG');
  for (let i = 0; i < 30; i++) {
    await RAG.addMessage({ role: i % 2 ? 'assistant' : 'user', content: `msg ${i}` });
  }
  await send({ action: 'ask', question: 'latest' });
  const msgs = answerCalls(openai)[0].messages;
  assert.equal(msgs.length, 1 + 20, 'system + 20 history messages');
  assert.equal(msgs.at(-1).content, 'latest');
  assert.ok(!msgs.some(m => m.content === 'msg 10'));
});

test('a failed answer is reported and nothing is saved to history', async () => {
  const { send, openai } = setup();
  openai.state.failNext = { status: 429, message: 'Rate limit reached' };
  const res = await send({ action: 'ask', question: 'hello?' });
  assert.match(res.error, /Rate limit/);
  const s = await send({ action: 'getSession' });
  assert.equal(s.messageCount, 0);
});

test('"new context on navigate" resets when leaving the pages in context', async () => {
  const { send, chrome, get } = setup({ sync: { ...API, contextOnNavigate: 'new' } });
  await send({ action: 'addWebPage', title: 'A', text: ARTICLE }, { tab: { url: 'https://a.com/' } });
  const onUpdated = chrome.tabs.onUpdated.listeners[0];

  // Navigating within a page in context keeps it
  await onUpdated(1, { url: 'https://a.com/#part2' }, { active: true });
  assert.equal((await get('RAG').getKb()).docs.length, 1);

  // Background tabs are ignored
  await onUpdated(2, { url: 'https://elsewhere.com/' }, { active: false });
  assert.equal((await get('RAG').getKb()).docs.length, 1);

  await onUpdated(1, { url: 'https://elsewhere.com/' }, { active: true });
  assert.equal((await get('RAG').getKb()).docs.length, 0);
});

test('default "keep" mode never resets on navigation', async () => {
  const { send, chrome, get } = setup();
  await send({ action: 'addWebPage', title: 'A', text: ARTICLE }, { tab: { url: 'https://a.com/' } });
  await chrome.tabs.onUpdated.listeners[0](1, { url: 'https://elsewhere.com/' }, { active: true });
  assert.equal((await get('RAG').getKb()).docs.length, 1);
});

test('keyboard shortcuts are forwarded to the active tab', async () => {
  const { chrome, tabMessages } = setup();
  const onCommand = chrome.commands.onCommand.listeners[0];
  onCommand('toggle-selection');
  onCommand('context-menu');
  onCommand('unknown-command');
  await settle();
  assert.deepEqual(tabMessages.map(m => m.msg.action), ['toggleSelection', 'openContextMenu']);
});

test('captureTab returns a screenshot data URL', async () => {
  const { send } = setup();
  const res = await send({ action: 'captureTab' });
  assert.match(res.dataUrl, /^data:image\/png/);
});

test('messages addressed to the offscreen document are ignored', async () => {
  const { send } = setup();
  assert.equal(await send({ target: 'offscreen', action: 'extractPdfText' }), undefined);
});
