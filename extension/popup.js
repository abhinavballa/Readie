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
});
