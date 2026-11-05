// Test harness: loads the extension's scripts into a Node vm with fake
// chrome APIs, a fake OpenAI (fetch), and an in-memory IndexedDB.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');

const EXT = path.join(__dirname, '..', 'extension');
const DIMS = 512;

// ---------- Fake embeddings ----------

// Deterministic bag-of-words vector, so texts sharing words are similar.
function fakeEmbedding(text) {
  const vec = new Array(DIMS).fill(0);
  const words = String(text).toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    vec[Math.abs(h) % DIMS] += 1;
  }
  if (words.length === 0) vec[0] = 1;
  return vec;
}

// ---------- Fake OpenAI ----------

function createFakeOpenAI() {
  const calls = { embeddings: [], chat: [] };
  const state = {
    answer: 'Fake answer.',
    transcription: 'Transcribed selection text.',
    failNext: null // { status, message }
  };

  async function fetch(url, init = {}) {
    const body = init.body ? JSON.parse(init.body) : {};
    const json = (status, data) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => data
    });

    if (state.failNext) {
      const { status, message } = state.failNext;
      state.failNext = null;
      return json(status, { error: { message } });
    }

    if (url.endsWith('/v1/embeddings')) {
      calls.embeddings.push(body);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      // Return out of order to check the code sorts by index
      const data = inputs.map((t, index) => ({ index, embedding: fakeEmbedding(t) })).reverse();
      return json(200, { data });
    }

    if (url.endsWith('/v1/chat/completions')) {
      calls.chat.push(body);
      const isTranscription = body.model === 'gpt-4o-mini';
      return json(200, {
        model: body.model,
        choices: [{ message: { content: isTranscription ? state.transcription : state.answer } }],
        usage: { total_tokens: 42 }
      });
    }

    throw new Error('Unexpected fetch: ' + url);
  }

  return { fetch, calls, state };
}

// ---------- Fake chrome ----------

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    }
  };
}

function createStorageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys == null) return { ...data };
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(items) { Object.assign(data, items); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

function createChrome({ sync = {}, pdfResult = null } = {}) {
  const badge = { text: '', color: null };
  const offscreen = { created: 0, closed: 0, open: false };
  const tabMessages = [];

  const chrome = {
    runtime: {
      onMessage: createEvent(),
      onStartup: createEvent(),
      onInstalled: createEvent(),
      getURL: (p) => 'chrome-extension://test/' + p,
      async getContexts() { return offscreen.open ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : []; },
      // Only the background sends runtime messages, to the offscreen PDF reader
      async sendMessage(msg) {
        if (msg.target === 'offscreen') {
          if (typeof pdfResult === 'function') return pdfResult(msg);
          return pdfResult;
        }
        return undefined;
      }
    },
    commands: { onCommand: createEvent() },
    tabs: {
      onUpdated: createEvent(),
      async query() { return [{ id: 1 }]; },
      async sendMessage(tabId, msg) { tabMessages.push({ tabId, msg }); },
      async captureVisibleTab() { return 'data:image/png;base64,AAAA'; }
    },
    storage: {
      sync: createStorageArea(sync),
      local: createStorageArea(),
      onChanged: createEvent()
    },
    action: {
      async setBadgeText({ text }) { badge.text = text; },
      async setBadgeBackgroundColor({ color }) { badge.color = color; }
    },
    offscreen: {
      async createDocument() { offscreen.created++; offscreen.open = true; },
      async closeDocument() { offscreen.closed++; offscreen.open = false; }
    }
  };

  // chrome.tabs.query is also called with a callback
  const query = chrome.tabs.query;
  chrome.tabs.query = (info, cb) => {
    const p = query(info);
    if (cb) p.then(cb);
    return p;
  };

  return { chrome, badge, offscreen, tabMessages };
}

// ---------- Loading scripts ----------

// Load background.js (which importScripts rag.js etc.) into a fresh context.
function loadBackground(options = {}) {
  const openai = createFakeOpenAI();
  const fake = createChrome(options);

  const context = {
    console: options.quiet === false ? console : { log() {}, warn() {}, error() {}, info() {} },
    chrome: fake.chrome,
    fetch: openai.fetch,
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    crypto: globalThis.crypto,
    structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    URL, Blob, TextEncoder, TextDecoder
  };
  context.self = context;
  context.globalThis = context;
  context.importScripts = (...files) => {
    for (const f of files) runFile(context, f);
  };
  vm.createContext(context);
  runFile(context, 'background.js');

  // Expose `const` globals (RAG, handleQuestion, ...) declared by the scripts
  const get = (name) => vm.runInContext(name, context);

  // Send a message as a content script would, resolving with the response
  function send(request, sender = { tab: { id: 1, url: 'https://example.com/page' } }) {
    return new Promise((resolve, reject) => {
      let async = false;
      let done = false;
      const sendResponse = (r) => { done = true; resolve(r); };
      for (const fn of fake.chrome.runtime.onMessage.listeners) {
        const ret = fn(request, sender, sendResponse);
        if (ret === true) async = true;
      }
      if (!async && !done) resolve(undefined);
      setTimeout(() => { if (!done && async) reject(new Error('No response to ' + request.action)); }, 5000);
    });
  }

  return { context, get, send, openai, ...fake };
}

function runFile(context, file) {
  const full = path.join(EXT, file);
  vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
}

// Load content.js into a jsdom window. Returns the window.
function loadContentScript(html = '<!doctype html><html><head><title>T</title></head><body></body></html>', url = 'https://example.com/article', { sync = {} } = {}) {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;

  // jsdom has no layout, so innerText isn't implemented; textContent is close enough
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    get() { return this.textContent; },
    configurable: true
  });

  const fake = createChrome({ sync });
  const sent = [];
  fake.chrome.runtime.sendMessage = async (msg) => {
    sent.push(msg);
    return window.__readieReply ? window.__readieReply(msg) : {};
  };
  window.chrome = fake.chrome;

  // Run as a classic script so its top-level let/const are shared with run()
  const vmContext = dom.getInternalVMContext();
  const run = (code, filename) => new vm.Script(code, { filename }).runInContext(vmContext);
  for (const file of ['theme.js', 'content.js']) {
    run(fs.readFileSync(path.join(EXT, file), 'utf8'), path.join(EXT, file));
  }
  return { window, dom, sent, run, ...fake };
}

// Wait until the event loop is idle for a bit (lets async UI work finish)
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms));

module.exports = { loadBackground, loadContentScript, fakeEmbedding, settle, DIMS };
