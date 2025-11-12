// Background service worker for Readie - OpenAI Only

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureTab') {
    handleCaptureTab(sendResponse);
    return true; // Keep channel open for async response
  }

  if (request.action === 'queryLLM') {
    handleLLMQuery(request.question, request.imageData)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

// Keyboard shortcut handler
chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-selection") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggleSelection" });
      }
    });
  }
});

// Capture visible tab screenshot
async function handleCaptureTab(sendResponse) {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
    sendResponse({ dataUrl });
  } catch (error) {
    sendResponse({ error: error.message });
  }
}

// Query OpenAI with image and question
async function handleLLMQuery(question, imageData) {
  try {
    // Get API key from storage
    const { openaiApiKey } = await chrome.storage.sync.get(['openaiApiKey']);

    if (!openaiApiKey) {
      throw new Error('OpenAI API key not configured. Please add it in settings.');
    }

    return await queryOpenAI(question, imageData, openaiApiKey);
  } catch (error) {
    console.error('OpenAI Query error:', error);
    return { error: error.message };
  }
}

// Query OpenAI GPT-4 Vision
async function queryOpenAI(question, imageBase64, apiKey) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${imageBase64}`
              }
            },
            {
              type: 'text',
              text: question
            }
          ]
        }
      ],
      max_tokens: 1000
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'OpenAI API request failed');
  }

  const data = await response.json();
  return {
    answer: data.choices[0].message.content,
    model: data.model,
    tokens_used: data.usage.total_tokens
  };
}
