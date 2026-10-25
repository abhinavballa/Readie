# Readie: design notes & interview prep

These notes record how Readie evolved, why each design decision was made, how the important code works,
and questions an interviewer is likely to ask (with answers).

---

## 1. What Readie is (30-second pitch)

Readie is a Chrome extension that acts as a reading copilot. While you read a web page or PDF, you press
a shortcut, drag a box around anything on screen, and ask a question about it.

The first version only sent that screenshot to GPT-4o. The current version also lets you add whole pages
and PDFs to a **context window**. Each page is chunked semantically, embedded once, and stored locally.
Every question then retrieves the most relevant chunks (RAG), so answers are grounded in the whole
document, not just the visible snippet. The conversation persists across tabs and page loads until you
choose to start a new context window.

**Stack:** Chrome Manifest V3 (service worker, content scripts, offscreen document), plain JavaScript with
no build step, IndexedDB, pdf.js, OpenAI APIs (`gpt-4o`, `gpt-4o-mini`, `text-embedding-3-small`).

---

## 2. Architecture

```
┌──────────────────────── Web page / PDF tab ────────────────────────┐
│ content.js   selection box, screenshot crop, chat panel,           │
│              Alt+Shift+C menu, page-text extraction, Markdown      │
│ drag.js      draggable panel, remembers position                   │
└───────────────┬────────────────────────────────────────────────────┘
                │ chrome.runtime.sendMessage
┌───────────────▼──────── background.js (service worker) ─────────────┐
│ session owner: add/remove pages, new session, ask, captureTab       │
│ builds the prompt: system + retrieved excerpts + history + image    │
│ rag.js: semantic chunking, embeddings, IndexedDB store, retrieval   │
└───────┬─────────────────────────────┬───────────────────────────────┘
        │ (PDF only)                  │ HTTPS
┌───────▼──────────────┐     ┌────────▼──────────────────────────────┐
│ offscreen.html/.js   │     │ OpenAI: embeddings, gpt-4o-mini        │
│ pdf.js text extract  │     │ (transcription), gpt-4o (answers)      │
└──────────────────────┘     └───────────────────────────────────────┘
popup.html/js: API key, "when I go to a new page" setting, new-session button
```

### Files

| File | Role |
|---|---|
| `extension/manifest.json` | Permissions (`activeTab`, `storage`, `offscreen`, `unlimitedStorage`), shortcuts, content scripts |
| `extension/background.js` | Message router, session lifecycle, PDF orchestration, prompt building, OpenAI calls |
| `extension/rag.js` | IndexedDB storage, semantic chunking, embeddings, retrieval |
| `extension/offscreen.html/.js` | Downloads a PDF and extracts text page by page with pdf.js |
| `extension/content.js` | All in-page UI: selection, panel, context menu, toasts, text extraction, Markdown rendering |
| `extension/drag.js/.css` | Makes the panel draggable and persists its position |
| `extension/lib/pdfjs/` | Vendored pdf.js 4.10.38 (Apache-2.0) |
| `extension/popup.html/.js` | Settings popup |

---

## 3. How the project progressed, step by step

### Step 0: starting point (commits `4ab1593` → `d9a28a5`)
- `Alt+Shift+R` → drag a box → `chrome.tabs.captureVisibleTab` → crop on a canvas (accounting for
  `devicePixelRatio`) → send the PNG and the question to GPT-4o.
- Conversation history existed, but only within one panel. Closing the panel or taking a new screenshot reset it.
- **Limitation:** the model only ever saw the cropped region. A question like "what does λ mean here?"
  failed whenever λ was defined three sections earlier.

### Step 1: first idea, stuff the whole page into the prompt (discarded)
- A shortcut grabbed all the page text and put it in a system message on every question (capped at ~200k chars).
- **Why it was dropped:** every question re-sends ~50k tokens. That's expensive (~$0.10+ per question on
  GPT-4o), slow, it hits context limits on long PDFs, and models get worse at finding details in very long
  prompts ("lost in the middle").
- **Decision:** ingest once, retrieve per question → **RAG**.

### Step 2: RAG with a per-tab index
- Text is chunked, embedded once with `text-embedding-3-small` (512 dims), and stored in IndexedDB keyed by tab id.
- Per question: embed a query, take the cosine top-k, and send only those chunks.
- **Problem:** the screenshot is an image, so there's no text to search with.
  **Fix:** transcribe the selection once with the cheap `gpt-4o-mini` and use that text (plus the question) as the retrieval query.
- Context lifecycle became a user setting ("new page → new context" vs "keep").

### Step 3: one persistent session instead of per-tab contexts
- Requirement: the conversation should keep going across tabs and pages, survive closing the panel,
  and let you add pages over time.
- **Change:** one global session in IndexedDB with two stores: `kb` (docs + chunks + vectors) and
  `messages` (the conversation). The background worker owns it, and every tab's panel reads from it.
- The panel reopens automatically on the next page if it was open (`chrome.storage.local` flag), and it
  refreshes when a tab becomes visible (`visibilitychange`).

### Step 4: semantic chunking
- Fixed-size chunks (e.g. 1,200 chars with overlap) cut through the middle of ideas. Semantic chunking
  splits where the topic actually changes, so each retrieved chunk is a coherent unit.
- Details are in §4.2.

### Step 5: the `Alt+Shift+C` context menu
- One shortcut opens a small menu: **Add this page** (or **Re-index / Remove** if it's already added),
  **New context window with this page**, **New empty context window**, and **Open/close chat**. You pick
  with number keys or the mouse.
- This replaced an invisible "toggle" shortcut, which was confusing because the user couldn't tell
  whether a press would add or clear.

### Step 6: draggable panel
- Built as a separate module (`drag.js`) behind a one-function interface, `readieMakeDraggable(panel, handle)`,
  so it could be developed in parallel without touching `content.js`.
- It uses pointer events with `setPointerCapture` (no document-level listeners to leak), clamps to the
  viewport, persists `{left, top}`, and double-click re-centers.

### Step 7: Markdown rendering
- The model's `**bold**`, `*italic*` and `<u>underline</u>` showed up as raw characters. A small custom
  renderer now handles bold, italic, underline, strikethrough, headings, lists, quotes, links and code.
  It escapes everything first, so it's safe.

### Bug fixed along the way
- The original code-block "Expand" button used an inline `onclick="window.readieShowCodeOverlay(...)"`.
  Content scripts run in an **isolated world**, so the page's JavaScript can't see that function (and
  strict CSPs block inline handlers anyway). The button never worked. It was replaced with event
  delegation on the panel.

---

## 4. Key design decisions (with tradeoffs)

### 4.1 Why RAG instead of a long context window
| | Full page every turn | RAG (chosen) |
|---|---|---|
| Cost per question | ~50k tokens | ~2–4k tokens of excerpts |
| Multiple documents | Quickly exceeds the context limit | Scales to many docs |
| Answer quality | Detail can get lost in a long prompt | Focused, cites page/section |
| Downside | — | Can miss information that isn't retrieved; needs a good query |

Mitigations for the downside:
- The query combines the selection transcript, the previous question and the current question.
- Each document's first chunk (title/abstract) is always included.
- The prompt tells the model to say when the excerpts don't cover something.

### 4.2 Semantic chunking algorithm (`rag.js → semanticChunk`)
1. **Split into sentences** (a regex on `.!?`, plus line breaks so headings and list items stay separate).
   Tiny fragments such as "e.g." or "Fig. 3" are glued back on.
2. **Embed each sentence with a window** of one neighbour on each side. This smooths noise: a single
   short sentence has a jumpy embedding.
3. **Distance between neighbours:** `d[i] = 1 − cos(v[i], v[i+1])`. Vectors are normalized, so the dot product is the cosine.
4. **Breakpoints** are where `d[i]` is at or above the **90th percentile** of all distances in the
   document. A relative threshold adapts to each document, whereas an absolute threshold would be wrong
   for some writing styles.
5. **Constraints:**
   - A web-page heading always starts a new chunk (`hardBreak`).
   - PDF page boundaries are *not* hard breaks, because paragraphs flow across pages. Those chunks get labels like "pages 3–4".
   - Minimum 300 chars (merge into the next chunk), maximum 2,000 chars (force a split).
6. **Embed the final chunks once** for retrieval. The sentence vectors are thrown away after chunking.

**Cost:** about two embedding passes over the text. `text-embedding-3-small` costs $0.02 per 1M tokens,
so a 50-page paper is well under a cent. Requests are batched (96 inputs each) with 4 running in parallel.

### 4.3 Vector storage: IndexedDB + brute-force search
- **No vector database:** vectors are `Float32Array`s (512 dims ≈ 2 KB each) stored in IndexedDB.
  Retrieval loads all chunks and computes dot products.
- **Why:** a session holds hundreds to a few thousand chunks, so a linear scan is milliseconds. An ANN
  index (HNSW, FAISS) would add complexity and dependencies for no benefit. There's also no server, so
  data stays on the user's machine.
- **512 dims instead of 1536:** `text-embedding-3` models support shortened embeddings (Matryoshka-style
  training). That's 3× less storage and compute for a small quality cost.
- **When to change:** at 100k+ chunks or when syncing across devices, move to an ANN index or a hosted
  vector DB.

### 4.4 Retrieval query from an image
- The question alone ("what does this mean?") is a poor search query. The screenshot carries the meaning.
- `gpt-4o-mini` transcribes the selection once (a fraction of a cent). The transcript becomes:
  - part of the retrieval query, and
  - a stand-in for the image in later turns. Only the **most recent** screenshot is sent as an image, and
    older ones are sent as `[Earlier I selected a region on "<title>": """<transcript>"""]`. This keeps
    image tokens bounded.

### 4.5 Prompt layout
- **System message:** role + list of documents in context + `<excerpts>` (each tagged with its doc title and page/section).
- **History:** the last 20 messages.
- **Last user message:** image + question.
- Excerpts are sorted in **reading order**, not by score, so the model sees a coherent narrative.

### 4.6 Session lifecycle
- **Default:** the session continues until the user starts a new one (via the menu or popup button).
- **Setting "start a new context window automatically":** `tabs.onUpdated` triggers a reset when the
  **active** tab navigates to a URL that isn't in the knowledge base. Background-tab navigations and
  `#hash` changes are ignored (URLs are normalized without the hash).
- **"Undo the RAG" = delete local data:** `resetSession()` clears both IndexedDB stores. Nothing is held on
  OpenAI's side, because chat completions are stateless.

### 4.7 PDFs: why an offscreen document
- Chrome's PDF viewer is a plugin, so there's no DOM text for a content script to read.
- MV3 service workers have no DOM and can't comfortably run pdf.js with its worker.
- **Solution:** `chrome.offscreen.createDocument` (reason `WORKERS`) loads pdf.js as a module with a real
  worker, downloads the PDF, and returns `[{page, text}]`.
  - It uses XHR rather than fetch so `file://` PDFs work when "Allow access to file URLs" is on.
  - The offscreen document is closed when no PDF jobs are running.

### 4.8 Web-page text extraction
- **Pick the main content root:** the largest `<article>`, or `<main>`/`[role=main]`, if it holds at least
  35% of the body text; otherwise the whole body.
- **Walk the DOM** and skip `nav`, `footer`, `aside`, scripts, hidden elements (`checkVisibility()`),
  `aria-hidden`, and Readie's own UI.
- **Mark headings** as `## Heading` so the chunker can use them as section boundaries and labels.
- This is a lightweight version of Mozilla's Readability. Vendoring Readability would be the next step for messy sites.

### 4.9 Messaging & MV3 gotchas handled
- `chrome.runtime.sendMessage` from a content script reaches **all** extension pages, including the
  offscreen document. Messages carry `target: 'offscreen'` and each listener filters on it.
- Async replies need `return true` from the `onMessage` listener. A small `reply(promise)` helper does this consistently.
- Service workers can be killed at any time, so **no state lives in memory**: everything is in IndexedDB or `chrome.storage`.
- After an extension reload, old content scripts lose their connection. Storage calls are wrapped in
  try/catch, and the user is told to reload the page.

### 4.10 Security
- All model output is HTML-escaped **before** Markdown is converted. Only a whitelist of tags (`u, b, i,
  em, strong, s, del, mark, sub, sup, br`) without attributes is restored. Links are only allowed for `http(s)` URLs.
- Code is stashed into placeholders before formatting, so `*` inside code is never treated as italics.
- The API key is stored in `chrome.storage.sync` and sent only to `api.openai.com`.

---

## 5. Walkthrough of the important diff

**`rag.js` (new):** the core of the RAG system.
- `semanticChunk(sections, apiKey)`: the algorithm from §4.2.
- `addDocument(doc)`: truncates to 600k chars, chunks, embeds, and replaces any earlier version of the same URL.
- `retrieve(query, k)`: embeds the query, scores by dot product, returns the top-k plus each doc's first chunk, in reading order.
- `resetSession()`, `removeDocument(url)`, `getMessages()`, `addMessage()`.

**`background.js` (rewritten):**
- A `switch` router for `getSession`, `addWebPage`, `addPdf`, `removePage`, `newSession`, `ask` and `captureTab`.
- `handleQuestion`: transcribe the selection (if new) → build the retrieval query → `retrieve` → `queryOpenAI` → persist both messages.
- `toOpenAIMessages`: history windowing; only the latest image is sent as an image.
- `buildSystemPrompt`: document list + tagged excerpts + citation instructions.
- Offscreen lifecycle (`ensureOffscreenDocument`, an in-flight job counter).
- Toolbar badge = number of pages in context.

**`content.js` (rewritten):**
- The panel is now a *view* of the background session: `refreshPanel()` pulls pages + messages.
- `pendingSelection` attaches a screenshot to the next question, and questions also work without one.
- `toggleContextMenu()`: the `Alt+Shift+C` menu with number-key shortcuts (captured on `keydown` in the capture phase).
- `extractPageText()` / `isPdfPage()`.
- `parseMarkdownContent()` + `formatInline()`.
- Separate `isAsking` / `isIngesting` flags, so indexing a page doesn't block asking and a refresh doesn't wipe an in-flight answer.

**`manifest.json`:** adds `offscreen` and `unlimitedStorage`, the `context-menu` command (`Alt+Shift+C`), and loads `drag.js`/`drag.css`.

---

## 6. Likely interview questions (with answers)

**Q: Why not just use a model with a 128k/1M context window?**
Cost and latency scale with every question. RAG pays once to embed and then sends ~3k tokens per question.
Long prompts also degrade recall of mid-document details. A long context does win when a question needs
the *whole* document ("summarize everything"). A hybrid could detect those questions and switch strategy.

**Q: How does semantic chunking differ from fixed-size chunking? When would you prefer fixed-size?**
Fixed-size is cheap and predictable but splits ideas. Semantic chunking splits at topic shifts, measured by
embedding distance between neighbouring sentence windows. It costs an extra embedding pass. Fixed-size
(with overlap) is fine for very uniform text, or when ingest cost and latency matter more than retrieval
quality.

**Q: Why the 90th percentile instead of a fixed similarity threshold?**
Embedding distances vary a lot by document and writing style. A percentile adapts, giving roughly one
breakpoint per ten sentences, with the min/max size limits as guard rails.

**Q: How do you evaluate retrieval quality?**
Currently with unit tests on synthetic documents (chunks never mix topics, and the right section is
retrieved). Properly, I'd build a small labelled set of (question, page, gold passage) pairs from real
papers and measure recall@k and MRR. Then I'd tune k, chunk sizes and the percentile, and compare against
fixed-size chunking.

**Q: What are the failure modes?**
- Scanned PDFs have no text layer (OCR would be needed).
- Pages that render content in canvas or shadow DOM.
- A vague question with no selection retrieves weakly.
- Very long documents are truncated at 600k chars.
- Images and figures inside documents aren't indexed. Only the screenshot carries visual information.

**Q: Why brute-force cosine instead of a vector DB?**
At this scale (≤ a few thousand vectors) a linear scan takes milliseconds and has zero dependencies. An
index only pays off around 10^5+ vectors.

**Q: How would you add re-ranking or hybrid search?**
Retrieve the top ~30 by embeddings, add BM25 keyword hits (helpful for exact terms like variable names),
then re-rank with a cross-encoder or a cheap LLM call, and keep the top 6.

**Q: How does state survive the MV3 service worker being terminated?**
Nothing important lives in memory. The session is in IndexedDB, and settings and panel state are in
`chrome.storage`. Each message handler reloads what it needs.

**Q: How do you keep image tokens from growing with a long conversation?**
Only the latest screenshot is sent as an image. Earlier screenshots are replaced by their transcripts, and
history is windowed to the last 20 messages.

**Q: Privacy?**
- The page text, vectors and conversation stay in the browser's IndexedDB.
- Only chunk text (for embedding), the selected screenshot and the question go to OpenAI.
- Starting a new context window deletes everything locally.

**Q: Why an offscreen document for PDFs?**
Service workers have no DOM, and pdf.js needs a document plus a worker. The PDF viewer has no DOM for a
content script to read. An offscreen document is MV3's sanctioned place for DOM work in the background.

**Q: What would you build next?**
- Streaming responses.
- Hybrid search + re-ranking.
- Readability.js for extraction.
- OCR for scanned PDFs.
- Clickable citations that jump to the cited page or section.
- Summarizing the conversation once it goes past 20 messages.
- An eval set for retrieval.

---

## 7. Numbers worth remembering
- Embeddings: `text-embedding-3-small`, **512 dims**, batches of 96, 4 concurrent requests.
- Chunking: window ±1 sentence, **90th percentile** breakpoint, **300–2,000 chars** per chunk.
- Retrieval: **top-6** + each doc's first chunk, reading order.
- History: **last 20 messages**, only the latest screenshot sent as an image.
- Document cap: **600k chars** (~150k tokens, ~300 pages).
- Shortcuts: `Alt+Shift+R` select region, `Alt+Shift+C` context menu.
