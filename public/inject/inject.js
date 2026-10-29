/*
 * In-page editor runtime. Loaded inside the preview iframe (same origin as the
 * host app). Talks to the host via postMessage.
 *
 *   host -> page : getHtml | command | insertHtml | insertImage | delete | setFreeMove
 *                  setStyle | setAttr | undo | redo | selectPath | setScroll
 *   page -> host : ready | select | change | html | scroll
 */
(function () {
  'use strict';
  if (window.__wsed) return;
  const DISABLED_TYPE = 'text/x-wsed-disabled';
  const EDITABLE_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'A', 'LI', 'TD', 'TH', 'BUTTON', 'LABEL', 'BLOCKQUOTE', 'FIGCAPTION', 'CAPTION', 'DT', 'DD', 'PRE', 'CODE', 'SMALL', 'STRONG', 'EM', 'B', 'I', 'U', 'SUMMARY', 'LEGEND', 'OPTION', 'CITE', 'Q', 'ADDRESS', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'NAV', 'TIME', 'MARK', 'SUB', 'SUP', 'DEL', 'INS']);
  const VOID_TAGS = new Set(['IMG', 'INPUT', 'HR', 'BR', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'SVG', 'SELECT', 'TEXTAREA', 'EMBED', 'OBJECT', 'PICTURE']);

  const state = {
    selected: null,
    editing: null,
    freeMove: false,
    undo: [],
    redo: [],
    suppress: 0,
  };

  const post = (msg) => window.parent !== window && window.parent.postMessage(Object.assign({ wsed: true }, msg), '*');

  // ---------- overlay ----------
  const overlay = document.createElement('div');
  overlay.className = 'wsed-overlay';
  overlay.setAttribute('data-wsed', 'overlay');
  overlay.innerHTML = '<div class="wsed-label"></div>' +
    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<div class="wsed-handle ${d}" data-dir="${d}"></div>`).join('');
  overlay.style.display = 'none';
  const dropline = document.createElement('div');
  dropline.className = 'wsed-dropline';
  dropline.setAttribute('data-wsed', 'dropline');
  dropline.style.display = 'none';
  const label = overlay.querySelector('.wsed-label');

  function mount() {
    document.body.appendChild(overlay);
    document.body.appendChild(dropline);
  }

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.hasAttribute('data-wsed') || !!node.closest('[data-wsed]');
  }

  function describe(el) {
    if (!el) return null;
    const style = getComputedStyle(el);
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className.replace(/\bwsed-\S+/g, '').trim() : '',
      path: pathOf(el),
      href: el.getAttribute('href'),
      src: el.getAttribute('src'),
      alt: el.getAttribute('alt'),
      text: (el.textContent || '').trim().slice(0, 60),
      style: {
        color: style.color, backgroundColor: style.backgroundColor, fontSize: style.fontSize,
        fontFamily: style.fontFamily, textAlign: style.textAlign, position: style.position,
        width: el.style.width, height: el.style.height, padding: el.style.padding, margin: el.style.margin,
        borderRadius: el.style.borderRadius,
      },
      inlineStyle: el.getAttribute('style') || '',
      editing: state.editing === el,
      canEditText: canEditText(el),
    };
  }

  function pathOf(el) {
    const parts = [];
    while (el && el.nodeType === 1 && el !== document.documentElement) {
      let i = 0, s = el;
      while ((s = s.previousElementSibling)) if (!isOurs(s)) i++;
      parts.unshift(el.tagName.toLowerCase() + ':' + i);
      el = el.parentElement;
    }
    return parts.join('/');
  }
  function elementAtPath(p) {
    let el = document.documentElement;
    for (const part of (p || '').split('/').filter(Boolean)) {
      const [tag, idx] = part.split(':');
      let i = -1, found = null;
      for (const c of el.children) {
        if (isOurs(c)) continue;
        i++;
        if (i === +idx) { found = c; break; }
      }
      if (!found || found.tagName.toLowerCase() !== tag) return null;
      el = found;
    }
    return el;
  }

  function canEditText(el) {
    if (!el || VOID_TAGS.has(el.tagName)) return false;
    if (!EDITABLE_TAGS.has(el.tagName)) return false;
    // containers full of block children are better edited child-by-child
    const blockKids = [...el.children].filter((c) => !isOurs(c) && getComputedStyle(c).display !== 'inline' && !['A', 'SPAN', 'B', 'I', 'EM', 'STRONG', 'U', 'SMALL', 'CODE', 'BR', 'MARK', 'SUB', 'SUP'].includes(c.tagName));
    if (blockKids.length && !el.childNodes.length) return false;
    return !(blockKids.length > 0 && [...el.childNodes].every((n) => n.nodeType !== 3 || !n.textContent.trim()));
  }

  function positionOverlay() {
    const el = state.selected;
    if (!el || !el.isConnected) { overlay.style.display = 'none'; return; }
    const r = el.getBoundingClientRect();
    const sx = window.scrollX, sy = window.scrollY;
    overlay.style.display = '';
    overlay.style.left = r.left + sx + 'px';
    overlay.style.top = r.top + sy + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.classList.toggle('wsed-editing', state.editing === el);
    label.textContent = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (state.editing === el ? ' (editing)' : '');
    label.style.top = r.top + sy < 22 ? '0px' : '-22px';
  }

  function select(el, opts) {
    opts = opts || {};
    if (el && (isOurs(el) || el === document.body || el === document.documentElement)) el = null;
    if (state.editing && state.editing !== el) stopEditing();
    if (state.selected && state.selected !== el) { state.selected.classList.remove('wsed-selected'); if (!state.selected.classList.length) state.selected.removeAttribute('class'); }
    state.selected = el;
    if (el) el.classList.add('wsed-selected');
    positionOverlay();
    if (!opts.silent) post({ type: 'select', info: describe(el) });
  }

  // ---------- text editing ----------
  function startEditing(el, ev) {
    if (!canEditText(el)) return false;
    if (state.editing === el) return true;
    if (state.editing) stopEditing();
    pushUndo();
    state.editing = el;
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-wsed-ce', '1');
    el.focus({ preventScroll: true });
    if (ev && document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (range && el.contains(range.startContainer)) {
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      }
    } else if (ev && document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (pos && el.contains(pos.offsetNode)) {
        const range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); range.collapse(true);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      }
    }
    positionOverlay();
    post({ type: 'select', info: describe(el) });
    return true;
  }
  function stopEditing() {
    const el = state.editing;
    if (!el) return;
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-wsed-ce');
    state.editing = null;
    positionOverlay();
    if (el === state.selected) post({ type: 'select', info: describe(el) });
  }

  // ---------- undo / redo (whole-body snapshots) ----------
  function snapshot() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('[data-wsed]').forEach((n) => n.remove());
    return { html: clone.innerHTML, path: state.selected ? pathOf(state.selected) : null };
  }
  function restore(snap) {
    state.suppress++;
    stopEditing();
    const keep = [overlay, dropline];
    document.body.innerHTML = snap.html;
    keep.forEach((n) => document.body.appendChild(n));
    state.suppress--;
    select(snap.path ? elementAtPath(snap.path) : null);
    notifyChange();
  }
  function pushUndo() {
    state.undo.push(snapshot());
    if (state.undo.length > 100) state.undo.shift();
    state.redo.length = 0;
  }
  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
  }
  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
  }

  // ---------- change tracking ----------
  let changeTimer = null;
  function notifyChange() {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { positionOverlay(); post({ type: 'change', html: serialize() }); }, 250);
  }
  const observer = new MutationObserver((muts) => {
    if (state.suppress) return;
    for (const m of muts) {
      if (isOurs(m.target)) continue;
      if (m.type === 'attributes') {
        if (m.attributeName === 'class') {
          const before = (m.oldValue || '').replace(/\bwsed-\S+/g, '').trim().split(/\s+/).sort().join(' ');
          const after = (m.target.getAttribute('class') || '').replace(/\bwsed-\S+/g, '').trim().split(/\s+/).sort().join(' ');
          if (before === after) continue;
        }
        if (m.attributeName === 'contenteditable' || (m.attributeName || '').startsWith('data-wsed')) continue;
      }
      if (m.type === 'childList') {
        const nodes = [...m.addedNodes, ...m.removedNodes];
        if (nodes.length && nodes.every((n) => n.nodeType === 1 && isOurs(n))) continue;
      }
      notifyChange();
      return;
    }
  });

  // ---------- serialisation ----------
  function serialize() {
    const fragment = !!document.querySelector('meta[data-wsed="fragment"]');
    const root = document.documentElement.cloneNode(true);
    root.querySelectorAll('[data-wsed]').forEach((n) => n.remove());
    root.querySelectorAll('[data-wsed-ce]').forEach((n) => { n.removeAttribute('contenteditable'); n.removeAttribute('data-wsed-ce'); });
    root.querySelectorAll('*').forEach((n) => { for (const a of [...n.attributes]) if (a.name.startsWith('data-wsed') && a.name !== 'data-wsed-type') n.removeAttribute(a.name); });
    root.querySelectorAll('.wsed-selected, .wsed-hover, .wsed-dragging, .wsed-dropinside').forEach((n) => {
      n.classList.remove('wsed-selected', 'wsed-hover', 'wsed-dragging', 'wsed-dropinside');
      if (!n.classList.length) n.removeAttribute('class');
    });
    root.querySelectorAll('script').forEach((s) => {
      if (s.getAttribute('type') === DISABLED_TYPE) {
        s.removeAttribute('type');
        if (s.hasAttribute('data-wsed-type')) { s.setAttribute('type', s.getAttribute('data-wsed-type')); s.removeAttribute('data-wsed-type'); }
      }
    });
    root.querySelectorAll('[class=""]').forEach((n) => n.removeAttribute('class'));
    root.classList.remove('wsed-freemove');
    if (!root.classList.length) root.removeAttribute('class');
    // a partial (no <html>/<body> in the file): save just the content, not the wrapper the parser added
    if (fragment) return root.querySelector('head').innerHTML + root.querySelector('body').innerHTML;
    let doctype = '';
    if (document.doctype) {
      const d = document.doctype;
      doctype = '<!DOCTYPE ' + d.name + (d.publicId ? ' PUBLIC "' + d.publicId + '"' : '') + (!d.publicId && d.systemId ? ' SYSTEM' : '') + (d.systemId ? ' "' + d.systemId + '"' : '') + '>\n';
    }
    // comments outside <html> (e.g. a leading template comment) live on the document node
    const outside = (nodes) => nodes.filter((n) => n.nodeType === 8).map((n) => '<!--' + n.data + '-->\n').join('');
    const kids = [...document.childNodes];
    const at = kids.indexOf(document.documentElement);
    return doctype + outside(kids.slice(0, at)) + root.outerHTML + '\n' + outside(kids.slice(at + 1));
  }

  // ---------- pointer interactions: select, drag (reorder / free move), resize ----------
  let drag = null;
  let hoverEl = null;

  function targetFromEvent(ev) {
    let el = ev.target;
    if (el && el.nodeType === 3) el = el.parentElement;
    if (!el || isOurs(el)) return null;
    if (el === document.body || el === document.documentElement) return null;
    if (el.closest('[data-wsed-ro]')) return null;
    return el;
  }

  document.addEventListener('pointermove', (ev) => {
    if (drag) return onDragMove(ev);
    const el = targetFromEvent(ev);
    if (el !== hoverEl) {
      if (hoverEl) { hoverEl.classList.remove('wsed-hover'); if (!hoverEl.classList.length) hoverEl.removeAttribute('class'); }
      hoverEl = el && el !== state.selected ? el : null;
      if (hoverEl) hoverEl.classList.add('wsed-hover');
    }
  }, true);

  document.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    const t = ev.target;
    if (t.classList && t.classList.contains('wsed-handle') && state.selected) {
      ev.preventDefault();
      pushUndo();
      const r = state.selected.getBoundingClientRect();
      drag = { kind: 'resize', dir: t.dataset.dir, startX: ev.clientX, startY: ev.clientY, w: r.width, h: r.height, el: state.selected };
      return;
    }
    if (t === label && state.selected) {
      ev.preventDefault();
      beginMove(state.selected, ev);
      return;
    }
    const el = targetFromEvent(ev);
    if (!el) { if (!isOurs(t)) select(null); return; }
    if (state.editing && state.editing.contains(el)) return; // let the caret move inside the editable element
    if (ev.target.tagName === 'A' || ev.target.closest('a')) ev.preventDefault();
    if (el === state.selected) {
      // click on an already-selected element: prepare for drag or (on mouseup without move) text edit
      ev.preventDefault();
      beginMove(el, ev, true);
      return;
    }
    ev.preventDefault();
    select(el);
    beginMove(el, ev);
  }, true);

  function beginMove(el, ev, editOnRelease) {
    drag = { kind: 'move', el, startX: ev.clientX, startY: ev.clientY, moved: false, editOnRelease: !!editOnRelease, ev };
  }

  function onDragMove(ev) {
    if (drag.kind === 'resize') {
      ev.preventDefault();
      const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY, d = drag.dir;
      const el = drag.el;
      if (d.includes('e')) el.style.width = Math.max(4, drag.w + dx) + 'px';
      if (d.includes('w')) el.style.width = Math.max(4, drag.w - dx) + 'px';
      if (d.includes('s')) el.style.height = Math.max(4, drag.h + dy) + 'px';
      if (d.includes('n')) el.style.height = Math.max(4, drag.h - dy) + 'px';
      positionOverlay();
      return;
    }
    const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;
    if (!drag.moved) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      drag.moved = true;
      pushUndo();
      if (state.editing) stopEditing();
      if (state.freeMove) {
        const el = drag.el;
        const cs = getComputedStyle(el);
        if (cs.position === 'static' || cs.position === 'relative') {
          const r = el.getBoundingClientRect();
          const parent = el.offsetParent || document.body;
          const pr = parent.getBoundingClientRect();
          el.style.position = 'absolute';
          el.style.left = Math.round(r.left - pr.left - parseFloat(getComputedStyle(parent).borderLeftWidth || 0)) + 'px';
          el.style.top = Math.round(r.top - pr.top - parseFloat(getComputedStyle(parent).borderTopWidth || 0)) + 'px';
          if (!el.style.width && cs.display !== 'inline') el.style.width = Math.round(r.width) + 'px';
          el.style.margin = '0';
        }
        drag.left = parseFloat(el.style.left) || 0;
        drag.top = parseFloat(el.style.top) || 0;
      } else {
        drag.el.classList.add('wsed-dragging');
      }
    }
    ev.preventDefault();
    if (state.freeMove) {
      drag.el.style.left = Math.round(drag.left + dx) + 'px';
      drag.el.style.top = Math.round(drag.top + dy) + 'px';
      positionOverlay();
    } else {
      updateDropTarget(ev);
    }
  }

  function updateDropTarget(ev) {
    drag.el.style.pointerEvents = 'none';
    let target = document.elementFromPoint(ev.clientX, ev.clientY);
    drag.el.style.pointerEvents = '';
    if (!drag.el.getAttribute('style')) drag.el.removeAttribute('style');
    if (target && target.nodeType === 3) target = target.parentElement;
    clearDropIndicator();
    if (!target || isOurs(target) || target === drag.el || drag.el.contains(target)) { drag.drop = null; return; }
    if (target === document.documentElement) target = document.body;
    const r = target.getBoundingClientRect();
    const cs = getComputedStyle(target);
    const inlineish = cs.display.startsWith('inline') || cs.display === 'table-cell';
    let drop;
    const kids = [...target.children].filter((c) => !isOurs(c) && c !== drag.el);
    if (target !== document.body && isContainer(target) && kids.length && insideCenter(ev, r)) {
      // Cursor is over a container's padding/gap: place next to the nearest child.
      let best = null, bestD = Infinity;
      for (const k of kids) {
        const kr = k.getBoundingClientRect();
        const dx = Math.max(kr.left - ev.clientX, 0, ev.clientX - kr.right);
        const dy = Math.max(kr.top - ev.clientY, 0, ev.clientY - kr.bottom);
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = k; }
      }
      const kr = best.getBoundingClientRect();
      const horizontal = Math.abs(ev.clientX - (kr.left + kr.width / 2)) / kr.width > Math.abs(ev.clientY - (kr.top + kr.height / 2)) / kr.height;
      const before = horizontal ? ev.clientX < kr.left + kr.width / 2 : ev.clientY < kr.top + kr.height / 2;
      drop = { ref: best, mode: before ? 'before' : 'after' };
      if (horizontal) showDropline('vertical', before ? kr.left : kr.right, kr.top, kr.height);
      else showDropline('horizontal', kr.left, before ? kr.top : kr.bottom, kr.width);
    } else if (target === document.body || (isContainer(target) && !kids.length && insideCenter(ev, r))) {
      drop = { ref: target, mode: 'inside' };
      target.classList.add('wsed-dropinside');
    } else if (inlineish || (cs.display === 'flex' || cs.display === 'inline-flex') && target.parentElement && getComputedStyle(target.parentElement).flexDirection === 'row') {
      const before = ev.clientX < r.left + r.width / 2;
      drop = { ref: target, mode: before ? 'before' : 'after' };
      showDropline('vertical', before ? r.left : r.right, r.top, r.height);
    } else {
      const parentFlexRow = target.parentElement && /^(inline-)?flex$/.test(getComputedStyle(target.parentElement).display) && /row/.test(getComputedStyle(target.parentElement).flexDirection || 'row') && getComputedStyle(target.parentElement).flexWrap !== 'wrap';
      const grid = target.parentElement && /grid$/.test(getComputedStyle(target.parentElement).display);
      if (parentFlexRow || grid) {
        const before = ev.clientX < r.left + r.width / 2;
        drop = { ref: target, mode: before ? 'before' : 'after' };
        showDropline('vertical', before ? r.left : r.right, r.top, r.height);
      } else {
        const before = ev.clientY < r.top + r.height / 2;
        drop = { ref: target, mode: before ? 'before' : 'after' };
        showDropline('horizontal', r.left, before ? r.top : r.bottom, r.width);
      }
    }
    drag.drop = drop;
  }
  function isContainer(el) {
    return ['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER', 'ASIDE', 'NAV', 'UL', 'OL', 'FORM', 'FIGURE', 'FIELDSET', 'TR', 'TBODY', 'TABLE'].includes(el.tagName) && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
  }
  function insideCenter(ev, r) {
    const mx = Math.min(24, r.width * 0.25), my = Math.min(24, r.height * 0.25);
    return ev.clientX > r.left + mx && ev.clientX < r.right - mx && ev.clientY > r.top + my && ev.clientY < r.bottom - my;
  }
  function showDropline(orient, x, y, len) {
    dropline.className = 'wsed-dropline ' + orient;
    dropline.style.display = '';
    if (orient === 'horizontal') { dropline.style.left = x + scrollX + 'px'; dropline.style.top = y + scrollY - 1 + 'px'; dropline.style.width = len + 'px'; dropline.style.height = ''; }
    else { dropline.style.left = x + scrollX - 1 + 'px'; dropline.style.top = y + scrollY + 'px'; dropline.style.height = len + 'px'; dropline.style.width = ''; }
  }
  function clearDropIndicator() {
    dropline.style.display = 'none';
    document.querySelectorAll('.wsed-dropinside').forEach((n) => n.classList.remove('wsed-dropinside'));
  }

  document.addEventListener('pointerup', (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.kind === 'resize') { positionOverlay(); return; }
    if (!d.moved) {
      if (d.editOnRelease) startEditing(d.el, d.ev);
      return;
    }
    d.el.classList.remove('wsed-dragging');
    clearDropIndicator();
    if (!state.freeMove && d.drop) {
      const { ref, mode } = d.drop;
      if (mode === 'inside') ref.appendChild(d.el);
      else if (mode === 'before') ref.parentNode.insertBefore(d.el, ref);
      else ref.parentNode.insertBefore(d.el, ref.nextSibling);
    }
    select(d.el);
  }, true);

  document.addEventListener('dblclick', (ev) => {
    const el = targetFromEvent(ev);
    if (!el) return;
    ev.preventDefault();
    // double-click: edit innermost text element under the cursor
    let t = el;
    while (t && !canEditText(t) && t !== document.body) t = t.parentElement;
    if (t && t !== document.body) { select(t); startEditing(t, ev); }
  }, true);

  document.addEventListener('click', (ev) => {
    // read-only include / macro output: open the template it comes from
    const ro = ev.target.closest && ev.target.closest('[data-wsed-ro]');
    if (ro) {
      ev.preventDefault();
      const file = ro.getAttribute('data-wsed-ro');
      if (file) post({ type: 'openTemplate', name: file });
      return;
    }
    // never navigate away while editing
    const a = ev.target.closest && ev.target.closest('a');
    if (a && !isOurs(a)) ev.preventDefault();
    if (ev.target.closest && ev.target.closest('form') && ['SUBMIT', 'submit'].includes(ev.target.type)) ev.preventDefault();
  }, true);
  document.addEventListener('submit', (ev) => ev.preventDefault(), true);
  // Native HTML5 drag (images, links, selected text) would hijack our pointer-based drag.
  document.addEventListener('dragstart', (ev) => { if (!isOurs(ev.target)) ev.preventDefault(); }, true);
  document.addEventListener('selectstart', (ev) => { if (!state.editing && drag && drag.kind === 'move') ev.preventDefault(); }, true);
  document.addEventListener('pointercancel', () => { if (drag) { if (drag.el) drag.el.classList.remove('wsed-dragging'); clearDropIndicator(); drag = null; } }, true);

  document.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (ev.key === 'Escape') {
      if (state.editing) { stopEditing(); ev.preventDefault(); }
      else if (state.selected) { select(null); ev.preventDefault(); }
      return;
    }
    if (state.editing) {
      if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); post({ type: 'save' }); }
      return; // native editing / undo within the element
    }
    if (mod && ev.key.toLowerCase() === 's') { ev.preventDefault(); post({ type: 'save' }); return; }
    if (mod && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
    if (mod && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); return; }
    if (!state.selected) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); deleteSelected(); return; }
    if (ev.key === 'Enter') { ev.preventDefault(); startEditing(state.selected); return; }
    if (mod && ev.key.toLowerCase() === 'd') { ev.preventDefault(); duplicateSelected(); return; }
    if (ev.key === 'ArrowUp' && ev.altKey) { ev.preventDefault(); nudgeOrder(-1); return; }
    if (ev.key === 'ArrowDown' && ev.altKey) { ev.preventDefault(); nudgeOrder(1); return; }
    if (/^Arrow/.test(ev.key) && state.freeMove) {
      ev.preventDefault();
      const el = state.selected, step = ev.shiftKey ? 10 : 1;
      if (getComputedStyle(el).position === 'static') return;
      if (ev.key === 'ArrowLeft') el.style.left = (parseFloat(el.style.left) || 0) - step + 'px';
      if (ev.key === 'ArrowRight') el.style.left = (parseFloat(el.style.left) || 0) + step + 'px';
      if (ev.key === 'ArrowUp') el.style.top = (parseFloat(el.style.top) || 0) - step + 'px';
      if (ev.key === 'ArrowDown') el.style.top = (parseFloat(el.style.top) || 0) + step + 'px';
      positionOverlay();
    }
  }, true);

  function deleteSelected() {
    const el = state.selected; if (!el) return;
    pushUndo();
    const next = el.nextElementSibling || el.previousElementSibling || el.parentElement;
    el.remove();
    select(next && next !== document.body && !isOurs(next) ? next : null);
  }
  function duplicateSelected() {
    const el = state.selected; if (!el) return;
    pushUndo();
    const copy = el.cloneNode(true);
    copy.classList.remove('wsed-selected', 'wsed-hover');
    if (copy.id) copy.id = copy.id + '-copy';
    el.parentNode.insertBefore(copy, el.nextSibling);
    select(copy);
  }
  function nudgeOrder(dir) {
    const el = state.selected; if (!el) return;
    pushUndo();
    if (dir < 0 && el.previousElementSibling) el.parentNode.insertBefore(el, el.previousElementSibling);
    if (dir > 0 && el.nextElementSibling && !isOurs(el.nextElementSibling)) el.parentNode.insertBefore(el.nextElementSibling, el);
    positionOverlay();
  }

  function insertHtml(html) {
    pushUndo();
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    const node = tpl.content.firstElementChild;
    if (!node) return;
    if (state.editing && state.editing.isConnected) {
      // inline insertion at caret
      const sel = window.getSelection();
      if (sel && sel.rangeCount && state.editing.contains(sel.anchorNode)) {
        const range = sel.getRangeAt(0); range.deleteContents(); range.insertNode(node); range.collapse(false);
        select(node); return;
      }
    }
    const anchor = state.selected;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
    else document.body.insertBefore(node, overlay);
    node.scrollIntoView({ block: 'nearest' });
    select(node);
  }

  function applyCommand(name, value) {
    const el = state.editing || state.selected;
    if (!el) return;
    if (state.editing) {
      // rich text inside the contenteditable element
      document.execCommand(name, false, value);
      return;
    }
    pushUndo();
    switch (name) {
      case 'bold': toggleStyle(el, 'fontWeight', 'bold', (v) => v === 'bold' || parseInt(v, 10) >= 600); break;
      case 'italic': toggleStyle(el, 'fontStyle', 'italic', (v) => v === 'italic'); break;
      case 'underline': toggleStyle(el, 'textDecoration', 'underline', (v) => v.includes('underline')); break;
      case 'justifyLeft': el.style.textAlign = 'left'; break;
      case 'justifyCenter': el.style.textAlign = 'center'; break;
      case 'justifyRight': el.style.textAlign = 'right'; break;
      case 'formatBlock': changeTag(el, value.replace(/[<>]/g, '')); break;
      case 'createLink': wrapOrSet(el, 'href', value); break;
      case 'unlink': if (el.tagName === 'A') unwrap(el); break;
      case 'insertUnorderedList': changeTag(el, 'ul'); break;
      case 'insertOrderedList': changeTag(el, 'ol'); break;
      default: document.execCommand(name, false, value);
    }
    positionOverlay();
  }
  function toggleStyle(el, prop, on, isOn) {
    const cur = getComputedStyle(el)[prop];
    el.style[prop] = isOn(cur) ? (prop === 'textDecoration' ? 'none' : 'normal') : on;
  }
  function changeTag(el, tag) {
    if (!tag || el.tagName.toLowerCase() === tag) return;
    const n = document.createElement(tag);
    for (const a of el.attributes) n.setAttribute(a.name, a.value);
    if (tag === 'ul' || tag === 'ol') {
      if (el.tagName === 'UL' || el.tagName === 'OL') { while (el.firstChild) n.appendChild(el.firstChild); }
      else { const li = document.createElement('li'); while (el.firstChild) li.appendChild(el.firstChild); n.appendChild(li); }
    } else {
      while (el.firstChild) n.appendChild(el.firstChild);
    }
    el.parentNode.replaceChild(n, el);
    select(n);
  }
  function wrapOrSet(el, attr, value) {
    if (el.tagName === 'A') { el.setAttribute(attr, value); return; }
    const a = document.createElement('a'); a.setAttribute(attr, value);
    el.parentNode.insertBefore(a, el); a.appendChild(el);
  }
  function unwrap(el) { const p = el.parentNode; while (el.firstChild) p.insertBefore(el.firstChild, el); el.remove(); select(null); }

  // ---------- messages from host ----------
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.wsed) return;
    switch (m.type) {
      case 'getHtml': post({ type: 'html', html: serialize(), reqId: m.reqId }); break;
      case 'command': applyCommand(m.name, m.value); break;
      case 'insertHtml': insertHtml(m.html); break;
      case 'insertImage': insertHtml(`<img src="${m.src.replace(/"/g, '&quot;')}" alt="${(m.alt || '').replace(/"/g, '&quot;')}" style="max-width:100%">`); break;
      case 'delete': deleteSelected(); break;
      case 'duplicate': duplicateSelected(); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'setFreeMove': state.freeMove = !!m.value; document.documentElement.classList.toggle('wsed-freemove', state.freeMove); break;
      case 'setStyle': if (state.selected) { pushUndo(); state.selected.style[m.prop] = m.value; if (!state.selected.getAttribute('style')) state.selected.removeAttribute('style'); positionOverlay(); post({ type: 'select', info: describe(state.selected) }); } break;
      case 'setInlineStyle': if (state.selected) { pushUndo(); if (m.value.trim()) state.selected.setAttribute('style', m.value); else state.selected.removeAttribute('style'); positionOverlay(); post({ type: 'select', info: describe(state.selected) }); } break;
      case 'setAttr': if (state.selected) { pushUndo(); if (m.name === 'class') { const keep = [...state.selected.classList].filter((c) => c.startsWith('wsed-')); state.selected.className = [m.value, ...keep].join(' ').trim(); } else if (m.value === '' || m.value == null) state.selected.removeAttribute(m.name); else state.selected.setAttribute(m.name, m.value); positionOverlay(); post({ type: 'select', info: describe(state.selected) }); } break;
      case 'setText': if (state.selected) { pushUndo(); state.selected.textContent = m.value; positionOverlay(); } break;
      case 'selectParent': if (state.selected && state.selected.parentElement && state.selected.parentElement !== document.body) select(state.selected.parentElement); break;
      case 'selectPath': select(elementAtPath(m.path)); if (state.selected) state.selected.scrollIntoView({ block: 'nearest' }); break;
      case 'startEdit': if (state.selected) startEditing(state.selected); break;
      case 'stopEdit': stopEditing(); break;
      case 'setScroll': window.scrollTo(m.x || 0, m.y || 0); break;
    }
  });

  window.addEventListener('scroll', () => { positionOverlay(); post({ type: 'scroll', x: scrollX, y: scrollY }); }, { passive: true });
  window.addEventListener('resize', positionOverlay);
  document.addEventListener('input', () => positionOverlay(), true);
  document.addEventListener('dragover', (ev) => ev.preventDefault());
  document.addEventListener('drop', (ev) => {
    ev.preventDefault();
    const files = [...(ev.dataTransfer && ev.dataTransfer.files || [])];
    if (!files.length) return;
    const el = targetFromEvent(ev);
    if (el) select(el);
    const file = files[0];
    const reader = new FileReader();
    reader.onload = () => post({ type: 'dropFile', name: file.name, mime: file.type, dataUrl: reader.result });
    reader.readAsDataURL(file);
  });

  // Content rendered from an include or macro lives in another file (or is
  // generated), so it is shown but not editable. It sits between
  // <!--wsj-inc:G:N src=FILE--> and <!--/wsj-inc:G:N--> markers (see injector.js).
  // data-wsed-ro holds FILE (empty for a macro defined in this page); clicking opens it.
  function markIncludes() {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_COMMENT);
    const starts = [];
    while (walker.nextNode()) if (/^wsj-inc:\d+:\d+( src=\S*)?$/.test(walker.currentNode.data)) starts.push(walker.currentNode);
    for (const start of starts) {
      const [, key, src] = /^wsj-inc:(\d+:\d+)(?: src=(\S*))?$/.exec(start.data);
      const file = src ? decodeURIComponent(src) : '';
      const tip = file ? 'Defined in ' + file + ' (click to open)' : 'Generated by a macro in this file: edit it in the source pane';
      const end = '/wsj-inc:' + key;
      for (let n = start.nextSibling; n && !(n.nodeType === 8 && n.data === end); n = n.nextSibling) {
        if (n.nodeType !== 1) continue;
        n.setAttribute('data-wsed-ro', file);
        if (!n.hasAttribute('title')) n.setAttribute('title', tip);
      }
    }
  }

  function init() {
    markIncludes();
    mount();
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true, attributeOldValue: true });
    post({ type: 'ready', title: document.title });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.__wsed = { serialize, select, state };
})();
