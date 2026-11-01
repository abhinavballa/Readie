// Tests for answer ratings and the training dataset (background.js, rag.js, content.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground, loadContentScript, settle } = require('./helpers');

const API = { openaiApiKey: 'sk-test' };

function setup(feedbackRate = 'always') {
  return loadBackground({ sync: { ...API, feedbackRate } });
}

const ARTICLE = '## Intro\n' + Array.from({ length: 6 }, (_, i) =>
  `Mitochondria mitochondrial energy sentence ${i} explains cellular respiration well.`).join(' ');

test('"always" asks to rate every answer and the answer gets an id', async () => {
  const { send } = setup('always');
  const a = await send({ action: 'ask', question: 'one' });
  const b = await send({ action: 'ask', question: 'two' });
  assert.equal(a.assistantMessage.feedbackRequested, true);
  assert.equal(b.assistantMessage.feedbackRequested, true);
  assert.equal(typeof a.assistantMessage.id, 'number');
  assert.notEqual(a.assistantMessage.id, b.assistantMessage.id);
});

test('"off" never asks', async () => {
  const { send } = setup('off');
  for (let i = 0; i < 5; i++) {
    const r = await send({ action: 'ask', question: 'q' + i });
    assert.notEqual(r.assistantMessage.feedbackRequested, true);
  }
});

test('"sometimes" asks about 1 in 3 and never twice in a row', async () => {
  const { send, get } = setup('sometimes');
  // Seeded random so the test is stable
  let seed = 1;
  get('Math').random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const flags = [];
  for (let i = 0; i < 60; i++) {
    const r = await send({ action: 'ask', question: 'q' + i });
    flags.push(Boolean(r.assistantMessage.feedbackRequested));
  }
  for (let i = 1; i < flags.length; i++) {
    assert.ok(!(flags[i] && flags[i - 1]), `asked twice in a row at ${i}`);
  }
  const asked = flags.filter(Boolean).length;
  assert.ok(asked >= 8 && asked <= 25, `asked ${asked} of 60`);
});

test('a satisfactory rating saves exactly what the model saw plus its answer', async () => {
  const { send, openai } = setup();
  await send({ action: 'addWebPage', title: 'Cells', text: ARTICLE }, { tab: { url: 'https://bio.com/' } });
  openai.state.answer = 'Mitochondria make ATP.';
  const r = await send({ action: 'ask', question: 'What do mitochondria do?' });

  const rated = await send({ action: 'rateResponse', id: r.assistantMessage.id, rating: 'satisfactory' });
  assert.equal(rated.saved, true);
  assert.deepEqual({ ...rated.stats }, { satisfactory: 1, unsatisfactory: 0, total: 1 });

  const { jsonl, count } = await send({ action: 'exportTrainingData', rating: 'satisfactory' });
  assert.equal(count, 1);
  const lines = jsonl.trim().split('\n');
  assert.equal(lines.length, 1);
  const example = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(example), ['messages'], 'plain OpenAI fine-tuning format');

  const sent = openai.calls.chat.filter(c => c.model === 'gpt-4o').at(-1).messages;
  assert.deepEqual(example.messages.slice(0, -1), sent, 'same messages as the request');
  assert.deepEqual(example.messages.at(-1), { role: 'assistant', content: 'Mitochondria make ATP.' });
  assert.match(example.messages[0].content, /<excerpts>/, 'retrieved excerpts kept in the system prompt');
});

test('screenshots are stored as their transcription, not base64', async () => {
  const { send, openai } = setup();
  openai.state.transcription = 'E = mc^2';
  const r = await send({ action: 'ask', question: 'Explain',
    selection: { image: 'data:image/png;base64,SECRETPIXELS', pageTitle: 'Physics' } });
  await send({ action: 'rateResponse', id: r.assistantMessage.id, rating: 'satisfactory' });

  const { jsonl } = await send({ action: 'exportTrainingData' });
  assert.ok(!jsonl.includes('base64'), 'no image data in the dataset');
  const user = JSON.parse(jsonl).messages.at(-2);
  assert.equal(user.role, 'user');
  assert.equal(typeof user.content, 'string');
  assert.match(user.content, /E = mc\^2/);
  assert.match(user.content, /Explain/);
});

test('unsatisfactory answers are kept for preference training but not in the SFT export', async () => {
  const { send } = setup();
  const good = await send({ action: 'ask', question: 'good one' });
  const bad = await send({ action: 'ask', question: 'bad one' });
  await send({ action: 'rateResponse', id: good.assistantMessage.id, rating: 'satisfactory' });
  await send({ action: 'rateResponse', id: bad.assistantMessage.id, rating: 'unsatisfactory' });

  const sft = await send({ action: 'exportTrainingData', rating: 'satisfactory' });
  assert.equal(sft.count, 1);
  assert.ok(!sft.jsonl.includes('bad one'));

  const all = await send({ action: 'exportTrainingData', rating: 'all' });
  assert.equal(all.count, 2);
  const ratings = all.jsonl.trim().split('\n').map(l => JSON.parse(l).rating).sort();
  assert.deepEqual(ratings, ['satisfactory', 'unsatisfactory']);
});

test('re-rating replaces the record; dismissing never overrides a rating', async () => {
  const { send, get } = setup();
  const r = await send({ action: 'ask', question: 'q' });
  const id = r.assistantMessage.id;

  await send({ action: 'rateResponse', id, rating: 'satisfactory' });
  const second = await send({ action: 'rateResponse', id, rating: 'unsatisfactory' });
  assert.deepEqual({ ...second.stats }, { satisfactory: 0, unsatisfactory: 1, total: 1 });

  const dismissed = await send({ action: 'rateResponse', id, rating: 'dismissed' });
  assert.equal(dismissed.rating, 'unsatisfactory');
  assert.equal((await get('RAG').getMessage(id)).rating, 'unsatisfactory');
});

test('a rated or dismissed answer is not prompted again after reload', async () => {
  const { send } = setup();
  const a = await send({ action: 'ask', question: 'a' });
  const b = await send({ action: 'ask', question: 'b' });
  await send({ action: 'rateResponse', id: a.assistantMessage.id, rating: 'satisfactory' });
  await send({ action: 'rateResponse', id: b.assistantMessage.id, rating: 'dismissed' });

  const s = await send({ action: 'getSession' });
  const answers = s.messages.filter(m => m.role === 'assistant');
  assert.deepEqual(answers.map(m => m.rating), ['satisfactory', 'dismissed']);
  assert.ok(answers.every(m => m.trainingMessages === undefined), 'big training payload not sent to tabs');
});

test('bad ratings and unknown ids are rejected', async () => {
  const { send } = setup();
  const r = await send({ action: 'ask', question: 'q' });
  assert.match((await send({ action: 'rateResponse', id: r.assistantMessage.id, rating: 'great' })).error, /Unknown rating/);
  assert.match((await send({ action: 'rateResponse', id: 9999, rating: 'satisfactory' })).error, /not found/);
  assert.match((await send({ action: 'rateResponse', id: r.userMessage.id, rating: 'satisfactory' })).error, /not found/);
});

test('training data survives a new session and is only removed by clearTrainingData', async () => {
  const { send } = setup();
  const r = await send({ action: 'ask', question: 'keep me' });
  await send({ action: 'rateResponse', id: r.assistantMessage.id, rating: 'satisfactory' });

  await send({ action: 'newSession' });
  assert.equal((await send({ action: 'getSession' })).messageCount, 0);
  assert.equal((await send({ action: 'getTrainingStats' })).satisfactory, 1);

  const cleared = await send({ action: 'clearTrainingData' });
  assert.deepEqual({ ...cleared }, { satisfactory: 0, unsatisfactory: 0, total: 0 });
  assert.equal((await send({ action: 'exportTrainingData' })).jsonl, '');
});

test('upgrading from the old database keeps the conversation and adds the dataset', async () => {
  const bg = setup();
  // Create the version-1 database the previous release used
  await new Promise((resolve, reject) => {
    const req = bg.context.indexedDB.open('readie-session', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kb', { keyPath: 'id' });
      req.result.createObjectStore('messages', { keyPath: 'id', autoIncrement: true })
        .add({ role: 'user', content: 'from v1' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });

  const s = await bg.send({ action: 'getSession' });
  assert.deepEqual(s.messages.map(m => m.content), ['from v1']);
  assert.equal((await bg.send({ action: 'getTrainingStats' })).total, 0);
});

// ---------- The rating prompt in the panel ----------

const answer = (extra = {}) => ({ id: 5, role: 'assistant', content: 'An answer.', meta: {}, ...extra });

async function panelWith(messages) {
  const cs = loadContentScript();
  cs.window.__readieReply = (msg) => msg.action === 'getSession'
    ? { docs: [], messages, messageCount: messages.length, words: 0 }
    : { ok: true };
  await cs.window.openPanel();
  return cs;
}

test('the panel shows the rating prompt only for answers that asked for it', async () => {
  const { window } = await panelWith([
    answer({ id: 1, feedbackRequested: true }),
    answer({ id: 2 }),
    answer({ id: 3, feedbackRequested: true, rating: 'satisfactory' })
  ]);
  const prompts = window.document.querySelectorAll('.readie-feedback');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].dataset.feedbackId, '1');
  assert.match(prompts[0].textContent, /Was this answer helpful\?/);
});

test('clicking Satisfactory sends the rating once and thanks the user', async () => {
  const { window, sent } = await panelWith([answer({ feedbackRequested: true })]);
  const btn = window.document.querySelector('[data-rate="satisfactory"]');
  btn.click();
  btn.click();
  await settle();

  const rates = sent.filter(m => m.action === 'rateResponse');
  assert.equal(rates.length, 1);
  assert.deepEqual({ ...rates[0] }, { action: 'rateResponse', id: 5, rating: 'satisfactory' });
  assert.match(window.document.querySelector('.readie-feedback').textContent, /Thanks/);
});

test('dismissing removes the prompt and records the dismissal', async () => {
  const { window, sent } = await panelWith([answer({ feedbackRequested: true })]);
  window.document.querySelector('[data-rate="dismissed"]').click();
  await settle();
  assert.equal(window.document.querySelector('.readie-feedback'), null);
  assert.equal(sent.find(m => m.action === 'rateResponse').rating, 'dismissed');
});
