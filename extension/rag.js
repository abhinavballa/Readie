// RAG + session storage for Readie.
//
// A "session" is one ongoing conversation plus a knowledge base of every page/PDF
// the user added to it. It is global (shared by all tabs) and lives in IndexedDB,
// so it survives closing the panel, switching tabs, and navigating. It ends only
// when the user starts a new session (or the navigation setting says so).
//
// Pages are split with semantic chunking: sentences are embedded with a small
// window of neighbours, and a chunk ends where the meaning shifts (a large drop in
// similarity between adjacent sentences) or at a heading. Each chunk is then
// embedded once; questions only send the best-matching chunks to the model.
//
// Loaded into the background service worker with importScripts().

const RAG = (() => {
  const EMBEDDING_MODEL = 'text-embedding-3-small';
  const EMBEDDING_DIMENSIONS = 512;     // smaller vectors, plenty for retrieval
  const EMBED_BATCH_SIZE = 96;          // inputs per embeddings request
  const EMBED_CONCURRENCY = 4;          // parallel embeddings requests

  const SENTENCE_WINDOW = 1;            // neighbours on each side when embedding a sentence
  const BREAKPOINT_PERCENTILE = 90;     // similarity drops above this percentile split chunks
  const MIN_CHUNK_CHARS = 300;          // merge tiny chunks into the next one
  const MAX_CHUNK_CHARS = 2000;         // force a split past this size
  const MAX_DOC_CHARS = 600000;         // ~150k tokens (~300 pages) per document

  const DB_NAME = 'readie-session';
  const KB_STORE = 'kb';                // single record: { id: 'current', docs, chunks }
  const MSG_STORE = 'messages';         // conversation, append-only

  // ---------- IndexedDB ----------

  let dbPromise = null;

  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(KB_STORE, { keyPath: 'id' });
          req.result.createObjectStore(MSG_STORE, { keyPath: 'id', autoIncrement: true });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
          dbPromise = null;
          reject(req.error);
        };
      });
    }
    return dbPromise;
  }

  async function tx(storeName, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(storeName, mode);
      const req = fn(t.objectStore(storeName));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async function getKb() {
    const kb = await tx(KB_STORE, 'readonly', s => s.get('current'));
    return kb || { id: 'current', docs: [], chunks: [] };
  }
  const putKb = (kb) => tx(KB_STORE, 'readwrite', s => s.put(kb));

  const getMessages = () => tx(MSG_STORE, 'readonly', s => s.getAll());
  const addMessage = (msg) => tx(MSG_STORE, 'readwrite', s => s.add({ ...msg, createdAt: Date.now() }));

  async function resetSession() {
    await tx(KB_STORE, 'readwrite', s => s.clear());
    await tx(MSG_STORE, 'readwrite', s => s.clear());
  }

  // ---------- Embeddings ----------

  function normalize(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
    return out;
  }

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  async function embedBatch(batch, apiKey) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: batch,
        dimensions: EMBEDDING_DIMENSIONS
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || 'OpenAI embeddings request failed');
    }

    const data = await response.json();
    return data.data.sort((a, b) => a.index - b.index).map(d => normalize(d.embedding));
  }

  async function embed(texts, apiKey) {
    const batches = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
      batches.push(texts.slice(i, i + EMBED_BATCH_SIZE));
    }

    const results = new Array(batches.length);
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const i = next++;
        results[i] = await embedBatch(batches[i], apiKey);
      }
    };
    await Promise.all(Array.from({ length: Math.min(EMBED_CONCURRENCY, batches.length) }, worker));
    return results.flat();
  }

  // ---------- Semantic chunking ----------

  // Split text into sentences. Line breaks also end a "sentence" so headings,
  // list items, and table rows stay separate.
  function splitSentences(text) {
    const out = [];
    for (const line of text.split(/\n+/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.match(/[^.!?]+(?:[.!?]+["')\]]*|$)(?:\s+|$)/g) || [trimmed];
      for (let p of parts) {
        p = p.trim();
        if (!p) continue;
        // Very long run-on "sentences" (e.g. code, tables) get hard-split
        while (p.length > MAX_CHUNK_CHARS) {
          out.push(p.slice(0, MAX_CHUNK_CHARS));
          p = p.slice(MAX_CHUNK_CHARS);
        }
        out.push(p);
      }
    }
    // Glue fragments like "e.g." or "Fig. 3" back onto the previous sentence
    const merged = [];
    for (const s of out) {
      if (merged.length && s.length < 25) merged[merged.length - 1] += ' ' + s;
      else merged.push(s);
    }
    return merged;
  }

  function percentile(values, p) {
    if (values.length === 0) return Infinity;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
  }

  // sections: [{ label, text, hardBreak }]. hardBreak=true (headings) always starts
  // a new chunk; PDF pages set it to false because text flows across pages.
  // Returns [{ text, label }].
  async function semanticChunk(sections, apiKey) {
    // Flatten into sentences, remembering which section each came from
    const sentences = [];
    sections.forEach((section, sectionIndex) => {
      splitSentences(section.text).forEach((text, i) => {
        sentences.push({ text, sectionIndex, startsSection: i === 0 && section.hardBreak });
      });
    });
    if (sentences.length === 0) return [];

    // Embed each sentence together with its neighbours to smooth out noise
    const windows = sentences.map((_, i) => {
      const from = Math.max(0, i - SENTENCE_WINDOW);
      const to = Math.min(sentences.length, i + SENTENCE_WINDOW + 1);
      return sentences.slice(from, to).map(s => s.text).join(' ');
    });
    const vectors = await embed(windows, apiKey);

    // distance[i] = how much the topic shifts between sentence i and i+1
    const distances = [];
    for (let i = 0; i < vectors.length - 1; i++) {
      distances.push(1 - dot(vectors[i], vectors[i + 1]));
    }
    const threshold = percentile(distances, BREAKPOINT_PERCENTILE);

    // Group sentences into chunks
    const chunks = [];
    let current = [];
    let currentLen = 0;

    const flush = () => {
      if (current.length === 0) return;
      const sectionIdxs = [...new Set(current.map(s => s.sectionIndex))];
      chunks.push({
        text: current.map(s => s.text).join(' '),
        label: describeSpan(sectionIdxs.map(i => sections[i].label))
      });
      current = [];
      currentLen = 0;
    };

    sentences.forEach((sentence, i) => {
      if (current.length > 0) {
        const topicShift = distances[i - 1] >= threshold && currentLen >= MIN_CHUNK_CHARS;
        const tooBig = currentLen + sentence.text.length > MAX_CHUNK_CHARS;
        if (sentence.startsSection || topicShift || tooBig) flush();
      }
      current.push(sentence);
      currentLen += sentence.text.length + 1;
    });
    flush();

    // Merge chunks that ended up tiny (e.g. a lone heading) into the next one
    const merged = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const nextChunk = chunks[i + 1];
      if (c.text.length < MIN_CHUNK_CHARS && nextChunk &&
          c.text.length + nextChunk.text.length <= MAX_CHUNK_CHARS) {
        nextChunk.text = c.text + '\n' + nextChunk.text;
        nextChunk.label = c.label || nextChunk.label;
      } else {
        merged.push(c);
      }
    }
    return merged;
  }

  // "page 3" + "page 4" -> "pages 3–4"; headings -> first heading
  function describeSpan(labels) {
    const clean = labels.filter(Boolean);
    if (clean.length === 0) return '';
    if (clean.length === 1) return clean[0];
    const pages = clean.map(l => l.match(/^page (\d+)$/)?.[1]).filter(Boolean);
    if (pages.length === clean.length) return `pages ${pages[0]}–${pages[pages.length - 1]}`;
    return clean[0];
  }

  // Web page text marks headings with "## " (see content.js); each heading starts a section
  function sectionsFromWebText(text) {
    const sections = [];
    let label = '';
    let buf = [];
    const flush = () => {
      if (buf.length) sections.push({ label, text: buf.join('\n'), hardBreak: true });
      buf = [];
    };
    for (const line of text.split('\n')) {
      const m = line.match(/^##\s+(.*)$/);
      if (m) {
        flush();
        label = m[1].trim().slice(0, 120);
        buf.push(m[1].trim());
      } else {
        buf.push(line);
      }
    }
    flush();
    return sections;
  }

  // ---------- Knowledge base ----------

  // doc: { url, title, source, numPages, truncated, sections: [{label, text, hardBreak}] }
  // Adds (or re-adds) a document to the session's knowledge base.
  async function addDocument(doc, apiKey) {
    let totalChars = 0;
    let truncated = Boolean(doc.truncated);
    const sections = [];
    for (const s of doc.sections) {
      if (totalChars >= MAX_DOC_CHARS) { truncated = true; break; }
      const text = s.text.slice(0, MAX_DOC_CHARS - totalChars);
      if (text.length < s.text.length) truncated = true;
      totalChars += text.length;
      sections.push({ ...s, text });
    }

    const pieces = await semanticChunk(sections, apiKey);
    if (pieces.length === 0) throw new Error('No readable text found on this page.');

    // Embed the final chunks for retrieval
    const vectors = await embed(pieces.map(p => p.text), apiKey);

    const kb = await getKb();
    // Re-adding the same URL replaces its old version
    const filtered = removeDocFrom(kb, doc.url);

    const docId = crypto.randomUUID();
    filtered.docs.push({
      id: docId,
      url: doc.url,
      title: doc.title,
      source: doc.source,
      numPages: doc.numPages || null,
      truncated,
      words: sections.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0),
      chunkCount: pieces.length,
      addedAt: Date.now()
    });
    pieces.forEach((p, i) => {
      filtered.chunks.push({ docId, order: i, label: p.label, text: p.text, vec: vectors[i] });
    });

    await putKb(filtered);
    return filtered;
  }

  function removeDocFrom(kb, url) {
    const gone = new Set(kb.docs.filter(d => d.url === url).map(d => d.id));
    return {
      ...kb,
      docs: kb.docs.filter(d => !gone.has(d.id)),
      chunks: kb.chunks.filter(c => !gone.has(c.docId))
    };
  }

  async function removeDocument(url) {
    const kb = removeDocFrom(await getKb(), url);
    await putKb(kb);
    return kb;
  }

  // Top-k chunks for the query, in reading order, plus each doc's opening chunk
  // (title/abstract/intro) for orientation.
  async function retrieve(queryText, apiKey, k = 6) {
    const kb = await getKb();
    if (kb.chunks.length === 0) return null;

    const [qvec] = await embed([queryText.slice(0, 8000)], apiKey);

    const scored = kb.chunks
      .map(c => ({ chunk: c, score: dot(qvec, c.vec) }))
      .sort((a, b) => b.score - a.score);

    const picked = new Set(scored.slice(0, k).map(s => s.chunk));
    for (const c of kb.chunks) {
      if (c.order === 0) picked.add(c);
    }

    const docOrder = new Map(kb.docs.map((d, i) => [d.id, i]));
    const chunks = [...picked].sort((a, b) =>
      docOrder.get(a.docId) - docOrder.get(b.docId) || a.order - b.order);
    return { docs: kb.docs, chunks };
  }

  function summarize(kb) {
    return {
      docs: kb.docs.map(d => ({
        url: d.url, title: d.title, source: d.source, words: d.words,
        numPages: d.numPages, truncated: d.truncated, chunkCount: d.chunkCount
      })),
      chunkCount: kb.chunks.length,
      words: kb.docs.reduce((n, d) => n + d.words, 0)
    };
  }

  return {
    getKb, addDocument, removeDocument, retrieve, summarize, sectionsFromWebText,
    getMessages, addMessage, resetSession, MAX_DOC_CHARS
  };
})();
