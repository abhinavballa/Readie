// Tests for extension/rag.js: chunking, the knowledge base, retrieval, and the session store.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadBackground } = require('./helpers');

const KEY = 'sk-test';

// Paragraph of `n` sentences about one topic
function topicParagraph(topic, n) {
  return Array.from({ length: n }, (_, i) =>
    `The ${topic} ${topic}s ${topic}ing study number ${i} explains ${topic} behaviour in detail.`).join(' ');
}

function setup() {
  const bg = loadBackground();
  return { ...bg, RAG: bg.get('RAG') };
}

test('sectionsFromWebText splits on "## " headings and keeps the heading text', () => {
  const { RAG } = setup();
  const sections = RAG.sectionsFromWebText('Intro line.\n## Methods\nWe did things.\n## Results\nIt worked.');
  assert.equal(sections.length, 3);
  assert.equal(sections[0].label, '');
  assert.equal(sections[1].label, 'Methods');
  assert.match(sections[1].text, /^Methods\nWe did things\./);
  assert.equal(sections[2].label, 'Results');
  assert.ok(sections.every(s => s.hardBreak === true));
});

test('sectionsFromWebText on empty text yields no text', () => {
  const { RAG } = setup();
  const sections = RAG.sectionsFromWebText('');
  assert.ok(sections.every(s => s.text.trim() === ''));
});

test('addDocument stores the doc, its chunks, and normalized 512-dim vectors', async () => {
  const { RAG, openai } = setup();
  const text = topicParagraph('photosynthesis', 12);
  const kb = await RAG.addDocument({
    url: 'https://a.com/', title: 'Plants', source: 'webpage',
    sections: [{ label: 'Intro', text, hardBreak: true }]
  }, KEY);

  assert.equal(kb.docs.length, 1);
  const doc = kb.docs[0];
  assert.equal(doc.title, 'Plants');
  assert.equal(doc.chunkCount, kb.chunks.length);
  assert.ok(doc.words > 50);
  assert.equal(doc.truncated, false);

  for (const c of kb.chunks) {
    assert.equal(c.docId, doc.id);
    assert.equal(c.vec.length, 512);
    const norm = Math.sqrt([...c.vec].reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(norm - 1) < 1e-5, 'vector should be unit length');
  }

  // Every embeddings request asks for the small model and 512 dims
  assert.ok(openai.calls.embeddings.length >= 2);
  for (const call of openai.calls.embeddings) {
    assert.equal(call.model, 'text-embedding-3-small');
    assert.equal(call.dimensions, 512);
    assert.ok(call.input.length <= 96, 'batches are at most 96 inputs');
  }
});

test('chunks keep all the text, respect the max size, and split on topic shifts', async () => {
  const { RAG } = setup();
  const a = topicParagraph('volcano', 10);
  const b = topicParagraph('violin', 10);
  const kb = await RAG.addDocument({
    url: 'https://b.com/', title: 'Mixed', source: 'pdf',
    sections: [{ label: 'page 1', text: a + ' ' + b, hardBreak: false }]
  }, KEY);

  for (const c of kb.chunks) assert.ok(c.text.length <= 2000 + 400, 'chunk too large');

  // No sentence is lost
  const joined = kb.chunks.map(c => c.text).join(' ');
  for (const word of ['volcano', 'violin', 'number 0', 'number 9']) assert.ok(joined.includes(word));

  // The topics end up in different chunks
  const mixed = kb.chunks.filter(c => c.text.includes('volcano') && c.text.includes('violin'));
  assert.ok(kb.chunks.length >= 2);
  assert.ok(mixed.length <= 1, 'at most the boundary chunk mixes topics');
});

test('headings always start a new chunk', async () => {
  const { RAG } = setup();
  const text = `## Alpha\n${topicParagraph('alpha', 4)}\n## Beta\n${topicParagraph('beta', 4)}`;
  const kb = await RAG.addDocument({
    url: 'https://c.com/', title: 'Sections', source: 'webpage',
    sections: RAG.sectionsFromWebText(text)
  }, KEY);
  const labels = kb.chunks.map(c => c.label);
  assert.ok(labels.includes('Alpha'));
  assert.ok(labels.includes('Beta'));
  assert.ok(!kb.chunks.some(c => c.text.includes('alpha') && c.text.includes('beta')));
});

test('PDF page labels are merged into "pages X–Y" when a chunk spans pages', async () => {
  const { RAG } = setup();
  const kb = await RAG.addDocument({
    url: 'https://d.com/x.pdf', title: 'Paper', source: 'pdf',
    sections: [
      { label: 'page 1', text: 'Short start of a sentence that continues', hardBreak: false },
      { label: 'page 2', text: 'onto the next page and keeps going for a while longer here.', hardBreak: false }
    ]
  }, KEY);
  assert.equal(kb.chunks.length, 1);
  assert.equal(kb.chunks[0].label, 'pages 1–2');
});

test('very long documents are truncated and flagged', async () => {
  const { RAG } = setup();
  const sentence = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do. ';
  const big = sentence.repeat(Math.ceil((RAG.MAX_DOC_CHARS + 5000) / sentence.length));
  const kb = await RAG.addDocument({
    url: 'https://e.com/', title: 'Huge', source: 'webpage',
    sections: [{ label: '', text: big, hardBreak: true }]
  }, KEY);
  assert.equal(kb.docs[0].truncated, true);
  const total = kb.chunks.reduce((n, c) => n + c.text.length, 0);
  assert.ok(total <= RAG.MAX_DOC_CHARS + kb.chunks.length * 2);
});

test('a page with no text is rejected', async () => {
  const { RAG } = setup();
  await assert.rejects(
    RAG.addDocument({ url: 'https://f.com/', title: 'Empty', source: 'webpage', sections: [] }, KEY),
    /No readable text/
  );
});

test('re-adding a URL replaces the old version; removeDocument deletes it', async () => {
  const { RAG } = setup();
  const doc = (text) => ({ url: 'https://g.com/', title: 'G', source: 'webpage',
    sections: [{ label: '', text, hardBreak: true }] });

  await RAG.addDocument(doc(topicParagraph('first', 3)), KEY);
  await RAG.addDocument({ ...doc(topicParagraph('other', 3)), url: 'https://h.com/' }, KEY);
  let kb = await RAG.addDocument(doc(topicParagraph('second', 3)), KEY);

  assert.equal(kb.docs.length, 2);
  const g = kb.docs.find(d => d.url === 'https://g.com/');
  const gChunks = kb.chunks.filter(c => c.docId === g.id);
  assert.ok(gChunks.every(c => c.text.includes('second')));
  assert.ok(!kb.chunks.some(c => c.text.includes('first')));

  kb = await RAG.removeDocument('https://g.com/');
  assert.deepEqual(kb.docs.map(d => d.url), ['https://h.com/']);
  assert.ok(kb.chunks.every(c => c.docId === kb.docs[0].id));
});

test('retrieve returns the best matches plus each doc\'s opening chunk, in reading order', async () => {
  const { RAG } = setup();
  const topics = ['apple', 'banana', 'cherry', 'dragonfruit', 'elderberry', 'fig', 'grape', 'kiwi'];
  const sections = topics.map(t => ({ label: t, text: topicParagraph(t, 6), hardBreak: true }));
  await RAG.addDocument({ url: 'https://fruit.com/', title: 'Fruit', source: 'webpage', sections }, KEY);

  const res = await RAG.retrieve('Tell me about grape grapes', KEY, 1);
  assert.ok(res.chunks.some(c => c.text.includes('grape')), 'best match included');
  assert.ok(res.chunks.some(c => c.order === 0 && c.text.includes('apple')), 'opening chunk included');
  assert.equal(res.chunks.length, 2);
  assert.ok(res.chunks[0].order < res.chunks[1].order, 'sorted in reading order');
});

test('retrieve on an empty knowledge base returns null without calling OpenAI', async () => {
  const { RAG, openai } = setup();
  assert.equal(await RAG.retrieve('anything', KEY), null);
  assert.equal(openai.calls.embeddings.length, 0);
});

test('messages persist and resetSession clears both messages and documents', async () => {
  const { RAG } = setup();
  await RAG.addMessage({ role: 'user', content: 'hi' });
  await RAG.addMessage({ role: 'assistant', content: 'hello' });
  await RAG.addDocument({ url: 'https://i.com/', title: 'I', source: 'webpage',
    sections: [{ label: '', text: topicParagraph('ice', 3), hardBreak: true }] }, KEY);

  const msgs = await RAG.getMessages();
  assert.deepEqual(msgs.map(m => m.content), ['hi', 'hello']);
  assert.ok(msgs.every(m => typeof m.createdAt === 'number' && m.id != null));

  await RAG.resetSession();
  assert.equal((await RAG.getMessages()).length, 0);
  assert.equal((await RAG.getKb()).docs.length, 0);
});

test('summarize reports docs, chunk count and words', async () => {
  const { RAG } = setup();
  const kb = await RAG.addDocument({ url: 'https://j.com/', title: 'J', source: 'pdf', numPages: 3,
    sections: [{ label: 'page 1', text: topicParagraph('jazz', 3), hardBreak: false }] }, KEY);
  const s = RAG.summarize(kb);
  assert.equal(s.docs.length, 1);
  assert.equal(s.docs[0].numPages, 3);
  assert.equal(s.chunkCount, kb.chunks.length);
  assert.equal(s.words, kb.docs[0].words);
  assert.equal(s.docs[0].vec, undefined, 'no vectors leak into the summary');
});

test('OpenAI embedding errors are surfaced with their message', async () => {
  const { RAG, openai } = setup();
  openai.state.failNext = { status: 401, message: 'Incorrect API key provided' };
  await assert.rejects(
    RAG.addDocument({ url: 'https://k.com/', title: 'K', source: 'webpage',
      sections: [{ label: '', text: 'Some text here that is long enough.', hardBreak: true }] }, KEY),
    /Incorrect API key/
  );
});
