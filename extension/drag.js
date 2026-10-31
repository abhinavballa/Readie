// drag.js — makes the Readie panel draggable by its header and remembers its position.
// Classic content script; loaded before content.js, which calls readieMakeDraggable().

var READIE_POS_KEY = 'readiePanelPosition';
var READIE_MIN_VISIBLE = 40; // px of the panel that must stay visible horizontally

// Panels currently wired up; pruned when they leave the DOM so nothing leaks.
var readieDragPanels = readieDragPanels || new Set();

// Clamp a {left, top} so the header stays reachable inside the viewport.
function readieClampPos(panelEl, handleEl, left, top) {
  var w = panelEl.offsetWidth;
  var headerH = handleEl.offsetHeight || 40;
  var maxLeft = window.innerWidth - READIE_MIN_VISIBLE;
  var minLeft = READIE_MIN_VISIBLE - w;
  var maxTop = Math.max(0, window.innerHeight - headerH);
  return {
    left: Math.round(Math.min(Math.max(left, minLeft), maxLeft)),
    top: Math.round(Math.min(Math.max(top, 0), maxTop))
  };
}

// Pin the panel at explicit pixel coordinates (drops the centering transform).
function readieApplyPos(panelEl, handleEl, left, top) {
  var p = readieClampPos(panelEl, handleEl, left, top);
  panelEl.style.transform = 'none';
  panelEl.style.left = p.left + 'px';
  panelEl.style.top = p.top + 'px';
  panelEl.dataset.readieDragged = '1';
  return p;
}

// Back to the stylesheet's centered default.
function readieResetPos(panelEl) {
  panelEl.style.removeProperty('transform');
  panelEl.style.removeProperty('left');
  panelEl.style.removeProperty('top');
  delete panelEl.dataset.readieDragged;
}

function readieStorage() {
  try {
    return (chrome && chrome.runtime && chrome.runtime.id && chrome.storage && chrome.storage.local) || null;
  } catch (e) {
    return null; // extension context invalidated
  }
}

// One shared resize listener re-clamps every live panel.
function readieOnResize() {
  readieDragPanels.forEach(function (entry) {
    if (!entry.panel.isConnected) { readieDragPanels.delete(entry); return; }
    if (entry.panel.dataset.readieDragged) {
      readieApplyPos(entry.panel, entry.handle,
        parseFloat(entry.panel.style.left) || 0, parseFloat(entry.panel.style.top) || 0);
    }
  });
  if (readieDragPanels.size === 0) window.removeEventListener('resize', readieOnResize);
}

function readieMakeDraggable(panelEl, handleEl) {
  if (!panelEl || !handleEl || panelEl.dataset.readieDraggable) return;
  panelEl.dataset.readieDraggable = '1';
  handleEl.classList.add('readie-drag-handle');

  // Drop entries for panels that were removed, then register this one.
  readieDragPanels.forEach(function (e) { if (!e.panel.isConnected) readieDragPanels.delete(e); });
  readieDragPanels.add({ panel: panelEl, handle: handleEl });
  window.removeEventListener('resize', readieOnResize);
  window.addEventListener('resize', readieOnResize);

  var NO_DRAG = 'button, input, textarea, select, a, [contenteditable="true"]';
  var drag = null; // { id, dx, dy, moved, prevSelect }
  var userMoved = false; // set once the user drags, so a late storage read won't override it

  // Restore saved position (async).
  var store = readieStorage();
  if (store) {
    try {
      store.get(READIE_POS_KEY, function (res) {
        try {
          var pos = res && res[READIE_POS_KEY];
          if (userMoved || !panelEl.isConnected || !pos) return;
          if (typeof pos.left === 'number' && typeof pos.top === 'number') {
            readieApplyPos(panelEl, handleEl, pos.left, pos.top);
          }
        } catch (e) { /* ignore */ }
      });
    } catch (e) { /* context invalidated */ }
  }

  function save(pos) {
    var s = readieStorage();
    if (!s) return;
    try {
      var data = {};
      data[READIE_POS_KEY] = pos;
      s.set(data);
    } catch (e) { /* context invalidated */ }
  }

  function endDrag(e) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var d = drag;
    drag = null; // clear first: releasing capture may re-enter via lostpointercapture
    document.body.style.userSelect = d.prevSelect;
    handleEl.classList.remove('readie-dragging');
    try { handleEl.releasePointerCapture(d.id); } catch (err) { /* already released */ }
    if (d.moved) {
      save({ left: parseFloat(panelEl.style.left) || 0, top: parseFloat(panelEl.style.top) || 0 });
    }
  }

  handleEl.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || (e.target.closest && e.target.closest(NO_DRAG))) return;
    // Convert from centered transform to explicit pixels without a jump.
    var rect = panelEl.getBoundingClientRect();
    if (!panelEl.dataset.readieDragged) readieApplyPos(panelEl, handleEl, rect.left, rect.top);
    rect = panelEl.getBoundingClientRect();
    drag = {
      id: e.pointerId,
      dx: e.clientX - rect.left,
      dy: e.clientY - rect.top,
      moved: false,
      prevSelect: document.body.style.userSelect
    };
    document.body.style.userSelect = 'none';
    handleEl.classList.add('readie-dragging');
    try { handleEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });

  handleEl.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.moved = userMoved = true;
    readieApplyPos(panelEl, handleEl, e.clientX - drag.dx, e.clientY - drag.dy);
  });

  handleEl.addEventListener('pointerup', endDrag);
  handleEl.addEventListener('pointercancel', endDrag);
  handleEl.addEventListener('lostpointercapture', endDrag);

  // Double-click header: recenter and forget the saved position.
  handleEl.addEventListener('dblclick', function (e) {
    if (e.target.closest && e.target.closest(NO_DRAG)) return;
    userMoved = true;
    readieResetPos(panelEl);
    var s = readieStorage();
    if (s) { try { s.remove(READIE_POS_KEY); } catch (err) { /* ignore */ } }
  });
}
