// Content script for Readie - screen selection, the chat panel, and the context menu.
// The conversation and the pages in context live in the background (one shared
// session), so the panel shows the same conversation in every tab and on every page.

let isSelectionMode = false;
let selectionBox = null;
let startX, startY;
let overlay = null;
let queryPanel = null;
let contextMenu = null;
let pendingSelection = null; // { image, pageUrl, pageTitle } attached to the next question
let isAsking = false;        // a question is waiting for its answer
let isIngesting = false;     // a page is being added to context

const PANEL_OPEN_KEY = 'readiePanelOpen';

// Listen for commands from background script
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'toggleSelection') toggleSelectionMode();
  if (request.action === 'openContextMenu') toggleContextMenu();
});

// ---------- Keep the panel open across pages and tabs ----------

async function isPanelMarkedOpen() {
  try {
    const data = await chrome.storage.local.get(PANEL_OPEN_KEY);
    return Boolean(data[PANEL_OPEN_KEY]);
  } catch (_) {
    return false; // extension was reloaded
  }
}

function markPanelOpen(open) {
  try {
    chrome.storage.local.set({ [PANEL_OPEN_KEY]: open });
  } catch (_) {
    // extension was reloaded
  }
}

async function syncPanelWithSession() {
  if (document.visibilityState !== 'visible') return;
  if (queryPanel) {
    refreshPanel();
  } else if (await isPanelMarkedOpen()) {
    openPanel();
  }
}

document.addEventListener('visibilitychange', syncPanelWithSession);
syncPanelWithSession();

// ---------- Screen selection ----------

function toggleSelectionMode() {
  if (isSelectionMode) {
    exitSelectionMode();
  } else {
    enterSelectionMode();
  }
}

function enterSelectionMode() {
  closeContextMenu();
  isSelectionMode = true;

  overlay = document.createElement('div');
  overlay.id = 'readie-overlay';
  overlay.innerHTML = `
    <div class="readie-instruction">
      Press <strong>Alt+Shift+R</strong> again to cancel, or drag to select an area
    </div>
  `;
  document.body.appendChild(overlay);

  document.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);
  document.addEventListener('keydown', handleEscape);
}

function exitSelectionMode() {
  isSelectionMode = false;

  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  if (selectionBox) {
    selectionBox.remove();
    selectionBox = null;
  }

  document.removeEventListener('mousedown', handleMouseDown);
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
  document.removeEventListener('keydown', handleEscape);
}

function handleEscape(e) {
  if (e.key === 'Escape') {
    exitSelectionMode();
  }
}

function handleMouseDown(e) {
  if (!isSelectionMode) return;

  e.preventDefault();
  startX = e.clientX;
  startY = e.clientY;

  selectionBox = document.createElement('div');
  selectionBox.id = 'readie-selection-box';
  selectionBox.style.left = startX + 'px';
  selectionBox.style.top = startY + 'px';
  document.body.appendChild(selectionBox);
}

function handleMouseMove(e) {
  if (!isSelectionMode || !selectionBox) return;

  const width = Math.abs(e.clientX - startX);
  const height = Math.abs(e.clientY - startY);
  selectionBox.style.width = width + 'px';
  selectionBox.style.height = height + 'px';
  selectionBox.style.left = Math.min(e.clientX, startX) + 'px';
  selectionBox.style.top = Math.min(e.clientY, startY) + 'px';
}

async function handleMouseUp() {
  if (!isSelectionMode || !selectionBox) return;

  const rect = selectionBox.getBoundingClientRect();

  // Only proceed if selection is large enough
  if (rect.width < 20 || rect.height < 20) {
    selectionBox.remove();
    selectionBox = null;
    return;
  }

  exitSelectionMode();
  await captureSelection(rect);
}

// Capture the selected area and attach it to the next question
async function captureSelection(rect) {
  try {
    // Hide the panel so it isn't in the screenshot
    if (queryPanel) queryPanel.style.visibility = 'hidden';
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    const response = await chrome.runtime.sendMessage({ action: 'captureTab' });
    if (queryPanel) queryPanel.style.visibility = '';
    if (response.error) throw new Error(response.error);

    pendingSelection = {
      image: await cropImage(response.dataUrl, rect),
      pageUrl: location.href,
      pageTitle: document.title
    };

    if (queryPanel) {
      renderAttachment();
      queryPanel.querySelector('#readie-question-input').focus();
    } else {
      await openPanel();
    }
  } catch (error) {
    if (queryPanel) queryPanel.style.visibility = '';
    console.error('Capture error:', error);
    showToast('Failed to capture screenshot: ' + error.message, 'error');
  }
}

function cropImage(dataUrl, rect) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;

      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.drawImage(
        img,
        rect.left * dpr, rect.top * dpr, rect.width * dpr, rect.height * dpr,
        0, 0, canvas.width, canvas.height
      );
      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// ---------- Chat panel ----------

async function openPanel() {
  closeContextMenu();
  if (!queryPanel) {
    queryPanel = document.createElement('div');
    queryPanel.id = 'readie-query-panel';
    queryPanel.innerHTML = `
      <div class="readie-panel-header">
        <h3>Readie</h3>
        <div class="readie-header-actions">
          <button class="readie-context-btn" title="Context menu (Alt+Shift+C)">Context ▾</button>
          <button class="readie-close-btn" title="Close (the conversation is kept)">×</button>
        </div>
      </div>
      <div class="readie-panel-body">
        <div class="readie-sources"></div>
        <div id="readie-chat-history" class="readie-chat-history"></div>
        <div class="readie-attachment"></div>
        <div class="readie-input-area">
          <textarea id="readie-question-input" placeholder="Ask a question…"></textarea>
          <button id="readie-submit-btn">Ask</button>
        </div>
      </div>
    `;
    document.body.appendChild(queryPanel);

    if (typeof readieMakeDraggable === 'function') {
      readieMakeDraggable(queryPanel, queryPanel.querySelector('.readie-panel-header'));
    }

    queryPanel.querySelector('.readie-close-btn').addEventListener('click', closePanel);
    queryPanel.querySelector('.readie-context-btn').addEventListener('click', () => toggleContextMenu());
    queryPanel.addEventListener('click', handlePanelClick);

    const submitBtn = queryPanel.querySelector('#readie-submit-btn');
    const questionInput = queryPanel.querySelector('#readie-question-input');
    submitBtn.addEventListener('click', () => submitQuestion());
    questionInput.addEventListener('keydown', (e) => {
      // Submit on Enter (Shift+Enter for new line)
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitQuestion();
      }
    });
  }

  markPanelOpen(true);
  renderAttachment();
  await refreshPanel();
  queryPanel?.querySelector('#readie-question-input').focus();
}

function closePanel() {
  if (queryPanel) {
    queryPanel.remove();
    queryPanel = null;
  }
  pendingSelection = null;
  markPanelOpen(false);
}

// Pull the latest session (pages + conversation) from the background
async function refreshPanel() {
  if (!queryPanel) return;
  let session;
  try {
    session = await chrome.runtime.sendMessage({ action: 'getSession' });
  } catch (error) {
    return; // extension was reloaded
  }
  if (!queryPanel || !session || session.error) return;

  renderSources(session);

  // Don't wipe a question that is still waiting for its answer
  if (isAsking) return;

  const chatHistory = queryPanel.querySelector('#readie-chat-history');
  chatHistory.innerHTML = '';
  if (session.messages.length === 0) {
    chatHistory.innerHTML = `<div class="readie-empty-state">
      Drag-select part of the page with <strong>Alt+Shift+R</strong>, or just ask a question.
      Add pages to context with <strong>Alt+Shift+C</strong>.
    </div>`;
  }
  for (const m of session.messages) {
    addMessageToChat(m);
  }
}

function renderSources(session) {
  const box = queryPanel.querySelector('.readie-sources');
  if (session.docs.length === 0) {
    box.innerHTML = '<div class="readie-sources-summary readie-muted">No pages in context</div>';
    return;
  }

  const open = box.dataset.open === 'true';
  const words = session.words.toLocaleString();
  box.innerHTML = `
    <button class="readie-sources-summary" data-toggle-sources>
      📄 ${session.docs.length} page${session.docs.length > 1 ? 's' : ''} in context · ${words} words <span class="readie-caret">${open ? '▴' : '▾'}</span>
    </button>
    <ul class="readie-sources-list" ${open ? '' : 'hidden'}>
      ${session.docs.map(d => `
        <li>
          <a href="${escapeHtml(d.url)}" target="_blank" rel="noopener" title="${escapeHtml(d.url)}">${escapeHtml(d.title)}</a>
          <span class="readie-muted">${d.source === 'pdf' && d.numPages ? d.numPages + ' pp · ' : ''}${d.chunkCount} chunks${d.truncated ? ' · truncated' : ''}</span>
          <button class="readie-source-remove" data-remove-url="${escapeHtml(d.url)}" title="Remove from context">×</button>
        </li>`).join('')}
    </ul>
  `;
}

function renderAttachment() {
  if (!queryPanel) return;
  const box = queryPanel.querySelector('.readie-attachment');
  if (!pendingSelection) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = `
    <div class="readie-screenshot-preview">
      <img src="${pendingSelection.image}" alt="Selected area">
      <button class="readie-attachment-remove" title="Remove selection">×</button>
    </div>
  `;
}

// One click handler for everything inside the panel
async function handlePanelClick(e) {
  const t = e.target;

  const toggle = t.closest('[data-toggle-sources]');
  if (toggle) {
    const box = queryPanel.querySelector('.readie-sources');
    const open = box.dataset.open !== 'true';
    box.dataset.open = String(open);
    box.querySelector('.readie-sources-list').hidden = !open;
    toggle.querySelector('.readie-caret').textContent = open ? '▴' : '▾';
    return;
  }

  const removeBtn = t.closest('[data-remove-url]');
  if (removeBtn) {
    await chrome.runtime.sendMessage({ action: 'removePage', pageUrl: removeBtn.dataset.removeUrl });
    refreshPanel();
    return;
  }

  if (t.closest('.readie-attachment-remove')) {
    pendingSelection = null;
    renderAttachment();
    return;
  }

  const expandBtn = t.closest('.readie-code-expand-btn');
  if (expandBtn) {
    showCodeOverlay(expandBtn.closest('.readie-code-block'));
  }
}

async function submitQuestion() {
  if (!queryPanel || isAsking) return;
  const submitBtn = queryPanel.querySelector('#readie-submit-btn');
  const questionInput = queryPanel.querySelector('#readie-question-input');
  const question = questionInput.value.trim();
  if (!question) return;

  const selection = pendingSelection;
  queryPanel.querySelector('.readie-empty-state')?.remove();
  addMessageToChat({ role: 'user', content: question, selection });
  const loadingId = addMessageToChat({ role: 'loading' });

  questionInput.value = '';
  pendingSelection = null;
  renderAttachment();
  isAsking = true;
  submitBtn.disabled = true;
  questionInput.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'ask', question, selection });
    if (!response || response.error) throw new Error(response?.error || 'No response');
    removeMessageFromChat(loadingId);
    addMessageToChat(response.assistantMessage);
  } catch (error) {
    console.error('Query error:', error);
    removeMessageFromChat(loadingId);
    addMessageToChat({ role: 'error', content: error.message });
    // Let the user retry with the same selection
    if (selection && !pendingSelection) {
      pendingSelection = selection;
      renderAttachment();
    }
  } finally {
    isAsking = false;
    if (queryPanel) {
      submitBtn.disabled = false;
      questionInput.disabled = false;
      questionInput.focus();
    }
  }
}

// Add a message to the chat UI. Returns its element id.
function addMessageToChat(message) {
  if (!queryPanel) return null;
  const chatHistory = queryPanel.querySelector('#readie-chat-history');
  const messageId = 'readie-msg-' + Date.now() + '-' + Math.random().toString(36).slice(2);

  const div = document.createElement('div');
  div.id = messageId;

  if (message.role === 'user') {
    div.className = 'readie-message readie-message-user';
    const sel = message.selection;
    div.innerHTML = `
      <div class="readie-message-label">You</div>
      ${sel?.image ? `<img class="readie-message-thumb" src="${sel.image}" alt="Selection" title="${escapeHtml(sel.pageTitle || '')}">` : ''}
      <div class="readie-message-content">${escapeHtml(message.content)}</div>
    `;
  } else if (message.role === 'assistant') {
    div.className = 'readie-message readie-message-assistant';
    const meta = message.meta || {};
    const parts = [];
    if (meta.model) parts.push(meta.model);
    if (meta.tokens) parts.push(`${meta.tokens} tokens`);
    if (meta.excerpts) {
      const sources = meta.sources?.length ? ` (${meta.sources.slice(0, 4).join(', ')})` : '';
      parts.push(`${meta.excerpts} excerpts${sources}`);
    }
    div.innerHTML = `
      <div class="readie-message-label">Assistant</div>
      <div class="readie-message-content">${parseMarkdownContent(message.content)}</div>
      ${parts.length ? `<div class="readie-message-meta">${escapeHtml(parts.join(' · '))}</div>` : ''}
    `;
  } else if (message.role === 'loading') {
    div.className = 'readie-message readie-message-assistant';
    div.innerHTML = `
      <div class="readie-message-label">Assistant</div>
      <div class="readie-message-content"><div class="readie-loading">Thinking...</div></div>
    `;
  } else {
    div.className = 'readie-message readie-message-error';
    div.innerHTML = `
      <div class="readie-message-label">Error</div>
      <div class="readie-message-content">${escapeHtml(message.content)}</div>
    `;
  }

  chatHistory.appendChild(div);
  chatHistory.scrollTop = chatHistory.scrollHeight;
  return messageId;
}

function removeMessageFromChat(messageId) {
  document.getElementById(messageId)?.remove();
}

// ---------- Context menu (Alt+Shift+C) ----------

async function toggleContextMenu() {
  if (contextMenu) {
    closeContextMenu();
    return;
  }
  if (isSelectionMode) exitSelectionMode();

  let session;
  try {
    session = await chrome.runtime.sendMessage({ action: 'getSession', includeMessages: false });
  } catch (error) {
    showToast('Readie was updated. Please reload this page.', 'error');
    return;
  }
  if (!session || session.error) {
    showToast('Could not read the session: ' + (session?.error || 'unknown error'), 'error');
    return;
  }

  const here = session.currentPageIncluded;
  const items = [
    {
      label: here ? 'Re-index this page' : 'Add this page to context',
      hint: here ? 'Refresh this page’s text in the current context' : 'Keep the conversation; add this page to what Readie knows',
      run: () => addCurrentPage(false)
    },
    here && {
      label: 'Remove this page from context',
      hint: 'Readie stops using this page',
      run: removeCurrentPage
    },
    {
      label: 'New context window with this page',
      hint: 'Forget previous pages and conversation, start fresh with this page',
      run: () => addCurrentPage(true)
    },
    {
      label: 'New empty context window',
      hint: 'Forget previous pages and conversation',
      run: startNewSession
    },
    {
      label: queryPanel ? 'Close chat' : 'Open chat',
      hint: 'Show or hide the conversation',
      run: () => (queryPanel ? closePanel() : openPanel())
    }
  ].filter(Boolean);

  const pages = session.docs.length;
  const summary = pages || session.messageCount
    ? `Current context: ${pages} page${pages === 1 ? '' : 's'} · ${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`
    : 'Current context is empty';

  contextMenu = document.createElement('div');
  contextMenu.id = 'readie-context-menu';
  contextMenu.innerHTML = `
    <div class="readie-menu-header">
      <strong>Readie context</strong>
      <span class="readie-muted">${escapeHtml(summary)}</span>
    </div>
    <ul class="readie-menu-list">
      ${items.map((item, i) => `
        <li><button data-index="${i}">
          <kbd>${i + 1}</kbd>
          <span><span class="readie-menu-label">${escapeHtml(item.label)}</span>
          <span class="readie-menu-hint">${escapeHtml(item.hint)}</span></span>
        </button></li>`).join('')}
    </ul>
    <div class="readie-menu-footer readie-muted">Press a number, or Esc to close</div>
  `;
  document.body.appendChild(contextMenu);

  const choose = (index) => {
    const item = items[index];
    if (!item) return;
    closeContextMenu();
    item.run();
  };

  contextMenu.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-index]');
    if (btn) choose(Number(btn.dataset.index));
  });

  contextMenu._onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeContextMenu();
    } else if (/^[1-9]$/.test(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      choose(Number(e.key) - 1);
    }
  };
  contextMenu._onOutside = (e) => {
    if (contextMenu && !contextMenu.contains(e.target) && !e.target.closest?.('.readie-context-btn')) {
      closeContextMenu();
    }
  };
  document.addEventListener('keydown', contextMenu._onKey, true);
  document.addEventListener('mousedown', contextMenu._onOutside, true);
  contextMenu.querySelector('button')?.focus();
}

function closeContextMenu() {
  if (!contextMenu) return;
  document.removeEventListener('keydown', contextMenu._onKey, true);
  document.removeEventListener('mousedown', contextMenu._onOutside, true);
  contextMenu.remove();
  contextMenu = null;
}

async function addCurrentPage(fresh) {
  if (isIngesting) {
    showToast('Readie is busy, try again in a moment.', 'info');
    return;
  }
  isIngesting = true;
  const pdf = isPdfPage();
  showToast(pdf ? 'Reading and indexing PDF…' : 'Reading and indexing page…', 'loading');

  try {
    const response = pdf
      ? await chrome.runtime.sendMessage({ action: 'addPdf', title: document.title, fresh })
      : await chrome.runtime.sendMessage({
        action: 'addWebPage',
        title: document.title,
        text: extractPageText(),
        fresh
      });

    if (!response || response.error) {
      throw new Error(response?.error || 'Could not add this page.');
    }

    const d = response.added;
    const pages = d.numPages ? ` (${d.numPages} pages)` : '';
    const total = response.docs.length;
    showToast(
      `${fresh ? 'New context window: ' : 'Added: '}“${d.title}”${pages} — ${d.chunkCount} chunks. ` +
      `${total} page${total === 1 ? '' : 's'} in context.` +
      (d.truncated ? ' (Very long, so only the first part was indexed.)' : ''),
      'success'
    );
    if (fresh) pendingSelection = null;
    refreshPanel();
  } catch (error) {
    console.error('Readie: Add page error:', error);
    showToast('Could not add page: ' + error.message, 'error');
  } finally {
    isIngesting = false;
  }
}

async function removeCurrentPage() {
  await chrome.runtime.sendMessage({ action: 'removePage' });
  showToast('Removed this page from context.', 'info');
  refreshPanel();
}

async function startNewSession() {
  await chrome.runtime.sendMessage({ action: 'newSession' });
  pendingSelection = null;
  renderAttachment();
  showToast('Started a new, empty context window.', 'info');
  refreshPanel();
}

// ---------- Page text extraction ----------

// Chrome's PDF viewer reports the PDF content type on the outer document
function isPdfPage() {
  if (document.contentType === 'application/pdf') return true;
  const embed = document.querySelector('embed[type="application/pdf"]');
  return Boolean(embed && document.body && document.body.children.length <= 2);
}

const SKIP_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe',
  'nav', 'footer', 'aside', '[role="navigation"]', '[aria-hidden="true"]',
  '[id^="readie-"]'
].join(',');

const BLOCK_TAGS = new Set([
  'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'UL', 'OL', 'LI', 'DL', 'DT', 'DD',
  'TABLE', 'TR', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'BR', 'HR'
]);
const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

// Pick the main content area if the page has one, else the whole body
function findContentRoot() {
  const body = document.body;
  if (!body) return document.documentElement;
  const bodyLength = body.textContent.length || 1;

  const candidates = [
    ...document.querySelectorAll('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]')
  ].filter(Boolean);

  let best = null;
  for (const el of candidates) {
    const len = el.textContent.length;
    if (len >= bodyLength * 0.35 && (!best || len > best.textContent.length)) {
      best = el;
    }
  }
  return best || body;
}

// Visible text of the page. Headings are marked "## " so the indexer can use
// them as section boundaries. Menus and Readie's own UI are skipped.
function extractPageText() {
  const parts = [];

  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.nodeValue);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.matches(SKIP_SELECTOR)) continue;
      if (child.checkVisibility && !child.checkVisibility()) continue;

      if (HEADING_TAGS.has(child.tagName)) {
        const heading = child.innerText.replace(/\s+/g, ' ').trim();
        if (heading) parts.push(`\n## ${heading}\n`);
        continue;
      }

      const isBlock = BLOCK_TAGS.has(child.tagName);
      if (isBlock) parts.push('\n');
      walk(child);
      if (isBlock) parts.push('\n');
    }
  };

  walk(findContentRoot());

  return parts.join('')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- Toasts ----------

let toastEl = null;
let toastTimer = null;

function showToast(message, type = 'info') {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'readie-toast';
    document.body.appendChild(toastEl);
  }
  clearTimeout(toastTimer);
  toastEl.className = `readie-toast readie-toast-${type}`;
  toastEl.textContent = message;

  if (type !== 'loading') {
    toastTimer = setTimeout(() => {
      toastEl?.remove();
      toastEl = null;
    }, type === 'error' ? 7000 : 4500);
  }
}

// ---------- Rendering helpers ----------

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML.replace(/"/g, '&quot;');
}

// Parse markdown content and format code blocks
function parseMarkdownContent(text) {
  let escaped = escapeHtml(text);

  // Code blocks with optional language: ```language\ncode\n```
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  let result = escaped.replace(codeBlockRegex, (match, language, code) => {
    const lang = language || 'code';
    return `<div class="readie-code-block" data-language="${lang}">
      <div class="readie-code-header">
        <span class="readie-code-lang">${lang}</span>
        <button class="readie-code-expand-btn">Expand</button>
      </div>
      <pre class="readie-code-content"><code>${code.trim()}</code></pre>
    </div>`;
  });

  // Inline code: `code`
  result = result.replace(/`([^`]+)`/g, '<code class="readie-inline-code">$1</code>');

  // Newlines to <br>, except inside code blocks
  result = result.split(/(<pre[\s\S]*?<\/pre>)/).map((part, i) =>
    i % 2 === 1 ? part : part.replace(/\n/g, '<br>')).join('');

  return result;
}

function showCodeOverlay(codeBlock) {
  if (!codeBlock) return;
  const code = codeBlock.querySelector('code').textContent;
  const language = codeBlock.dataset.language;

  const codeOverlay = document.createElement('div');
  codeOverlay.id = 'readie-code-overlay';
  codeOverlay.innerHTML = `
    <div class="readie-code-overlay-backdrop"></div>
    <div class="readie-code-overlay-container">
      <div class="readie-code-overlay-header">
        <span class="readie-code-overlay-lang">${escapeHtml(language)}</span>
        <div class="readie-code-overlay-actions">
          <button class="readie-code-copy-btn">Copy</button>
          <button class="readie-code-close-btn">Close</button>
        </div>
      </div>
      <div class="readie-code-overlay-body">
        <pre><code>${escapeHtml(code)}</code></pre>
      </div>
    </div>
  `;
  document.body.appendChild(codeOverlay);

  const close = () => {
    codeOverlay.remove();
    document.removeEventListener('keydown', onEscape);
  };
  const onEscape = (e) => {
    if (e.key === 'Escape') close();
  };

  codeOverlay.querySelector('.readie-code-overlay-backdrop').addEventListener('click', close);
  codeOverlay.querySelector('.readie-code-close-btn').addEventListener('click', close);
  codeOverlay.querySelector('.readie-code-copy-btn').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(code);
      e.target.textContent = 'Copied!';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  });
  document.addEventListener('keydown', onEscape);
}
