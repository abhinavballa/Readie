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

  // ---------- Theme ----------

  // theme.js already applied the saved theme; saving here updates every open tab too
  const themeSettings = readieApplyTheme(await chrome.storage.sync.get(['theme', 'accent']));
  for (const name of ['theme', 'accent']) {
    document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
      radio.checked = radio.value === themeSettings[name];
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        themeSettings[name] = radio.value;
        readieApplyTheme(themeSettings);
        chrome.storage.sync.set({ [name]: radio.value });
      });
    });
  }

  // ---------- Rating prompts and training data ----------

  const { feedbackRate } = await chrome.storage.sync.get(['feedbackRate']);
  const rate = ['always', 'sometimes', 'off'].includes(feedbackRate) ? feedbackRate : 'sometimes';
  document.querySelectorAll('input[name="feedbackRate"]').forEach(radio => {
    radio.checked = radio.value === rate;
    radio.addEventListener('change', () => {
      if (radio.checked) chrome.storage.sync.set({ feedbackRate: radio.value });
    });
  });

  const trainingStatus = document.getElementById('trainingStatus');
  const exportSftBtn = document.getElementById('exportSft');
  const exportAllBtn = document.getElementById('exportAll');
  const clearTrainingBtn = document.getElementById('clearTraining');

  function renderTrainingStats(stats) {
    if (!stats || stats.error) {
      trainingStatus.textContent = 'Could not load training data.';
      return;
    }
    trainingStatus.textContent = `${stats.satisfactory} satisfactory · ${stats.unsatisfactory} unsatisfactory`;
    exportSftBtn.disabled = stats.satisfactory === 0;
    exportAllBtn.disabled = stats.total === 0;
  }

  async function refreshTrainingStats() {
    renderTrainingStats(await chrome.runtime.sendMessage({ action: 'getTrainingStats' }));
  }

  // Save text as a file via a temporary link
  function download(filename, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/jsonl' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function exportTraining(rating, name) {
    const result = await chrome.runtime.sendMessage({ action: 'exportTrainingData', rating });
    if (!result || result.error) {
      showStatus('Export failed: ' + (result?.error || 'no response'), 'error');
      return;
    }
    if (result.count === 0) {
      showStatus('Nothing to export yet.', 'error');
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    download(`readie-${name}-${date}.jsonl`, result.jsonl);
  }

  exportSftBtn.addEventListener('click', () => exportTraining('satisfactory', 'finetune'));
  exportAllBtn.addEventListener('click', () => exportTraining('all', 'ratings'));

  // Two clicks to clear: the first one asks for confirmation
  let clearArmed = null;
  clearTrainingBtn.addEventListener('click', async () => {
    if (!clearArmed) {
      clearTrainingBtn.textContent = 'Click again to delete all training data';
      clearArmed = setTimeout(() => {
        clearArmed = null;
        clearTrainingBtn.textContent = 'Clear training data';
      }, 4000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    clearTrainingBtn.textContent = 'Clear training data';
    renderTrainingStats(await chrome.runtime.sendMessage({ action: 'clearTrainingData' }));
  });

  refreshTrainingStats();
});
