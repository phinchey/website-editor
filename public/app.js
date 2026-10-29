/* Website Editor host application */
(function () {
  'use strict';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
  const app = $('#app');
  const frame = $('#frame');
  const statusEl = $('#status');

  // ---------- auth token (only needed when the server was started with one) ----------
  const urlToken = new URLSearchParams(location.search).get('token');
  if (urlToken) { localStorage.setItem('wsed_token', urlToken); history.replaceState(null, '', location.pathname); }
  const TOKEN = localStorage.getItem('wsed_token') || '';
  if (TOKEN) document.cookie = 'wsed_token=' + encodeURIComponent(TOKEN) + '; path=/; SameSite=Lax';

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, TOKEN ? { 'x-wsed-token': TOKEN } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error((data && data.error) || res.statusText);
    return data;
  }

  function setStatus(msg, kind) {
    $('#status-text').textContent = msg || '';
    statusEl.className = kind || '';
    if (kind === 'ok') setTimeout(() => { if ($('#status-text').textContent === msg) statusEl.className = ''; }, 3000);
  }
  function fail(e) { console.error(e); setStatus(e.message || String(e), 'err'); }

  // ---------- state ----------
  const state = {
    workspace: null,
    file: null,          // { path, ext, isHtml }
    saved: '',           // content on disk
    frameReady: false,
    selected: null,      // info from iframe
    scroll: { x: 0, y: 0 },
    applyingFromFrame: false,
    freeMove: false,
  };

  // ---------- layout: toggles + gutters ----------
  const prefs = JSON.parse(localStorage.getItem('wsed_prefs') || '{}');
  function savePrefs() { localStorage.setItem('wsed_prefs', JSON.stringify(prefs)); }
  function applyPrefs() {
    const root = document.documentElement.style;
    if (prefs.filesW) root.setProperty('--files-w', prefs.filesW + 'px');
    if (prefs.sourceW) root.setProperty('--source-w', prefs.sourceW + 'px');
    if (prefs.terminalH) root.setProperty('--terminal-h', prefs.terminalH + 'px');
    for (const k of ['files', 'source', 'terminal']) {
      if (prefs['show_' + k] === false) app.classList.remove('show-' + k);
    }
    if (window.innerWidth < 800 && prefs.show_files === undefined) app.classList.remove('show-files');
    syncToggleButtons();
  }
  function syncToggleButtons() {
    $('#btn-toggle-files').classList.toggle('on', app.classList.contains('show-files'));
    $('#btn-toggle-source').classList.toggle('on', app.classList.contains('show-source'));
    $('#btn-toggle-terminal').classList.toggle('on', app.classList.contains('show-terminal'));
  }
  function toggle(k) {
    app.classList.toggle('show-' + k);
    prefs['show_' + k] = app.classList.contains('show-' + k);
    savePrefs(); syncToggleButtons();
    if (k === 'terminal' && app.classList.contains('show-terminal')) setTimeout(fitTerminal, 50);
    if (k === 'source' && cm) setTimeout(() => cm.refresh(), 50);
  }
  $('#btn-toggle-files').onclick = () => toggle('files');
  $('#btn-toggle-source').onclick = () => toggle('source');
  $('#btn-toggle-terminal').onclick = () => toggle('terminal');
  $('#btn-source-close').onclick = () => toggle('source');
  $('#btn-terminal-close').onclick = () => toggle('terminal');

  function gutter(el, axis, cssVar, measure, prefKey, invert) {
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      el.setPointerCapture(ev.pointerId);
      el.classList.add('active'); document.body.classList.add('resizing');
      const start = axis === 'x' ? ev.clientX : ev.clientY;
      const size0 = measure();
      const move = (e) => {
        const d = (axis === 'x' ? e.clientX : e.clientY) - start;
        const v = Math.max(80, size0 + (invert ? -d : d));
        document.documentElement.style.setProperty(cssVar, v + 'px');
        prefs[prefKey] = v;
      };
      const up = () => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
        el.classList.remove('active'); document.body.classList.remove('resizing');
        savePrefs(); fitTerminal(); if (cm) cm.refresh();
      };
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
    });
  }
  gutter($('#gutter-files'), 'x', '--files-w', () => $('#files').offsetWidth, 'filesW');
  gutter($('#gutter-source'), 'x', '--source-w', () => $('#source').offsetWidth, 'sourceW', true);
  gutter($('#gutter-terminal'), 'y', '--terminal-h', () => $('#terminal').offsetHeight, 'terminalH', true);

  // ---------- source editor ----------
  const cm = CodeMirror($('#source-editor'), {
    value: '',
    mode: 'htmlmixed',
    theme: 'material-darker',
    lineNumbers: true,
    lineWrapping: true,
    matchTags: { bothTags: true },
    autoCloseTags: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    indentUnit: 2,
    tabSize: 2,
    extraKeys: {
      'Ctrl-S': () => save(), 'Cmd-S': () => save(),
      'Ctrl-/': 'toggleComment',
      Tab: (c) => c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  '),
    },
  });
  let sourceTimer = null;
  cm.on('change', (_c, change) => {
    if (change.origin === 'setValue') return;
    updateDirty();
    if (state.applyingFromFrame) return;
    clearTimeout(sourceTimer);
    sourceTimer = setTimeout(() => loadFrameFromSource(), 600);
  });
  $('#btn-format').onclick = () => {
    const cur = cm.getCursor();
    cm.operation(() => { for (let i = 0; i < cm.lineCount(); i++) cm.indentLine(i); });
    cm.setCursor(cur);
  };

  function modeFor(ext) {
    return ({ '.html': 'htmlmixed', '.htm': 'htmlmixed', '.xhtml': 'htmlmixed', '.css': 'css', '.scss': 'css', '.less': 'css', '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.ts': { name: 'javascript', typescript: true }, '.json': { name: 'javascript', json: true }, '.md': 'markdown', '.svg': 'xml', '.xml': 'xml' })[ext] || null;
  }

  // ---------- dirty / save ----------
  function updateDirty() {
    const dirty = !!state.file && cm.getValue() !== state.saved;
    app.classList.toggle('dirty', dirty);
    document.title = (dirty ? '● ' : '') + (state.file ? state.file.path + ' — ' : '') + 'Website Editor';
  }
  async function save() {
    if (!state.file) return;
    // If the user is mid-edit inside the page, flush its latest HTML first.
    if (state.file.isHtml && state.frameReady) {
      const html = await requestFrameHtml();
      if (html != null && html !== cm.getValue()) setSourceFromFrame(html);
    }
    const content = cm.getValue();
    try {
      await api('PUT', '/api/file', { path: state.file.path, content });
      state.saved = content;
      updateDirty();
      setStatus('Saved ' + state.file.path, 'ok');
    } catch (e) { fail(e); }
  }
  $('#btn-save').onclick = save;
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', (ev) => { if (app.classList.contains('dirty')) { ev.preventDefault(); ev.returnValue = ''; } });

  // ---------- workspace / file tree ----------
  async function loadWorkspace() {
    try {
      const ws = await api('GET', '/api/workspace');
      state.workspace = ws;
      const name = ws.root.split(/[\\/]/).filter(Boolean).pop();
      $('#workspace-name').textContent = name || ws.root;
      $('#workspace-name').title = ws.root;
      $('#clone-dest').textContent = ws.reposDir;
      await refreshTree();
    } catch (e) { fail(e); }
  }
  async function refreshTree() {
    try {
      const { tree } = await api('GET', '/api/tree');
      renderTree(tree);
    } catch (e) { fail(e); }
  }
  const openDirs = new Set(JSON.parse(localStorage.getItem('wsed_opendirs') || '[]'));
  function renderTree(tree) {
    const el = $('#tree');
    el.innerHTML = '';
    const build = (nodes, parent, depth) => {
      for (const n of nodes) {
        const row = document.createElement('div');
        row.className = 'node ' + n.type + (n.ignored ? ' ignored' : '') + (/\.html?$/i.test(n.name) ? ' html' : '');
        row.dataset.path = n.path;
        if (n.type === 'dir') {
          const open = openDirs.has(n.path) || depth === 0 && nodes.length < 12 && !n.ignored;
          row.innerHTML = `<span class="arrow">${open ? '▾' : '▸'}</span><span>📁</span><span class="name"></span>`;
          row.querySelector('.name').textContent = n.name;
          const kids = document.createElement('div');
          kids.className = 'children';
          kids.hidden = !open;
          row.onclick = () => { kids.hidden = !kids.hidden; row.querySelector('.arrow').textContent = kids.hidden ? '▸' : '▾'; kids.hidden ? openDirs.delete(n.path) : openDirs.add(n.path); localStorage.setItem('wsed_opendirs', JSON.stringify([...openDirs])); };
          row.oncontextmenu = (ev) => { ev.preventDefault(); fileMenu(n, ev); };
          parent.appendChild(row); parent.appendChild(kids);
          if (!n.ignored) build(n.children, kids, depth + 1);
        } else {
          row.innerHTML = `<span class="arrow"></span><span>${iconFor(n.ext)}</span><span class="name"></span>`;
          row.querySelector('.name').textContent = n.name;
          row.onclick = () => openFile(n.path);
          row.oncontextmenu = (ev) => { ev.preventDefault(); fileMenu(n, ev); };
          parent.appendChild(row);
        }
      }
    };
    build(tree, el, 0);
    markActiveFile();
    if (!tree.length) el.innerHTML = '<div class="muted small" style="padding:8px">Empty folder</div>';
  }
  function iconFor(ext) {
    return ({ '.html': '🌐', '.htm': '🌐', '.css': '🎨', '.js': '⚙️', '.mjs': '⚙️', '.ts': '⚙️', '.json': '{}', '.md': '📝', '.png': '🖼', '.jpg': '🖼', '.jpeg': '🖼', '.gif': '🖼', '.svg': '🖼', '.webp': '🖼', '.ico': '🖼' })[ext] || '📄';
  }
  function markActiveFile() {
    $$('#tree .node').forEach((n) => n.classList.toggle('active', !!state.file && n.dataset.path === state.file.path));
  }
  async function fileMenu(n, ev) {
    const choice = prompt(`${n.path}\n\nType: rename, delete  (or cancel)`);
    if (!choice) return;
    try {
      if (choice.trim() === 'delete') {
        if (!confirm('Delete ' + n.path + '?')) return;
        await api('DELETE', '/api/file?path=' + encodeURIComponent(n.path));
        if (state.file && state.file.path === n.path) closeFile();
      } else if (choice.trim() === 'rename') {
        const to = prompt('New path', n.path);
        if (!to || to === n.path) return;
        await api('POST', '/api/rename', { from: n.path, to });
        if (state.file && state.file.path === n.path) { state.file.path = to; $('#file-name').textContent = to; }
      }
      await refreshTree();
    } catch (e) { fail(e); }
  }
  $('#btn-refresh-files').onclick = refreshTree;
  $('#btn-new-file').onclick = async () => {
    const p = await promptDialog('New file path (e.g. about.html)');
    if (!p) return;
    const isHtml = /\.html?$/i.test(p);
    const content = isHtml ? `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${p.replace(/\.html?$/i, '')}</title>\n</head>\n<body>\n  <h1>New page</h1>\n  <p>Start editing.</p>\n</body>\n</html>\n` : '';
    try { await api('PUT', '/api/file', { path: p, content }); await refreshTree(); openFile(p); } catch (e) { fail(e); }
  };

  // ---------- open / close file ----------
  async function openFile(p) {
    if (state.file && app.classList.contains('dirty') && !confirm('Discard unsaved changes to ' + state.file.path + '?')) return;
    try {
      const f = await api('GET', '/api/file?path=' + encodeURIComponent(p));
      if (!f.text) { setStatus('Binary file: ' + p, 'err'); return; }
      state.file = { path: f.path, ext: f.ext, isHtml: /\.x?html?$/i.test(f.ext) };
      state.saved = f.content;
      state.scroll = { x: 0, y: 0 };
      cm.setOption('mode', modeFor(f.ext) || 'text/plain');
      cm.setValue(f.content);
      cm.clearHistory();
      $('#file-name').textContent = f.path;
      $('#source-title').textContent = f.ext.replace('.', '').toUpperCase() || 'SOURCE';
      app.classList.add('has-file');
      markActiveFile();
      updateDirty();
      setSelection(null);
      if (state.file.isHtml) {
        loadFrameFromSource();
      } else {
        frame.srcdoc = `<!doctype html><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font:14px system-ui;color:#555;background:#f5f6f8"><div style="text-align:center"><div style="font-size:32px">${iconFor(f.ext)}</div><div>${escapeHtml(f.path)}</div><div style="color:#999;margin-top:6px">Not an HTML page: edit it in the source pane.</div></div></body>`;
        state.frameReady = false;
        if (!app.classList.contains('show-source')) toggle('source');
      }
      setStatus('Opened ' + f.path);
      if (state.workspace) localStorage.setItem('wsed_lastfile_' + state.workspace.root, f.path);
      if (window.innerWidth < 800 && app.classList.contains('show-files')) toggle('files');
    } catch (e) { fail(e); }
  }
  function closeFile() {
    state.file = null; state.saved = ''; cm.setValue(''); frame.srcdoc = '';
    app.classList.remove('has-file'); $('#file-name').textContent = 'No file open'; updateDirty(); markActiveFile();
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- visual frame ----------
  function fileDir() { return state.file ? state.file.path.split('/').slice(0, -1).join('/') : ''; }
  function previewBase() { const d = fileDir(); return '/preview/' + (d ? d.split('/').map(encodeURIComponent).join('/') + '/' : ''); }

  function loadFrameFromSource() {
    if (!state.file || !state.file.isHtml) return;
    state.frameReady = false;
    const html = WsedInjector.prepareForEditing(cm.getValue(), { baseHref: location.origin + previewBase(), cssHref: '/__wsed/inject.css', jsHref: '/__wsed/inject.js' });
    frame.srcdoc = html;
  }
  function postFrame(msg) { if (frame.contentWindow) frame.contentWindow.postMessage(Object.assign({ wsed: true }, msg), '*'); }
  const pending = new Map();
  let reqSeq = 0;
  function requestFrameHtml() {
    if (!state.frameReady) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = ++reqSeq;
      pending.set(id, resolve);
      postFrame({ type: 'getHtml', reqId: id });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); resolve(null); } }, 1500);
    });
  }
  function setSourceFromFrame(html) {
    state.applyingFromFrame = true;
    const scroll = cm.getScrollInfo();
    const cur = cm.getCursor();
    cm.setValue(html);
    cm.setCursor(cur);
    cm.scrollTo(scroll.left, scroll.top);
    state.applyingFromFrame = false;
    updateDirty();
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (!m || !m.wsed || ev.source !== frame.contentWindow) return;
    switch (m.type) {
      case 'ready':
        state.frameReady = true;
        postFrame({ type: 'setFreeMove', value: state.freeMove });
        postFrame({ type: 'setScroll', x: state.scroll.x, y: state.scroll.y });
        break;
      case 'change':
        // Visual edit → regenerate the source pane (the file is only written on Save)
        if (m.html !== cm.getValue()) setSourceFromFrame(m.html);
        break;
      case 'html':
        if (pending.has(m.reqId)) { pending.get(m.reqId)(m.html); pending.delete(m.reqId); }
        break;
      case 'select': setSelection(m.info); break;
      case 'scroll': state.scroll = { x: m.x, y: m.y }; break;
      case 'save': save(); break;
      case 'dropFile': uploadAndInsert(m.name, m.dataUrl.split(',')[1], m.mime); break;
    }
  });

  // ---------- toolbar ----------
  $$('#visual-toolbar button[data-cmd]').forEach((b) => {
    b.onclick = () => postFrame(b.dataset.cmd === 'undo' || b.dataset.cmd === 'redo' ? { type: b.dataset.cmd } : { type: 'command', name: b.dataset.cmd });
  });
  $('#sel-block').onchange = (ev) => { if (ev.target.value) postFrame({ type: 'command', name: 'formatBlock', value: ev.target.value }); ev.target.value = ''; };
  $('#btn-link').onclick = async () => {
    const url = await promptDialog('Link URL', (state.selected && state.selected.href) || 'https://');
    if (url === null) return;
    postFrame({ type: 'command', name: url ? 'createLink' : 'unlink', value: url });
  };
  $('#btn-delete').onclick = () => postFrame({ type: 'delete' });
  $('#btn-duplicate').onclick = () => postFrame({ type: 'duplicate' });
  $('#chk-freemove').onchange = (ev) => { state.freeMove = ev.target.checked; postFrame({ type: 'setFreeMove', value: state.freeMove }); };
  $('#sel-insert').onchange = (ev) => {
    const v = ev.target.value; ev.target.value = '';
    const snippets = {
      h2: '<h2>New heading</h2>', p: '<p>New paragraph text.</p>', button: '<button type="button">Button</button>',
      a: '<a href="#">New link</a>', box: '<div style="padding:16px;border:1px solid #ccc;border-radius:8px;min-height:60px">New box</div>',
      section: '<section style="padding:24px"><h2>Section title</h2><p>Section text.</p></section>',
      ul: '<ul><li>First item</li><li>Second item</li></ul>', hr: '<hr>',
      table: '<table border="1" cellpadding="6" style="border-collapse:collapse"><tr><th>Header</th><th>Header</th></tr><tr><td>Cell</td><td>Cell</td></tr></table>',
    };
    if (snippets[v]) postFrame({ type: 'insertHtml', html: snippets[v] });
  };
  $('#btn-insert-image').onclick = () => $('#file-input').click();
  $('#file-input').onchange = async (ev) => {
    const file = ev.target.files[0]; ev.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => uploadAndInsert(file.name, reader.result.split(',')[1], file.type);
    reader.readAsDataURL(file);
  };
  async function uploadAndInsert(name, base64, mime) {
    if (!state.file) return;
    try {
      const dir = (fileDir() ? fileDir() + '/' : '') + 'images';
      const r = await api('POST', '/api/upload', { dir, name, dataBase64: base64 });
      const src = 'images/' + r.path.split('/').pop();
      if (/^image\//.test(mime || '') || /\.(png|jpe?g|gif|svg|webp|avif|bmp|ico)$/i.test(name)) postFrame({ type: 'insertImage', src, alt: name.replace(/\.[^.]+$/, '') });
      else postFrame({ type: 'insertHtml', html: `<a href="${src}">${escapeHtml(name)}</a>` });
      setStatus('Uploaded ' + r.path, 'ok');
      refreshTree();
    } catch (e) { fail(e); }
  }
  // ---------- device width (desktop / tablet / phone preview) ----------
  const frameWrap = $('#frame-wrap');
  function applyDevice() {
    const w = +(prefs.deviceWidth || 0);
    const info = $('#device-info');
    if (!w) {
      frameWrap.classList.remove('device');
      frame.style.cssText = '';
      info.textContent = '';
      return;
    }
    frameWrap.classList.add('device');
    const pw = frameWrap.clientWidth, ph = frameWrap.clientHeight;
    const scale = Math.min(1, (pw - 16) / w);
    const h = Math.round(ph / scale);
    frame.style.width = w + 'px';
    frame.style.height = h + 'px';
    frame.style.transformOrigin = 'top left';
    frame.style.transform = `translateX(${Math.round((pw - w * scale) / 2)}px) scale(${scale})`;
    frame.style.left = '0';
    info.textContent = w + 'px' + (scale < 1 ? ' @ ' + Math.round(scale * 100) + '%' : '');
  }
  $('#sel-device').onchange = (ev) => { prefs.deviceWidth = +ev.target.value; savePrefs(); applyDevice(); };
  new ResizeObserver(() => applyDevice()).observe(frameWrap);
  $('#sel-device').value = String(prefs.deviceWidth || 0);
  applyDevice();

  $('#btn-preview').onclick = () => { if (state.file) window.open('/preview/' + state.file.path.split('/').map(encodeURIComponent).join('/'), '_blank'); };
  $('#btn-props').onclick = () => { const p = $('#props'); p.hidden = !p.hidden; $('#btn-props').classList.toggle('on', !p.hidden); };
  $('#btn-props-close').onclick = () => { $('#props').hidden = true; $('#btn-props').classList.remove('on'); };

  // ---------- selection → props panel + breadcrumb ----------
  function setSelection(info) {
    state.selected = info;
    const bc = $('#breadcrumb');
    bc.innerHTML = '';
    if (info) {
      const parts = info.path.split('/');
      parts.forEach((part, i) => {
        const s = document.createElement('span');
        s.textContent = part.split(':')[0];
        if (i === parts.length - 1) s.className = 'cur';
        s.onclick = () => postFrame({ type: 'selectPath', path: parts.slice(0, i + 1).join('/') });
        bc.appendChild(s);
        if (i < parts.length - 1) bc.appendChild(document.createTextNode(' › '));
      });
    }
    renderProps(info);
    $('#btn-delete').disabled = $('#btn-duplicate').disabled = !info;
  }
  function renderProps(info) {
    const body = $('#props-body');
    if (!info) { body.innerHTML = '<div class="muted small">Nothing selected. Click an element in the page.</div>'; return; }
    const f = (label, name, value, type) => `<label>${label}<input type="${type || 'text'}" data-attr="${name}" value="${escapeHtml(value || '')}" spellcheck="false"></label>`;
    const st = (label, prop, value, type) => `<label>${label}<input type="${type || 'text'}" data-style="${prop}" value="${escapeHtml(value || '')}" spellcheck="false"></label>`;
    body.innerHTML = `
      <div><b>&lt;${info.tag}&gt;</b> <span class="muted">${info.editing ? 'editing text' : (info.canEditText ? 'double-click to edit text' : '')}</span></div>
      <div class="row" style="display:flex;gap:4px;margin:6px 0"><button class="tb small" id="p-parent">↑ Parent</button><button class="tb small" id="p-edit">✎ Edit text</button></div>
      ${f('id', 'id', info.id)}
      ${f('class', 'class', info.className)}
      ${info.tag === 'a' ? f('href', 'href', info.href) : ''}
      ${info.tag === 'img' ? f('src', 'src', info.src) + f('alt', 'alt', info.alt) : ''}
      <h4>Style</h4>
      <div class="two">${st('width', 'width', info.style.width)}${st('height', 'height', info.style.height)}</div>
      <div class="two"><label>text colour<input type="color" data-style="color" value="${toHex(info.style.color)}"></label><label>background<input type="color" data-style="backgroundColor" value="${toHex(info.style.backgroundColor)}"></label></div>
      <div class="two">${st('font size', 'fontSize', info.style.fontSize)}${st('text align', 'textAlign', info.style.textAlign)}</div>
      <div class="two">${st('padding', 'padding', info.style.padding)}${st('margin', 'margin', info.style.margin)}</div>
      ${st('border radius', 'borderRadius', info.style.borderRadius)}
      <label>inline style<textarea data-inline spellcheck="false">${escapeHtml(info.inlineStyle)}</textarea></label>
      <div class="muted small">Position: ${info.style.position}</div>`;
    $('#p-parent').onclick = () => postFrame({ type: 'selectParent' });
    $('#p-edit').onclick = () => postFrame({ type: info.editing ? 'stopEdit' : 'startEdit' });
    $$('[data-attr]', body).forEach((inp) => { inp.onchange = () => postFrame({ type: 'setAttr', name: inp.dataset.attr, value: inp.value }); });
    $$('[data-style]', body).forEach((inp) => { inp.onchange = () => postFrame({ type: 'setStyle', prop: inp.dataset.style, value: inp.value }); });
    $('[data-inline]', body).onchange = (ev) => postFrame({ type: 'setInlineStyle', value: ev.target.value });
  }
  function toHex(rgb) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
    if (!m) return '#000000';
    return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('');
  }

  // ---------- terminal ----------
  let term = null, fit = null, ws = null;
  function fitTerminal() {
    if (!term || !fit || !app.classList.contains('show-terminal')) return;
    try { fit.fit(); } catch {}
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
  function startTerminal() {
    if (!term) {
      term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Consolas, Menlo, monospace', scrollback: 5000, theme: { background: '#121317' }, allowProposedApi: true });
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      try { term.loadAddon(new WebLinksAddon.WebLinksAddon()); } catch {}
      term.open($('#term'));
      term.onData((d) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d })); });
      new ResizeObserver(() => fitTerminal()).observe($('#term'));
    }
    try { fit.fit(); } catch {}
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws/terminal?cols=${term.cols}&rows=${term.rows}` + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''));
    ws.onmessage = (ev) => term.write(ev.data);
    ws.onopen = () => { term.focus(); fitTerminal(); };
    ws.onclose = () => term.write('\r\n\x1b[90m[disconnected — press ↻ to restart]\x1b[0m\r\n');
    ws.onerror = () => {};
  }
  $('#btn-term-restart').onclick = () => { if (ws) { ws.onclose = null; ws.close(); } term.clear(); startTerminal(); };
  $('#btn-claude').onclick = () => {
    if (!app.classList.contains('show-terminal')) toggle('terminal');
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'input', data: 'claude\r' })); term.focus(); }
  };

  // ---------- dialogs ----------
  function promptDialog(title, value) {
    const dlg = $('#dlg-prompt');
    $('#prompt-title').textContent = title;
    $('#prompt-input').value = value || '';
    dlg.showModal();
    $('#prompt-input').focus(); $('#prompt-input').select();
    return new Promise((resolve) => { dlg.onclose = () => resolve(dlg.returnValue === 'ok' ? $('#prompt-input').value : null); });
  }

  // open folder
  let browsePath = '';
  async function browse(p) {
    try {
      const r = await api('GET', '/api/browse?path=' + encodeURIComponent(p || ''));
      browsePath = r.path;
      $('#open-path').value = r.path;
      const list = $('#open-list');
      list.innerHTML = '';
      if (r.parent !== null && r.parent !== undefined) { const up = document.createElement('div'); up.textContent = '⬆ ..'; up.onclick = () => browse(r.parent); list.appendChild(up); }
      for (const d of r.dirs) { const row = document.createElement('div'); row.textContent = '📁 ' + d.name; row.onclick = () => browse(d.path); list.appendChild(row); }
      if (r.htmlCount) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = `${r.htmlCount} HTML file(s) here`; list.appendChild(h); }
      if (!r.dirs.length && !r.htmlCount) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = 'No sub-folders'; list.appendChild(h); }
    } catch (e) { fail(e); }
  }
  $('#btn-open').onclick = () => { $('#dlg-open').showModal(); browse(state.workspace ? state.workspace.root : ''); };
  $('#open-go').onclick = () => browse($('#open-path').value);
  $('#open-path').onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); browse($('#open-path').value); } };
  $('#open-confirm').onclick = async () => {
    try {
      await api('POST', '/api/workspace', { path: $('#open-path').value || browsePath });
      $('#dlg-open').close();
      closeFile();
      await loadWorkspace();
      setStatus('Opened folder ' + state.workspace.root, 'ok');
      if (ws) $('#btn-term-restart').click();
    } catch (e) { fail(e); }
  };

  // clone
  $('#btn-clone').onclick = () => { $('#clone-output').hidden = true; $('#dlg-clone').showModal(); $('#clone-url').focus(); };
  $('#clone-confirm').onclick = async () => {
    const btn = $('#clone-confirm'); btn.disabled = true; btn.textContent = 'Cloning…';
    const out = $('#clone-output'); out.hidden = false; out.textContent = 'git clone …';
    try {
      const r = await api('POST', '/api/clone', { url: $('#clone-url').value, name: $('#clone-name').value, branch: $('#clone-branch').value });
      out.textContent = r.output || 'done';
      $('#dlg-clone').close();
      closeFile();
      await loadWorkspace();
      setStatus('Cloned into ' + r.root, 'ok');
      if (ws) $('#btn-term-restart').click();
    } catch (e) { out.textContent = e.message; }
    btn.disabled = false; btn.textContent = 'Clone';
  };

  // ---------- boot ----------
  applyPrefs();
  loadWorkspace().then(() => {
    const last = localStorage.getItem('wsed_lastfile_' + (state.workspace && state.workspace.root));
    if (last) openFile(last);
  });
  startTerminal();
  window.addEventListener('resize', fitTerminal);
})();
