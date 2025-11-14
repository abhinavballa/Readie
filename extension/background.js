// Background service worker for Readie - OpenAI Only

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'captureTab') {
    handleCaptureTab(sendResponse);
    return true; // Keep channel open for async response
  }

  if (request.action === 'queryLLM') {
    handleLLMQuery(request.question, request.imageData, request.conversationHistory)
      .then(response => sendResponse(response))
      .catch(error => sendResponse({ error: error.message }));
    return true; // Keep channel open for async response
  }
});

// Keyboard shortcut handler
chrome.commands.onCommand.addListener((command) => {
  console.log('Readie: Command received:', command);
  if (command === "toggle-selection") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        console.log('Readie: Sending toggle message to tab:', tabs[0].id);
        chrome.tabs.sendMessage(tabs[0].id, { action: "toggleSelection" })
          .catch(error => {
            console.error('Readie: Error sending message to content script:', error);
            console.log('Readie: Please reload the webpage to activate Readie on this page');
          });
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
async function handleLLMQuery(question, imageData, conversationHistory = []) {
  try {
    // Get API key from storage
    const { openaiApiKey } = await chrome.storage.sync.get(['openaiApiKey']);

    if (!openaiApiKey) {
      throw new Error('OpenAI API key not configured. Please add it in settings.');
    }

    return await queryOpenAI(question, imageData, conversationHistory, openaiApiKey);
  } catch (error) {
    console.error('OpenAI Query error:', error);
    return { error: error.message };
  }
}

// Query OpenAI GPT-4 Vision
async function queryOpenAI(question, imageBase64, conversationHistory, apiKey) {
  // Build messages array with conversation history
  const messages = [];

  // Add the image as the first message if this is the start of conversation
  if (conversationHistory.length === 0) {
    messages.push({
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
    });
  } else {
    // Include previous conversation history
    // First message should include the image
    messages.push({
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
          text: conversationHistory[0].content
        }
      ]
    });

    // Add rest of the conversation (excluding first user message)
    for (let i = 1; i < conversationHistory.length; i++) {
      messages.push({
        role: conversationHistory[i].role,
        content: conversationHistory[i].content
      });
    }

    // Add current question
    messages.push({
      role: 'user',
      content: question
    });
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: messages,
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
