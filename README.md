# Readie 📖

A universal reading copilot Chrome extension that works on any text displayed on your screen—research papers, PDFs, web articles, or technical docs. Simply select any area on your screen and ask questions in natural language to get clear explanations, summaries, or deep dives into complex ideas powered by OpenAI GPT-4.

## Features

- 🖱️ **Screen Selection**: Drag to select any area on any webpage
- 🤖 **Powered by GPT-4**: Uses OpenAI's latest vision model
- 🔒 **Privacy First**: Your API key stays local, direct calls to OpenAI
- ⚡ **No Backend Required**: Simple client-side extension
- 🎯 **Works Everywhere**: Any webpage, any content

## Quick Start

1. **Install**: Load the extension from the `extension/` folder
2. **Configure**: Add your OpenAI API key in settings
3. **Use**: Press `Cmd+Shift+R` (Mac) or `Ctrl+Shift+R` (Windows), drag to select, ask questions

See [extension/README.md](extension/README.md) for detailed installation and usage instructions.

## Architecture

```
Chrome Extension
    ↓ (Direct API calls)
OpenAI GPT-4 Vision API
```

Simple and straightforward - no backend server needed!

## Future Plans

- RAG integration for referencing research papers
- Query history
- Custom prompt templates
- Support for other LLM providers
