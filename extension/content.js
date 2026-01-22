// Content script for Readie - handles screen selection and UI

let isSelectionMode = false;
let selectionBox = null;
let startX, startY;
let overlay = null;
let queryPanel = null;
let conversationHistory = []; // Store conversation messages
let currentImageData = null; // Store current screenshot

// Listen for toggle command from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Readie content: Message received:', request.action);
  if (request.action === 'toggleSelection') {
    console.log('Readie content: Toggling selection mode');
    toggleSelectionMode();
  }
});

// Toggle selection mode
function toggleSelectionMode() {
  console.log('Readie: toggleSelectionMode called, current state:', isSelectionMode);
  if (isSelectionMode) {
    exitSelectionMode();
  } else {
    enterSelectionMode();
  }
}

// Enter selection mode
function enterSelectionMode() {
  isSelectionMode = true;

  // Create overlay
  overlay = document.createElement('div');
  overlay.id = 'readie-overlay';
  overlay.innerHTML = `
    <div class="readie-instruction">
      Press <strong>Alt+Shift+R</strong> again to cancel, or drag to select an area
    </div>
  `;
  document.body.appendChild(overlay);

  // Add mouse event listeners
  document.addEventListener('mousedown', handleMouseDown);
  document.addEventListener('mousemove', handleMouseMove);
  document.addEventListener('mouseup', handleMouseUp);

  // Press Escape to cancel
  document.addEventListener('keydown', handleEscape);
}

// Exit selection mode
function exitSelectionMode() {
  isSelectionMode = false;

  // Remove overlay
  if (overlay) {
    overlay.remove();
    overlay = null;
  }

  // Remove selection box if exists
  if (selectionBox) {
    selectionBox.remove();
    selectionBox = null;
  }

  // Remove event listeners
  document.removeEventListener('mousedown', handleMouseDown);
  document.removeEventListener('mousemove', handleMouseMove);
  document.removeEventListener('mouseup', handleMouseUp);
  document.removeEventListener('keydown', handleEscape);
}

// Handle escape key
function handleEscape(e) {
  if (e.key === 'Escape') {
    exitSelectionMode();
    closeQueryPanel();
  }
}

// Handle mouse down - start selection
function handleMouseDown(e) {
  if (!isSelectionMode) return;

  e.preventDefault();
  startX = e.clientX;
  startY = e.clientY;

  // Create selection box
  selectionBox = document.createElement('div');
  selectionBox.id = 'readie-selection-box';
  selectionBox.style.left = startX + 'px';
  selectionBox.style.top = startY + 'px';
  document.body.appendChild(selectionBox);
}

// Handle mouse move - update selection box
function handleMouseMove(e) {
  if (!isSelectionMode || !selectionBox) return;

  const currentX = e.clientX;
  const currentY = e.clientY;

  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);
  const left = Math.min(currentX, startX);
  const top = Math.min(currentY, startY);

  selectionBox.style.width = width + 'px';
  selectionBox.style.height = height + 'px';
  selectionBox.style.left = left + 'px';
  selectionBox.style.top = top + 'px';
}

// Handle mouse up - capture selection
async function handleMouseUp(e) {
  if (!isSelectionMode || !selectionBox) return;

  const rect = selectionBox.getBoundingClientRect();

  // Only proceed if selection is large enough
  if (rect.width < 20 || rect.height < 20) {
    selectionBox.remove();
    selectionBox = null;
    return;
  }

  // Exit selection mode
  exitSelectionMode();

  // Capture screenshot
  await captureAndQuery(rect);
}

// Capture screenshot and show query panel
async function captureAndQuery(rect) {
  try {
    // Show loading state
    showLoadingPanel();

    // Capture visible tab
    const response = await chrome.runtime.sendMessage({ action: 'captureTab' });

    if (response.error) {
      throw new Error(response.error);
    }

    // Crop the image to selection
    const croppedImage = await cropImage(response.dataUrl, rect);

    // Show query panel with cropped image
    showQueryPanel(croppedImage, rect);

  } catch (error) {
    console.error('Capture error:', error);
    alert('Failed to capture screenshot: ' + error.message);
  }
}

// Crop image to selection
function cropImage(dataUrl, rect) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      // Account for device pixel ratio
      const dpr = window.devicePixelRatio || 1;

      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;

      ctx.drawImage(
        img,
        rect.left * dpr,
        rect.top * dpr,
        rect.width * dpr,
        rect.height * dpr,
        0,
        0,
        canvas.width,
        canvas.height
      );

      resolve(canvas.toDataURL('image/png'));
    };
    img.src = dataUrl;
  });
}

// Show loading panel
function showLoadingPanel() {
  closeQueryPanel();

  queryPanel = document.createElement('div');
  queryPanel.id = 'readie-query-panel';
  queryPanel.innerHTML = `
    <div class="readie-panel-header">
      <h3>Readie</h3>
      <button class="readie-close-btn" onclick="this.closest('#readie-query-panel').remove()">×</button>
    </div>
    <div class="readie-panel-body">
      <div class="readie-loading">Capturing screenshot...</div>
    </div>
  `;
  document.body.appendChild(queryPanel);
}

// Show query panel
async function showQueryPanel(imageData) {
  closeQueryPanel();

  // Reset conversation for new screenshot
  conversationHistory = [];
  currentImageData = imageData;

  queryPanel = document.createElement('div');
  queryPanel.id = 'readie-query-panel';
  queryPanel.innerHTML = `
    <div class="readie-panel-header">
      <h3>Readie</h3>
      <button class="readie-close-btn">×</button>
    </div>
    <div class="readie-panel-body">
      <div class="readie-screenshot-preview">
        <img src="${imageData}" alt="Screenshot">
      </div>
      <div id="readie-chat-history" class="readie-chat-history"></div>
      <div class="readie-input-area">
        <textarea id="readie-question-input" placeholder="Ask a question about this image..."></textarea>
        <button id="readie-submit-btn">Ask</button>
      </div>
    </div>
  `;

  document.body.appendChild(queryPanel);

  // Add event listeners
  const closeBtn = queryPanel.querySelector('.readie-close-btn');
  closeBtn.addEventListener('click', closeQueryPanel);

  const submitBtn = queryPanel.querySelector('#readie-submit-btn');
  const questionInput = queryPanel.querySelector('#readie-question-input');

  submitBtn.addEventListener('click', () => {
    const question = questionInput.value.trim();
    if (question) {
      submitQuery(question);
    }
  });

  // Submit on Enter (Shift+Enter for new line)
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const question = questionInput.value.trim();
      if (question) {
        submitQuery(question);
      }
    }
  });

  // Focus on input
  questionInput.focus();
}

// Submit query to OpenAI
async function submitQuery(question) {
  const chatHistory = queryPanel.querySelector('#readie-chat-history');
  const submitBtn = queryPanel.querySelector('#readie-submit-btn');
  const questionInput = queryPanel.querySelector('#readie-question-input');

  // Add user message to history
  addMessageToChat('user', question);

  // Clear input
  questionInput.value = '';

  // Show loading
  const loadingId = addMessageToChat('assistant', '<div class="readie-loading">Thinking...</div>', true);
  submitBtn.disabled = true;
  questionInput.disabled = true;

  try {
    // Remove data:image/png;base64, prefix if present
    const base64Data = currentImageData.split(',')[1];

    // Send to background script with conversation history
    const response = await chrome.runtime.sendMessage({
      action: 'queryLLM',
      question: question,
      imageData: base64Data,
      conversationHistory: conversationHistory
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Remove loading message
    removeMessageFromChat(loadingId);

    // Add assistant response to history
    addMessageToChat('assistant', response.answer, false, response.model, response.tokens_used);

    // Store in conversation history
    conversationHistory.push({
      role: 'user',
      content: question
    });
    conversationHistory.push({
      role: 'assistant',
      content: response.answer
    });

  } catch (error) {
    console.error('Query error:', error);
    // Remove loading message
    removeMessageFromChat(loadingId);
    // Add error message
    addMessageToChat('error', error.message);
  } finally {
    submitBtn.disabled = false;
    questionInput.disabled = false;
    questionInput.focus();
  }
}

// Add message to chat history UI
function addMessageToChat(role, content, isLoading = false, model = null, tokens = null) {
  const chatHistory = queryPanel.querySelector('#readie-chat-history');
  const messageId = 'msg-' + Date.now() + '-' + Math.random();

  const messageDiv = document.createElement('div');
  messageDiv.id = messageId;
  messageDiv.className = `readie-message readie-message-${role}`;

  if (role === 'user') {
    messageDiv.innerHTML = `
      <div class="readie-message-label">You</div>
      <div class="readie-message-content">${escapeHtml(content)}</div>
    `;
  } else if (role === 'assistant') {
    let metaInfo = '';
    if (model && tokens) {
      metaInfo = `<div class="readie-message-meta">Model: ${model} | Tokens: ${tokens}</div>`;
    }
    messageDiv.innerHTML = `
      <div class="readie-message-label">Assistant</div>
      <div class="readie-message-content">${isLoading ? content : parseMarkdownContent(content)}</div>
      ${metaInfo}
    `;
  } else if (role === 'error') {
    messageDiv.innerHTML = `
      <div class="readie-message-label">Error</div>
      <div class="readie-message-content">${escapeHtml(content)}</div>
    `;
  }

  chatHistory.appendChild(messageDiv);

  // Scroll to bottom
  chatHistory.scrollTop = chatHistory.scrollHeight;

  return messageId;
}

// Remove message from chat (used for loading messages)
function removeMessageFromChat(messageId) {
  const message = document.getElementById(messageId);
  if (message) {
    message.remove();
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Parse markdown content and format code blocks
function parseMarkdownContent(text) {
  // First escape HTML
  let escaped = escapeHtml(text);

  // Match code blocks with optional language specifier: ```language\ncode\n```
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;

  let result = escaped.replace(codeBlockRegex, (match, language, code) => {
    const lang = language || 'code';
    const codeId = 'code-' + Date.now() + '-' + Math.random().toString(36).substring(2, 11);
    // Store code for overlay access
    return `<div class="readie-code-block" data-code-id="${codeId}" data-language="${lang}">
      <div class="readie-code-header">
        <span class="readie-code-lang">${lang}</span>
        <button class="readie-code-expand-btn" onclick="window.readieShowCodeOverlay('${codeId}')">Expand</button>
      </div>
      <pre class="readie-code-content"><code>${code.trim()}</code></pre>
    </div>`;
  });

  // Match inline code: `code`
  result = result.replace(/`([^`]+)`/g, '<code class="readie-inline-code">$1</code>');

  // Convert newlines to <br> for non-code content
  result = result.replace(/\n/g, '<br>');

  return result;
}

// Store code blocks for overlay access
const codeBlockStore = {};

// Show code overlay
window.readieShowCodeOverlay = function(codeId) {
  const codeBlock = document.querySelector(`[data-code-id="${codeId}"]`);
  if (!codeBlock) return;

  const code = codeBlock.querySelector('code').textContent;
  const language = codeBlock.dataset.language;

  // Create overlay
  const overlay = document.createElement('div');
  overlay.id = 'readie-code-overlay';
  overlay.innerHTML = `
    <div class="readie-code-overlay-backdrop"></div>
    <div class="readie-code-overlay-container">
      <div class="readie-code-overlay-header">
        <span class="readie-code-overlay-lang">${language}</span>
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

  document.body.appendChild(overlay);

  // Close on backdrop click
  overlay.querySelector('.readie-code-overlay-backdrop').addEventListener('click', () => {
    overlay.remove();
  });

  // Close button
  overlay.querySelector('.readie-code-close-btn').addEventListener('click', () => {
    overlay.remove();
  });

  // Copy button
  overlay.querySelector('.readie-code-copy-btn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      const copyBtn = overlay.querySelector('.readie-code-copy-btn');
      copyBtn.textContent = 'Copied!';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  });

  // Close on Escape
  const handleEscapeOverlay = (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
      document.removeEventListener('keydown', handleEscapeOverlay);
    }
  };
  document.addEventListener('keydown', handleEscapeOverlay);
};

// Close query panel
function closeQueryPanel() {
  if (queryPanel) {
    queryPanel.remove();
    queryPanel = null;
  }
}
