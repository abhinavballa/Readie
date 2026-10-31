# Readie - Universal Reading Copilot

A Chrome extension that lets you highlight any text on your screen and ask questions about it using OpenAI GPT-4.

## Features

- 🖱️ **Screen Selection**: Drag to select any area on your screen
- 🤖 **Powered by GPT-4**: Uses OpenAI's latest vision model (GPT-4o)
- 🔒 **Privacy First**: API key stored locally, calls made directly to OpenAI
- ⚡ **Fast & Simple**: No backend server needed
- 🎯 **Works Everywhere**: Use on any webpage

## Installation

### 1. Get Your OpenAI API Key

Get your API key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys)

### 2. Load Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top-right)
3. Click "Load unpacked"
4. Select the `extension` folder from this repository
5. The Readie icon should appear in your extensions toolbar

### 3. Configure Settings

1. Click the Readie icon in your toolbar
2. Enter your OpenAI API key
3. Click "Save API Key"

## Usage

1. **Add context** (optional): Press `Alt+Shift+C` on any web page or PDF and choose **Add this page to context**
2. **Select**: Press `Alt+Shift+R` (or `Option+Shift+R` on Mac) and drag to select any area on the screen
3. **Ask**: Type your question about the selection (or ask without a selection)
4. **Get Answer**: Readie answers using your selection plus the most relevant parts of every page in context

### Context windows (RAG)

Readie keeps one ongoing conversation, the *context window*. It carries across tabs, page
loads and closing the panel, and lasts until you start a new one.

- `Alt+Shift+C` opens the context menu:
  1. **Add this page to context**. The page or PDF is indexed once and joins the current context. If the page is already added, this becomes **Re-index this page**, and **Remove this page from context** also appears.
  2. **New context window with this page** forgets the previous pages and conversation.
  3. **New empty context window**
  4. **Open / close chat**
- Pages are indexed once with **semantic chunking**. Each sentence is embedded with its
  neighbours, and a chunk ends where the topic shifts or at a heading. Chunks are embedded
  with OpenAI `text-embedding-3-small` and stored locally in IndexedDB.
- For each question, Readie transcribes your selection (once, with `gpt-4o-mini`) and looks up the
  most relevant chunks. Only those chunks are sent to GPT-4o, never the whole page.
- **Settings → "When I go to a new page"** chooses between keeping the context (default) and starting a new context window automatically.
- PDFs open in Chrome's viewer are read with pdf.js (bundled in `lib/pdfjs`). For local `file://` PDFs, turn on
  "Allow access to file URLs" for Readie in `chrome://extensions`.
- The chat panel can be dragged by its header. Double-click the header to re-center it.

### Example Use Cases

- 📄 Explain complex research papers
- 🔬 Understand technical diagrams
- 📊 Interpret data visualizations
- 💻 Debug code snippets
- 📚 Summarize long articles
- 🌐 Translate foreign language content

## Keyboard Shortcuts

- `Alt+Shift+R` (or `Option+Shift+R` on Mac) - Toggle selection mode
- `Alt+Shift+C` - Context menu (add this page, new context window, open chat)
- `Escape` - Cancel selection or close panel
- `Enter` - Submit question (Shift+Enter for new line)

## Privacy & Security

- ✅ API key stored locally in Chrome's sync storage
- ✅ No data sent to third-party servers
- ✅ Direct communication with OpenAI only
- ✅ No tracking or analytics

## Customization

You can customize the keyboard shortcut:
1. Go to `chrome://extensions/shortcuts`
2. Find "Readie"
3. Click the edit button to set your preferred shortcut

## Troubleshooting

### "API key not configured" error
- Make sure you've entered your OpenAI API key in the settings popup
- Verify the key starts with "sk-"

### Selection not working
- Try reloading the page
- Make sure you're pressing the correct keyboard shortcut (Alt+Shift+R or Option+Shift+R)
- Check if another extension is interfering

### Icons not showing
- You need to add icon files to the `icons/` folder
- Use 16x16, 48x48, and 128x128 PNG images

## Development

### Project Structure

```
extension/
├── manifest.json       # Extension configuration
├── background.js       # API calls and background logic
├── content.js          # Screen selection and UI
├── overlay.css         # Styling
├── popup.html          # Settings interface
├── popup.js            # Settings logic
└── icons/             # Extension icons
```

### Adding Icons

Create three PNG icons:
- `icons/icon16.png` - 16x16 pixels
- `icons/icon48.png` - 48x48 pixels
- `icons/icon128.png` - 128x128 pixels

## Future Enhancements

- [ ] RAG integration for referencing research papers
- [ ] History of past queries
- [ ] Custom prompt templates
- [ ] Export conversations
- [ ] Support for other LLM providers (Claude, Gemini)

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
