# website-editor

A browser-based, PowerPoint-style editor for plain HTML websites, with the HTML
source beside the page and a real terminal underneath so you can run
[Claude Code](https://claude.ai/code) (or anything else) without leaving the tab.

```
┌──────────────────────────────┬───────────────────────────┐
│  Visual editor (click, type, │  HTML source (CodeMirror) │
│  drag, resize, insert image) │  – live two-way sync      │
├──────────────────────────────┴───────────────────────────┤
│  Terminal (xterm.js → real shell on the server machine)  │
└──────────────────────────────────────────────────────────┘
```

Because the UI is a web page served by a small Node server, it runs the same on
**Windows, Linux and macOS**, and you can use it from **Android** (or any
tablet/phone) by pointing the browser at the machine that runs the server.

## Quick start

Requirements: [Node.js](https://nodejs.org) 18 or newer and `git`.

```bash
git clone https://github.com/phinchey/website-editor.git
cd website-editor
npm install
npm start            # → http://127.0.0.1:3210/
```

Options:

| Flag | Meaning |
| --- | --- |
| `--root <dir>` | Folder to open at startup (default: the bundled `samples/demo-site`) |
| `--port <n>` | Port (default 3210) |
| `--host 0.0.0.0` | Listen on all interfaces so a phone/tablet on the LAN can connect |
| `--token <secret>` | Require this token (a random one is generated automatically when `--host` is not loopback) |
| `--repos-dir <dir>` | Where "Clone repo" puts repositories (default `~/website-editor-repos`) |
| `--open` | Open the browser automatically |

Example: `node server/index.js --root ~/sites/my-site --host 0.0.0.0 --open`

### Windows

Install Node.js (LTS) from nodejs.org, open PowerShell in the project folder and
run the same `npm install` / `npm start`. The terminal pane opens PowerShell
(set `WSED_SHELL=cmd.exe` or `WSED_SHELL=pwsh.exe` to change it). `node-pty`
ships prebuilt binaries for Windows, so no build tools are needed.

### Android

Either run the server on a PC on the same Wi-Fi with `--host 0.0.0.0` and open
the printed URL (it includes the access token) in Chrome on the phone, or run
it on the phone itself inside [Termux](https://termux.dev):

```bash
pkg install nodejs git
git clone https://github.com/phinchey/website-editor.git && cd website-editor
npm install && npm start
```

then open `http://127.0.0.1:3210/` in Chrome. The layout collapses to a
single column below 800 px wide; the Files and HTML panes can be toggled from
the top bar.

## Using the editor

1. **Open folder** browses the server machine's disk and makes a folder the
   workspace. **Clone repo** clones a GitHub URL (or `owner/name`) into the
   repos directory and opens it. Private repos: clone from the terminal with
   your own credentials, then use Open folder.
2. Pick an `.html` file in the file tree. Other text files (CSS, JS, Markdown…)
   open in the source pane only.
3. In the visual pane:
   * **Click** an element to select it (blue outline, handles, breadcrumb at
     the bottom). Click a selected element again, double-click, or press
     **Enter** to edit its text; **Esc** finishes.
   * **Drag** a selected element to move it. By default this *reorders* it in
     the document (a green line shows where it will land). Tick **Free move**
     to position it absolutely instead, like a slide object; arrow keys nudge
     it (Shift = 10 px).
   * Drag the **handles** to resize (sets inline `width`/`height`).
   * Toolbar: undo/redo, block type, bold/italic/underline, alignment, link,
     insert image (uploaded to `images/` next to the page), insert elements,
     duplicate (**Ctrl+D**), delete (**Del**).
   * The **device** dropdown switches the preview width between desktop,
     laptop, tablet and phone sizes (scaled down to fit when the pane is
     narrower); "Fit pane" fills the pane.
   * **⚙** opens the properties panel: id, class, href/src/alt, common styles
     and the raw inline style. **↑ Parent** walks up the tree.
   * Drop an image file from your desktop onto the page to upload and insert it.
4. The **HTML pane** shows the current source. Visual edits regenerate it;
   typing in it reloads the visual pane after a short pause.
5. **Save** (**Ctrl+S**) writes the source pane to the original file. Nothing is
   written to disk until you save. **Preview** opens the saved page in a new tab
   with its scripts enabled.

### Terminal

The bottom pane is a real shell (via `node-pty`) started in the workspace
folder. Click **✦ Claude Code** to type `claude` into it, or run `git`,
`npm`, or anything else. Use **↻** to restart the shell (it also restarts in the
new folder after Open folder / Clone). Drag the gutters between panes to
resize; the sizes are remembered.

## How it works

* `server/index.js` – Express app: file API scoped to the workspace,
  `/preview/*` static serving of the workspace (so the page's relative CSS and
  images resolve), git clone, and a WebSocket PTY at `/ws/terminal`.
* `public/shared/injector.js` – takes the HTML text, disables `<script>` tags
  (so page JavaScript doesn't mutate the DOM while you edit) and injects a
  `<base>` plus the editor runtime. The result is loaded into the iframe via
  `srcdoc`.
* `public/inject/inject.js` – the in-page runtime: selection overlay,
  drag/reorder/free-move, resize, contenteditable text editing, undo stack,
  and serialisation back to HTML (it strips everything it added and
  re-enables the scripts).
* `public/app.js` – the host UI: file tree, CodeMirror source pane, toolbar,
  properties panel, xterm.js terminal, two-way sync and saving.

### Notes and limitations

* Saving round-trips the page through the browser's DOM, so the output is the
  browser's serialisation: tags are normalised, attribute quoting is
  standardised and some whitespace may change. Content is preserved; exact
  original formatting is not. (Use the source pane for byte-exact edits.)
* Template-driven sites (React, Jekyll, PHP, etc.) can be previewed but the
  editor only writes plain HTML files.
* The server gives whoever can reach it a shell on your machine. It binds to
  `127.0.0.1` by default; when you expose it on a network keep the token on
  and prefer a trusted LAN or a VPN.

## Development

```bash
npm test     # unit tests for the injector and path guard
npm start    # run the server
```
