// Offscreen document for Readie - extracts text from PDFs with pdf.js.
// Chrome's built-in PDF viewer has no readable DOM, so the background script
// asks this page to download the PDF and pull out its text.

import * as pdfjsLib from './lib/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdfjs/pdf.worker.min.mjs');

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Content scripts' messages reach this page too; only handle ours.
  if (request.target !== 'offscreen' || request.action !== 'extractPdfText') return;

  extractPdfText(request.url, request.maxChars)
    .then(result => sendResponse(result))
    .catch(error => sendResponse({ error: error.message || String(error) }));
  return true; // Keep channel open for async response
});

// Download the PDF. XHR (unlike fetch) can also read file:// URLs when the
// user has enabled "Allow access to file URLs" for the extension.
function downloadPdf(url) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'arraybuffer';
    xhr.withCredentials = true;
    xhr.onload = () => {
      // file:// requests report status 0 on success
      if ((xhr.status === 200 || xhr.status === 0) && xhr.response && xhr.response.byteLength > 0) {
        resolve(xhr.response);
      } else {
        reject(new Error(`Could not download the PDF (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => {
      const hint = url.startsWith('file:')
        ? ' For local files, enable "Allow access to file URLs" for Readie in chrome://extensions.'
        : '';
      reject(new Error('Could not download the PDF.' + hint));
    };
    xhr.send();
  });
}

async function extractPdfText(url, maxChars) {
  const data = await downloadPdf(url);
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;

  let title = '';
  try {
    const meta = await pdf.getMetadata();
    title = (meta?.info?.Title || '').trim();
  } catch (_) {
    // Metadata is optional
  }

  // One entry per page so chunks can cite page numbers
  const pages = [];
  let totalChars = 0;
  let truncated = false;

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();

    let pageText = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      pageText += item.str;
      pageText += item.hasEOL ? '\n' : ' ';
    }
    pageText = pageText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    page.cleanup();

    if (!pageText) continue;

    if (totalChars + pageText.length > maxChars) {
      pageText = pageText.slice(0, Math.max(0, maxChars - totalChars));
      truncated = true;
    }
    pages.push({ page: pageNum, text: pageText });
    totalChars += pageText.length;
    if (truncated) break;
  }

  const numPages = pdf.numPages;
  await pdf.destroy();

  if (pages.length === 0) {
    throw new Error('No text found in this PDF (it may be a scanned image).');
  }

  return { pages, title, numPages, truncated };
}
