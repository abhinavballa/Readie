// Content script for Readie - handles screen selection and UI

let isSelectionMode = false;
let selectionBox = null;
let startX, startY;
let overlay = null;
let queryPanel = null;

// Listen for toggle command from background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'toggleSelection') {
    toggleSelectionMode();
  }
});

// Toggle selection mode
function toggleSelectionMode() {
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
      Press <strong>Cmd+Shift+R</strong> again to cancel, or drag to select an area
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
async function showQueryPanel(imageData, rect) {
  closeQueryPanel();

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
      <div class="readie-input-area">
        <textarea id="readie-question-input" placeholder="Ask a question about this image..."></textarea>
        <button id="readie-submit-btn">Ask</button>
      </div>
      <div id="readie-answer-area" class="readie-answer-area" style="display: none;"></div>
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
      submitQuery(question, imageData);
    }
  });

  // Submit on Enter (Shift+Enter for new line)
  questionInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const question = questionInput.value.trim();
      if (question) {
        submitQuery(question, imageData);
      }
    }
  });

  // Focus on input
  questionInput.focus();
}

// Submit query to OpenAI
async function submitQuery(question, imageData) {
  const answerArea = queryPanel.querySelector('#readie-answer-area');
  const submitBtn = queryPanel.querySelector('#readie-submit-btn');
  const questionInput = queryPanel.querySelector('#readie-question-input');

  // Show loading
  answerArea.style.display = 'block';
  answerArea.innerHTML = '<div class="readie-loading">Thinking...</div>';
  submitBtn.disabled = true;
  questionInput.disabled = true;

  try {
    // Remove data:image/png;base64, prefix if present
    const base64Data = imageData.split(',')[1];

    // Send to background script
    const response = await chrome.runtime.sendMessage({
      action: 'queryLLM',
      question: question,
      imageData: base64Data
    });

    if (response.error) {
      throw new Error(response.error);
    }

    // Show answer
    answerArea.innerHTML = `
      <div class="readie-answer">
        <strong>Answer:</strong>
        <p>${response.answer.replace(/\n/g, '<br>')}</p>
        <div class="readie-meta">
          Model: ${response.model} | Tokens: ${response.tokens_used}
        </div>
      </div>
    `;

  } catch (error) {
    console.error('Query error:', error);
    answerArea.innerHTML = `
      <div class="readie-error">
        <strong>Error:</strong> ${error.message}
      </div>
    `;
  } finally {
    submitBtn.disabled = false;
    questionInput.disabled = false;
  }
}

// Close query panel
function closeQueryPanel() {
  if (queryPanel) {
    queryPanel.remove();
    queryPanel = null;
  }
}
