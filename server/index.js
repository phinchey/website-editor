#!/usr/bin/env node
'use strict';
/*
 * website-editor server
 *   node server/index.js [--root <dir>] [--port 3210] [--host 127.0.0.1] [--token <t>] [--open]
 *
 * Serves the browser UI, a file API scoped to the open workspace folder,
 * static files for the live preview, git clone, and a WebSocket terminal.
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');
const { resolveInside, toRel } = require('./paths');

let pty = null;
try { pty = require('node-pty'); } catch (e) { console.warn('[terminal] node-pty unavailable, falling back to pipes:', e.message); }

// ---------- CLI ----------
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
const PORT = parseInt(process.env.PORT || arg('port', '3210'), 10);
const HOST = process.env.HOST || arg('host', '127.0.0.1');
const REPOS_DIR = path.resolve(arg('repos-dir', path.join(os.homedir(), 'website-editor-repos')));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SAMPLE_DIR = path.join(__dirname, '..', 'samples', 'demo-site');
const isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(HOST);
let TOKEN = process.env.WSED_TOKEN || arg('token', null);
if (!TOKEN && !isLoopback && !arg('no-auth', false)) TOKEN = crypto.randomBytes(12).toString('hex');
if (TOKEN === true) TOKEN = crypto.randomBytes(12).toString('hex');

let workspaceRoot = path.resolve(arg('root', fs.existsSync(SAMPLE_DIR) ? SAMPLE_DIR : process.cwd()));

const IGNORED_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', '.next', '.cache', '__pycache__']);
const TEXT_EXT = new Set(['.html', '.htm', '.xhtml', '.css', '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.txt', '.svg', '.xml', '.yml', '.yaml', '.toml', '.ini', '.env', '.sh', '.bat', '.ps1', '.py', '.php', '.vue', '.jsx', '.tsx', '.scss', '.less', '.csv', '.gitignore', '.htaccess']);

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '60mb' }));

function auth(req, res, next) {
  if (!TOKEN) return next();
  const cookie = /(?:^|;\s*)wsed_token=([^;]+)/.exec(req.get('cookie') || '');
  const t = req.get('x-wsed-token') || req.query.token || (cookie && decodeURIComponent(cookie[1]));
  if (t === TOKEN) return next();
  res.status(401).json({ error: 'Unauthorized: missing or bad token' });
}
function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

app.get('/api/config', (req, res) => res.json({ needsToken: !!TOKEN, platform: process.platform }));

const api = express.Router();
api.use(auth, noCache);

// ----- workspace -----
api.get('/workspace', (req, res) => res.json({ root: workspaceRoot, reposDir: REPOS_DIR, home: os.homedir() }));

api.post('/workspace', async (req, res, next) => {
  try {
    const p = path.resolve(expandHome(String(req.body.path || '')));
    const st = await fsp.stat(p);
    if (!st.isDirectory()) throw httpError(400, 'Not a directory');
    workspaceRoot = p;
    res.json({ root: workspaceRoot });
  } catch (e) { next(e); }
});

// Server-side folder browser for the "Open folder" dialog.
api.get('/browse', async (req, res, next) => {
  try {
    let p = String(req.query.path || '');
    if (!p) {
      if (process.platform === 'win32') {
        const drives = [];
        for (let c = 65; c <= 90; c++) {
          const d = String.fromCharCode(c) + ':\\';
          if (fs.existsSync(d)) drives.push({ name: d, path: d });
        }
        return res.json({ path: '', parent: null, dirs: drives, roots: true });
      }
      p = os.homedir();
    }
    p = path.resolve(expandHome(p));
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(p, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const htmlCount = entries.filter((e) => e.isFile() && /\.html?$/i.test(e.name)).length;
    const parent = path.dirname(p) === p ? (process.platform === 'win32' ? '' : null) : path.dirname(p);
    res.json({ path: p, parent, dirs, htmlCount });
  } catch (e) { next(e); }
});

// ----- files -----
async function buildTree(dir, rel, depth) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.gitignore') continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) { out.push({ name: e.name, path: r, type: 'dir', ignored: true, children: [] }); continue; }
      const children = depth < 8 ? await buildTree(path.join(dir, e.name), r, depth + 1) : [];
      out.push({ name: e.name, path: r, type: 'dir', children });
    } else if (e.isFile()) {
      out.push({ name: e.name, path: r, type: 'file', ext: path.extname(e.name).toLowerCase() });
    }
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return out;
}

api.get('/tree', async (req, res, next) => {
  try { res.json({ root: workspaceRoot, tree: await buildTree(workspaceRoot, '', 0) }); } catch (e) { next(e); }
});

api.get('/file', async (req, res, next) => {
  try {
    const abs = resolveInside(workspaceRoot, req.query.path);
    const st = await fsp.stat(abs);
    if (st.size > 20 * 1024 * 1024) throw httpError(413, 'File too large');
    const ext = path.extname(abs).toLowerCase();
    const content = await fsp.readFile(abs, 'utf8');
    res.json({ path: toRel(workspaceRoot, abs), content, ext, text: TEXT_EXT.has(ext) || !content.includes('\u0000'), mtime: st.mtimeMs });
  } catch (e) { next(e); }
});

api.put('/file', async (req, res, next) => {
  try {
    const abs = resolveInside(workspaceRoot, req.body.path);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, String(req.body.content ?? ''), 'utf8');
    const st = await fsp.stat(abs);
    res.json({ ok: true, path: toRel(workspaceRoot, abs), mtime: st.mtimeMs });
  } catch (e) { next(e); }
});

api.post('/mkdir', async (req, res, next) => {
  try {
    const abs = resolveInside(workspaceRoot, req.body.path);
    await fsp.mkdir(abs, { recursive: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

api.delete('/file', async (req, res, next) => {
  try {
    const abs = resolveInside(workspaceRoot, req.query.path);
    if (abs === path.resolve(workspaceRoot)) throw httpError(400, 'Refusing to delete workspace root');
    await fsp.rm(abs, { recursive: true });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

api.post('/rename', async (req, res, next) => {
  try {
    const from = resolveInside(workspaceRoot, req.body.from);
    const to = resolveInside(workspaceRoot, req.body.to);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    res.json({ ok: true, path: toRel(workspaceRoot, to) });
  } catch (e) { next(e); }
});

// Upload a binary asset (base64) e.g. an image dropped into the page.
api.post('/upload', async (req, res, next) => {
  try {
    const { dir = '', name, dataBase64 } = req.body;
    if (!name || !dataBase64) throw httpError(400, 'name and dataBase64 required');
    const safeName = path.basename(name).replace(/[^\w.\-() ]+/g, '_');
    const dirAbs = resolveInside(workspaceRoot, dir);
    await fsp.mkdir(dirAbs, { recursive: true });
    let target = path.join(dirAbs, safeName);
    let n = 1;
    const ext = path.extname(safeName);
    const stem = safeName.slice(0, safeName.length - ext.length);
    while (fs.existsSync(target)) target = path.join(dirAbs, `${stem}-${n++}${ext}`);
    await fsp.writeFile(target, Buffer.from(dataBase64, 'base64'));
    res.json({ ok: true, path: toRel(workspaceRoot, target) });
  } catch (e) { next(e); }
});

// ----- git clone -----
api.post('/clone', async (req, res, next) => {
  try {
    let url = String(req.body.url || '').trim();
    if (!url) throw httpError(400, 'url required');
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = 'https://github.com/' + url + '.git';
    const name = String(req.body.name || '').trim() || path.basename(url).replace(/\.git$/i, '') || 'repo';
    if (!/^[\w.-]+$/.test(name)) throw httpError(400, 'bad folder name');
    await fsp.mkdir(REPOS_DIR, { recursive: true });
    const dest = path.join(REPOS_DIR, name);
    if (fs.existsSync(dest)) {
      workspaceRoot = dest;
      return res.json({ ok: true, root: dest, existed: true, output: 'Folder already exists; opened it instead.' });
    }
    const args = ['clone', '--progress'];
    if (req.body.branch) args.push('--branch', String(req.body.branch));
    args.push(url, dest);
    const output = await runCmd('git', args, { cwd: REPOS_DIR, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    workspaceRoot = dest;
    res.json({ ok: true, root: dest, output });
  } catch (e) { next(e); }
});

api.post('/git', async (req, res, next) => {
  // small helper for status badge; anything bigger belongs in the terminal
  try {
    const allowed = { status: ['status', '--porcelain=v1', '-b'], branch: ['rev-parse', '--abbrev-ref', 'HEAD'] };
    const args = allowed[req.body.cmd];
    if (!args) throw httpError(400, 'unknown git cmd');
    const output = await runCmd('git', args, { cwd: workspaceRoot });
    res.json({ ok: true, output });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.use('/api', api);

// ----- preview: serve workspace files (relative assets for the iframe) -----
const staticCache = new Map();
app.use('/preview', auth, noCache, (req, res, next) => {
  let handler = staticCache.get(workspaceRoot);
  if (!handler) {
    handler = express.static(workspaceRoot, { index: false, dotfiles: 'allow', etag: false, lastModified: false, fallthrough: true });
    staticCache.set(workspaceRoot, handler);
  }
  handler(req, res, next);
});

// editor runtime injected into the preview iframe
app.use('/__wsed', express.static(path.join(PUBLIC_DIR, 'inject'), { etag: false }));
app.use('/shared', express.static(path.join(PUBLIC_DIR, 'shared')));
app.use('/vendor/codemirror', express.static(path.join(__dirname, '..', 'node_modules', 'codemirror')));
app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm')));
app.use('/vendor/xterm-addon-fit', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit')));
app.use('/vendor/xterm-addon-web-links', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-web-links')));
app.use(express.static(PUBLIC_DIR));

app.use((err, req, res, _next) => {
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || String(err) });
});

// ---------- terminal over WebSocket ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws/terminal') return socket.destroy();
  if (TOKEN && url.searchParams.get('token') !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function defaultShell() {
  if (process.platform === 'win32') return { file: process.env.WSED_SHELL || 'powershell.exe', args: [] };
  const sh = process.env.WSED_SHELL || process.env.SHELL || '/bin/bash';
  return { file: sh, args: ['-l'] };
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const cols = parseInt(url.searchParams.get('cols') || '100', 10);
  const rows = parseInt(url.searchParams.get('rows') || '30', 10);
  const cwd = fs.existsSync(workspaceRoot) ? workspaceRoot : os.homedir();
  const { file, args } = defaultShell();
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', WSED: '1' };
  let proc;
  const send = (s) => { if (ws.readyState === ws.OPEN) ws.send(s); };

  if (pty) {
    try {
      proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd, env });
      proc.onData(send);
      proc.onExit(({ exitCode }) => { send(`\r\n[process exited with code ${exitCode}]\r\n`); ws.close(); });
    } catch (e) {
      send(`\r\n[failed to start ${file}: ${e.message}]\r\n`);
      proc = null;
    }
  }
  if (!proc) {
    // Fallback without a pseudo-terminal: still usable, but no colours/line editing.
    const child = spawn(file, process.platform === 'win32' ? [] : ['-i'], { cwd, env, shell: false });
    child.stdout.on('data', (d) => send(d.toString()));
    child.stderr.on('data', (d) => send(d.toString()));
    child.on('exit', (code) => { send(`\r\n[process exited with code ${code}]\r\n`); ws.close(); });
    proc = { write: (d) => child.stdin.write(d), resize() {}, kill: () => child.kill() };
    send('[node-pty not available: running in plain pipe mode]\r\n');
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input') proc.write(msg.data);
    else if (msg.type === 'resize' && proc.resize) { try { proc.resize(Math.max(2, msg.cols | 0), Math.max(1, msg.rows | 0)); } catch {} }
  });
  ws.on('close', () => { try { proc.kill(); } catch {} });
});

// ---------- helpers ----------
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function expandHome(p) { return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }
function runCmd(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      const out = (stdout || '') + (stderr || '');
      if (err) return reject(httpError(500, out.trim() || err.message));
      resolve(out);
    });
  });
}

// ---------- start ----------
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const host = HOST === '0.0.0.0' || HOST === '::' ? lanAddress() : HOST;
    const url = `http://${host}:${PORT}/` + (TOKEN ? `?token=${TOKEN}` : '');
    console.log(`website-editor running at ${url}`);
    console.log(`workspace: ${workspaceRoot}`);
    if (!isLoopback) console.log(TOKEN ? `access token: ${TOKEN}` : 'WARNING: no auth token; anyone on the network gets a shell on this machine');
    if (arg('open', false)) {
      const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
      try { spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
  });
}

function lanAddress() {
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return 'localhost';
}

module.exports = { app, server };
