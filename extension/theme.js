// theme.js — applies the Readie theme (see theme.css). Loaded by the content
// script on every page and by the settings popup.
//
// Settings in chrome.storage.sync:
//   theme:  'system' (default, follows the OS) | 'light' | 'dark'
//   accent: one of READIE_ACCENTS (default 'blue')

var READIE_THEMES = ['system', 'light', 'dark'];
var READIE_ACCENTS = ['blue', 'indigo', 'green', 'rose', 'orange', 'purple'];

function readieApplyTheme(settings) {
  var theme = READIE_THEMES.indexOf(settings && settings.theme) >= 0 ? settings.theme : 'system';
  var accent = READIE_ACCENTS.indexOf(settings && settings.accent) >= 0 ? settings.accent : 'blue';
  var root = document.documentElement;
  root.setAttribute('data-readie-theme', theme);
  root.setAttribute('data-readie-accent', accent);
  return { theme: theme, accent: accent };
}

// Apply the saved theme now and again whenever it changes (in any tab)
function readieWatchTheme() {
  try {
    chrome.storage.sync.get(['theme', 'accent']).then(readieApplyTheme, function () {});
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'sync' || !(changes.theme || changes.accent)) return;
      chrome.storage.sync.get(['theme', 'accent']).then(readieApplyTheme, function () {});
    });
  } catch (_) {
    // Extension was reloaded; the page keeps its current theme
  }
}

readieWatchTheme();
