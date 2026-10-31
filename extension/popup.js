// Popup script for Readie settings - OpenAI Only

document.addEventListener('DOMContentLoaded', async () => {
  const openaiKeyInput = document.getElementById('openaiKey');
  const saveButton = document.getElementById('save');
  const statusDiv = document.getElementById('status');

  // Load saved API key
  const { openaiApiKey } = await chrome.storage.sync.get(['openaiApiKey']);

  // Populate form with saved value
  if (openaiApiKey) {
    openaiKeyInput.value = openaiApiKey;
  }

  // Save API key
  saveButton.addEventListener('click', async () => {
    const openaiKey = openaiKeyInput.value.trim();

    // Validate that API key is provided
    if (!openaiKey) {
      showStatus('Please provide your OpenAI API key', 'error');
      return;
    }

    // Basic validation - OpenAI keys start with "sk-"
    if (!openaiKey.startsWith('sk-')) {
      showStatus('Invalid API key format. OpenAI keys start with "sk-"', 'error');
      return;
    }

    try {
      // Save API key
      await chrome.storage.sync.set({
        openaiApiKey: openaiKey
      });

      showStatus('API key saved successfully!', 'success');

      // Hide success message after 2 seconds
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 2000);

    } catch (error) {
      showStatus('Error saving API key: ' + error.message, 'error');
    }
  });

  // Show status message
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
  }

  // Toggle password visibility on click
  openaiKeyInput.addEventListener('click', function() {
    if (this.type === 'password') {
      this.type = 'text';
    }
  });

  openaiKeyInput.addEventListener('blur', function() {
    this.type = 'password';
  });

  // ---------- Context window ----------

  const sessionStatus = document.getElementById('sessionStatus');
  const newSessionBtn = document.getElementById('newSession');

  async function renderSession() {
    const session = await chrome.runtime.sendMessage({ action: 'getSession', includeMessages: false });
    if (!session || session.error) {
      sessionStatus.textContent = 'Could not load the current context.';
      return;
    }
    const pages = session.docs.length;
    sessionStatus.textContent = pages || session.messageCount
      ? `${pages} page${pages === 1 ? '' : 's'} in context · ${session.messageCount} message${session.messageCount === 1 ? '' : 's'}`
      : 'Empty. Press Alt+Shift+C on a page to add it.';
    if (pages) {
      sessionStatus.title = session.docs.map(d => d.title).join('\n');
    }
  }

  newSessionBtn.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ action: 'newSession' });
    renderSession();
  });

  const { contextOnNavigate } = await chrome.storage.sync.get(['contextOnNavigate']);
  const mode = contextOnNavigate === 'new' ? 'new' : 'keep';
  document.querySelectorAll('input[name="contextOnNavigate"]').forEach(radio => {
    radio.checked = radio.value === mode;
    radio.addEventListener('change', () => {
      if (radio.checked) chrome.storage.sync.set({ contextOnNavigate: radio.value });
    });
  });

  renderSession();
});
