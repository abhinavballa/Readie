// Background service worker for Readie - OpenAI Only
//
// Owns the Readie session: the ongoing conversation plus the RAG knowledge base
// of pages the user added (see rag.js). Content scripts in any tab talk to it,
// so the same session continues across tabs, page loads, and panel closes.

importScripts('rag.js');

const RETRIEVAL_TOP_K = 6;        // chunks sent with each question
const HISTORY_MESSAGES = 20;      // past messages sent to the model each turn

// Listen for messages from content scripts and the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Messages meant for the offscreen document are not ours
  if (request.target === 'offscreen') return;

  const tabUrl = request.url ?? sender.tab?.url;

  const reply = (promise) => {
    promise
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message || String(error) }));
    return true; // Keep channel open for async response
  };

  switch (request.action) {
    case 'captureTab':
      handleCaptureTab(sendResponse);
      return true;

    case 'getSession':
      return reply(getSession(tabUrl, request.includeMessages !== false));

    case 'addWebPage':
      return reply(addPage({
        fresh: request.fresh,
        url: tabUrl,
        title: request.title,
        source: 'webpage',
        sections: RAG.sectionsFromWebText(request.text || '')
      }));

    case 'addPdf':
      return reply(addPdf(tabUrl, request.title, request.fresh));

    case 'removePage':
      return reply(RAG.removeDocument(normalizeUrl(request.pageUrl || tabUrl))
        .then(() => afterSessionChange())
        .then(() => getSession(tabUrl, false)));

    case 'newSession':
      return reply(newSession().then(() => getSession(tabUrl, false)));

    case 'ask':
      return reply(handleQuestion(request.question, request.selection || null));
  }
});

// Keyboard shortcut handler
chrome.commands.onCommand.addListener((command) => {
  console.log('Readie: Command received:', command);
  const action = command === 'toggle-selection' ? 'toggleSelection'
    : command === 'context-menu' ? 'openContextMenu'
    : null;
  if (!action) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { action })
      .catch(error => {
        console.error('Readie: Error sending message to content script:', error);
        console.log('Readie: Please reload the webpage to activate Readie on this page');
      });
  });
});

// ---------- Session ----------

// What happens when you navigate to a page that isn't in the session:
//   'keep' – keep the session going (default)
//   'new'  – start a new context window automatically
async function getNavigationMode() {
  const { contextOnNavigate } = await chrome.storage.sync.get(['contextOnNavigate']);
  return contextOnNavigate === 'new' ? 'new' : 'keep';
}

// URL without the #fragment, so in-page anchor jumps count as the same page
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch (_) {
    return url || '';
  }
}

async function getApiKey() {
  const { openaiApiKey } = await chrome.storage.sync.get(['openaiApiKey']);
  if (!openaiApiKey) {
    throw new Error('OpenAI API key not configured. Please add it in settings.');
  }
  return openaiApiKey;
}

async function getSession(url, includeMessages = true) {
  const kb = RAG.summarize(await RAG.getKb());
  const messages = await RAG.getMessages();
  return {
    ...kb,
    mode: await getNavigationMode(),
    messageCount: messages.length,
    messages: includeMessages ? messages : undefined,
    currentPageIncluded: Boolean(url && kb.docs.some(d => d.url === normalizeUrl(url)))
  };
}

async function newSession() {
  await RAG.resetSession();
  await afterSessionChange();
}

async function addPage({ fresh, ...doc }) {
  const apiKey = await getApiKey();
  if (fresh) await RAG.resetSession();

  await RAG.addDocument({
    ...doc,
    url: normalizeUrl(doc.url),
    title: (doc.title || '').trim() || doc.url
  }, apiKey);

  await afterSessionChange();
  const session = await getSession(doc.url, false);
  session.added = session.docs.find(d => d.url === normalizeUrl(doc.url));
  return session;
}

// Badge on the toolbar icon shows how many pages are in the session
async function afterSessionChange() {
  const kb = await RAG.getKb();
  const count = kb.docs.length;
  await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
  await chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

chrome.runtime.onStartup.addListener(() => afterSessionChange().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => afterSessionChange().catch(() => {}));

// Optional: start a new context window when the active tab navigates to a new page
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url || !tab.active) return;
  if ((await getNavigationMode()) !== 'new') return;

  const kb = await RAG.getKb();
  const messages = await RAG.getMessages();
  if (kb.docs.length === 0 && messages.length === 0) return;

  const url = normalizeUrl(changeInfo.url);
  if (!kb.docs.some(d => d.url === url)) {
    await newSession();
  }
});

// ---------- PDF extraction via offscreen document (runs pdf.js) ----------

let creatingOffscreen = null;
let pdfJobsInFlight = 0;

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  if (contexts.length > 0) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Extract text from PDFs with pdf.js so they can be added to the reading context'
    }).finally(() => {
      creatingOffscreen = null;
    });
  }
  await creatingOffscreen;
}

async function extractPdf(url) {
  pdfJobsInFlight++;
  try {
    await ensureOffscreenDocument();
    const result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      action: 'extractPdfText',
      url,
      maxChars: RAG.MAX_DOC_CHARS
    });
    if (!result) throw new Error('PDF reader did not respond.');
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    pdfJobsInFlight--;
    if (pdfJobsInFlight === 0) {
      chrome.offscreen.closeDocument().catch(() => {});
    }
  }
}

async function addPdf(url, title, fresh) {
  await getApiKey(); // fail fast before downloading
  const pdf = await extractPdf(url);
  return addPage({
    fresh,
    url,
    title: pdf.title || title,
    source: 'pdf',
    numPages: pdf.numPages,
    truncated: pdf.truncated,
    // Text flows across PDF pages, so pages are labels, not hard chunk breaks
    sections: pdf.pages.map(p => ({ label: `page ${p.page}`, text: p.text, hardBreak: false }))
  });
}

// ---------- Questions ----------

// Capture visible tab screenshot
async function handleCaptureTab(sendResponse) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    sendResponse({ dataUrl });
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

// selection: { image: dataURL, pageUrl, pageTitle } | null
async function handleQuestion(question, selection) {
  const apiKey = await getApiKey();
  const history = await RAG.getMessages();

  // Transcribe a new screenshot once: it's the search query for RAG and stands
  // in for the image in later turns.
  if (selection && !selection.text) {
    selection.text = await transcribeSelection(selection.image, apiKey).catch(err => {
      console.warn('Readie: Could not transcribe selection:', err);
      return '';
    });
  }

  // Retrieve relevant chunks from the session's pages
  let retrieved = null;
  const kb = await RAG.getKb();
  if (kb.chunks.length > 0) {
    const lastSelection = selection || [...history].reverse().find(m => m.selection)?.selection;
    const previousQuestion = [...history].reverse().find(m => m.role === 'user')?.content || '';
    const searchQuery = [lastSelection?.text, previousQuestion, question].filter(Boolean).join('\n\n');
    retrieved = await RAG.retrieve(searchQuery, apiKey, RETRIEVAL_TOP_K);
  }

  const userMessage = { role: 'user', content: question, selection };
  const result = await queryOpenAI([...history, userMessage], retrieved, apiKey);

  const assistantMessage = {
    role: 'assistant',
    content: result.answer,
    meta: {
      model: result.model,
      tokens: result.tokens_used,
      excerpts: retrieved ? retrieved.chunks.length : 0,
      sources: retrieved ? [...new Set(retrieved.chunks.map(c => c.label).filter(Boolean))] : []
    }
  };

  await RAG.addMessage(userMessage);
  await RAG.addMessage(assistantMessage);

  return { userMessage, assistantMessage };
}

// Cheap one-off transcription of the selected region
async function transcribeSelection(imageDataUrl, apiKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          {
            type: 'text',
            text: 'Transcribe the text in this image exactly. If it contains figures, equations, ' +
              'tables, or code, describe them briefly. Output only the transcription.'
          }
        ]
      }]
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || 'Transcription request failed');
  }
  const data = await response.json();
  return data.choices[0].message.content || '';
}

function buildSystemPrompt(retrieved) {
  let prompt = `You are Readie, a reading assistant. The user is reading web pages and PDFs \
and asks you questions about them, often sharing a screenshot of the part they mean. \
This is one ongoing conversation that may span several pages and tabs.`;

  if (!retrieved || retrieved.chunks.length === 0) return prompt;

  const docTitle = new Map(retrieved.docs.map(d => [d.id, d.title]));
  const docList = retrieved.docs
    .map(d => `- "${d.title}" (${d.source === 'pdf' ? 'PDF' : 'web page'}, ${d.url})`)
    .join('\n');

  const excerpts = retrieved.chunks.map((c, i) => {
    const where = [`"${docTitle.get(c.docId)}"`, c.label].filter(Boolean).join(', ');
    return `[Excerpt ${i + 1} — ${where}]\n${c.text}`;
  }).join('\n\n');

  prompt += `

The user added these documents to the conversation's context:
${docList}

Below are excerpts retrieved from them because they relate to the current question. \
Use them to answer well: bring in definitions, notation, earlier explanations, results, \
and other sections that help explain what the user is asking about. When you rely on an \
excerpt, say where it comes from (document, section, or page). The excerpts are only parts \
of the documents; if they don't cover something, say so and answer from general knowledge.

<excerpts>
${excerpts}
</excerpts>`;
  return prompt;
}

// Turn stored messages into OpenAI messages. Only the most recent screenshot is
// sent as an image; older ones are replaced by their transcription.
function toOpenAIMessages(messages) {
  const recent = messages.slice(-HISTORY_MESSAGES);
  let lastImageIndex = -1;
  recent.forEach((m, i) => { if (m.selection?.image) lastImageIndex = i; });

  return recent.map((m, i) => {
    if (m.role !== 'user' || !m.selection) {
      return { role: m.role, content: m.content };
    }

    const where = m.selection.pageTitle ? ` on "${m.selection.pageTitle}"` : '';
    if (i === lastImageIndex) {
      return {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: m.selection.image } },
          { type: 'text', text: `[Screenshot of a region I selected${where}]\n\n${m.content}` }
        ]
      };
    }
    const text = m.selection.text ? `:\n"""\n${m.selection.text}\n"""` : '';
    return {
      role: 'user',
      content: `[Earlier I selected a region${where}${text}]\n\n${m.content}`
    };
  });
}

// Query OpenAI GPT-4o
async function queryOpenAI(messages, retrieved, apiKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: buildSystemPrompt(retrieved) },
        ...toOpenAIMessages(messages)
      ],
      max_tokens: 1000
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || 'OpenAI API request failed');
  }

  const data = await response.json();
  return {
    answer: data.choices[0].message.content,
    model: data.model,
    tokens_used: data.usage.total_tokens
  };
}
