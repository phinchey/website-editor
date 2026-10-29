/*
 * Shared HTML injector. Runs in Node (server) and in the browser (app).
 *
 * prepareForEditing(html, opts)  -> HTML with page scripts disabled and the
 *                                    editor runtime (css + js) and a <base> injected.
 * The in-iframe editor reverses this on serialisation (see public/inject/inject.js):
 *   - elements carrying data-wsed are removed
 *   - <script type="text/x-wsed-disabled" data-wsed-type="..."> is restored
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WsedInjector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DISABLED_TYPE = 'text/x-wsed-disabled';

  // Neutralise <script> tags so page JS does not run (and mutate the DOM)
  // while editing. The original type is parked in data-wsed-type.
  function disableScripts(html) {
    return html.replace(/<script\b([^>]*)>/gi, function (m, attrs) {
      if (/\btype\s*=\s*(["']?)text\/x-wsed-disabled\1/i.test(attrs)) return m;
      let out = attrs.replace(/\stype\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, function (_m, val) {
        return ' data-wsed-type=' + val;
      });
      return m.slice(0, 7) + out + ' type="' + DISABLED_TYPE + '">';
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /**
   * @param {string} html   raw page HTML
   * @param {object} opts   { baseHref, cssHref, jsHref, fragment }
   *                         fragment: the file has no <html>/<body> (a partial); saved without the wrapper
   */
  function prepareForEditing(html, opts) {
    opts = opts || {};
    let out = disableScripts(html);
    const headInject =
      (opts.baseHref ? '<base href="' + escapeAttr(opts.baseHref) + '" data-wsed="base">' : '') +
      '<link rel="stylesheet" href="' + escapeAttr(opts.cssHref || '/__wsed/inject.css') + '" data-wsed="css">'+
      (opts.fragment ? '<meta name="wsed-fragment" data-wsed="fragment">' : '');
    const bodyInject =
      '<script src="' + escapeAttr(opts.jsHref || '/__wsed/inject.js') + '" data-wsed="js"></script>';

    // Insert in head (right after <head ...>) or create one.
    if (/<head\b[^>]*>/i.test(out)) {
      out = out.replace(/<head\b[^>]*>/i, function (m) { return m + headInject; });
    } else if (/<html\b[^>]*>/i.test(out)) {
      out = out.replace(/<html\b[^>]*>/i, function (m) { return m + '<head>' + headInject + '</head>'; });
    } else {
      out = headInject + out;
    }

    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>(?![\s\S]*<\/body>)/i, bodyInject + '</body>');
    } else if (/<\/html>/i.test(out)) {
      out = out.replace(/<\/html>(?![\s\S]*<\/html>)/i, bodyInject + '</html>');
    } else {
      out = out + bodyInject;
    }
    return out;
  }

  // ---------- Jinja / Flask templates ----------
  // Template syntax ({{ }}, {% %}, {# #}) does not survive a trip through the
  // browser DOM: tags inside an element's start tag become junk attributes, and
  // text inside tables gets moved. protectTemplate() swaps every construct for
  // an inert placeholder before the page is loaded; restoreTemplate() swaps the
  // originals back into the serialised HTML. Placeholders carry a generation
  // number so HTML from a stale frame is never restored with the wrong map.
  //   inside a start tag     ->  data-wsj-G-N=""
  //   in an attribute value  ->  __wsj_G_N__      (only when the text itself would break it)
  //   {% %} / {# #} in text  ->  <!--wsj:G:N-->
  //   url_for('static', filename='x')  ->  <staticBase>x#wsjG_N  (so CSS and images load)
  //   include / macro call   ->  <!--wsj-inc:G:N src=FILE-->rendered body<!--/wsj-inc:G:N-->
  //                              (src= names the template it came from; omitted for macros in this file)
  const JINJA_RE = /\{\{|\{%|\{#/;
  const STATIC_RE = /^\{\{-?\s*url_for\(\s*(['"])static\1\s*,\s*filename\s*=\s*(['"])([^'"]+)\2\s*\)\s*-?\}\}$/;
  const RAW_TAGS = { script: 1, style: 1, textarea: 1, title: 1 };
  let generation = 0;

  function isTemplate(html) { return JINJA_RE.test(html); }

  function jinjaEnd(html, i) {
    const close = { '{': '}}', '%': '%}', '#': '#}' }[html[i + 1]];
    const j = html.indexOf(close, i + 2);
    return j < 0 ? html.length : j + 2;
  }

  /**
   * @param {string} html
   * @param {object} opts  { staticBase, expand }
   *   staticBase  absolute URL that Flask's static/ folder is served at
   *   expand(s)   { html, file } to show in place of a {{ }} / {% %} construct, or null (see templateExpander)
   * @returns {{ html: string, gen: number, map: string[] }}
   */
  function protectTemplate(html, opts) {
    opts = opts || {};
    const gen = ++generation;
    const map = [];
    const keep = (s) => map.push(s) - 1;
    const staticUrl = (s) => {
      const m = opts.staticBase && STATIC_RE.exec(s);
      return m ? opts.staticBase + m[3] + '#wsj' + gen + '_' + keep(s) : null;
    };
    const asToken = (s) => '__wsj_' + gen + '_' + keep(s) + '__';
    // Raw text (script/style/...): only static URLs are rewritten, the rest is left verbatim.
    const rawText = (s) => s.replace(/\{\{[\s\S]*?\}\}/g, (m) => staticUrl(m) || m);

    function walk(html, expand) {
      let out = '';
      let i = 0;
      const n = html.length;
      while (i < n) {
        const c = html[i];
        if (c === '{' && JINJA_RE.test(html.substr(i, 2))) {
          const e = jinjaEnd(html, i);
          const s = html.slice(i, e);
          const inc = expand && expand(s);
          if (inc != null) {
            // rendered include / macro call: shown read-only, collapsed back to `s` on restore
            const k = gen + ':' + keep(s);
            const src = inc.file ? ' src=' + encodeURIComponent(inc.file).replace(/-/g, '%2D') : '';
            out += '<!--wsj-inc:' + k + src + '-->' + walk(inc.html, null) + '<!--/wsj-inc:' + k + '-->';
          } else if (s[1] === '{' && !/[<&]/.test(s)) out += staticUrl(s) || s;
          else out += '<!--wsj:' + gen + ':' + keep(s) + '-->';
          i = e;
        } else if (html.startsWith('<!--', i)) {
          const e = html.indexOf('-->', i + 4);
          const end = e < 0 ? n : e + 3;
          out += html.slice(i, end);
          i = end;
        } else if (c === '<' && /[a-zA-Z\/!?]/.test(html[i + 1] || '')) {
          // A tag: walk it, tracking quoted attribute values.
          const nameMatch = /^<\/?([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 64));
          const name = nameMatch ? nameMatch[1].toLowerCase() : '';
          const isEnd = html[i + 1] === '/';
          let j = i + 1;
          out += '<';
          let quote = null;
          while (j < n) {
            const ch = html[j];
            if (ch === '{' && JINJA_RE.test(html.substr(j, 2))) {
              if (quote) {
                const e = jinjaEnd(html, j);
                const s = html.slice(j, e);
                out += staticUrl(s) || (s.includes(quote) || /[&<]/.test(s) ? asToken(s) : s);
                j = e;
              } else if (/=\s*$/.test(out)) {
                // unquoted attribute value
                const e = jinjaEnd(html, j);
                const s = html.slice(j, e);
                out += staticUrl(s) || asToken(s);
                j = e;
              } else {
                // Template logic between attributes: swallow the whole run, e.g.
                // {% if x %}selected{% endif %} or {% if c %}class="a b"{% endif %}
                let e = j;
                while (e < n && !/[\s>]/.test(html[e]) && !html.startsWith('/>', e)) {
                  if (html[e] === '{' && JINJA_RE.test(html.substr(e, 2))) e = jinjaEnd(html, e);
                  else if (html[e] === '"' || html[e] === "'") { const q = html.indexOf(html[e], e + 1); e = q < 0 ? n : q + 1; }
                  else e++;
                }
                out += (/\s$/.test(out) ? '' : ' ') + 'data-wsj-' + gen + '-' + keep(html.slice(j, e)) + '=""';
                j = e;
              }
              continue;
            }
            out += ch;
            j++;
            if (quote) { if (ch === quote) quote = null; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === '>') break;
          }
          i = j;
          if (!isEnd && RAW_TAGS[name] && !/\/>$/.test(out)) {
            const close = html.slice(i).search(new RegExp('</' + name + '\\b', 'i'));
            const end = close < 0 ? n : i + close;
            out += rawText(html.slice(i, end));
            i = end;
          }
        } else {
          out += c;
          i++;
        }
      }
      return out;
    }
    return { html: walk(html, opts.expand), gen, map };
  }

  /** Put the original template syntax back. `maps` is { [gen]: map }. */
  function restoreTemplate(html, maps) {
    const get = (g, k, m) => { const map = maps[g]; return map && map[k] !== undefined ? map[k] : m; };
    return html
      .replace(/<!--wsj-inc:(\d+):(\d+)(?: src=[^\s>]*)?-->[\s\S]*?<!--\/wsj-inc:\1:\2-->/g, (m, g, k) => get(g, k, m))
      .replace(/<!--wsj:(\d+):(\d+)-->/g, (m, g, k) => get(g, k, m))
      .replace(/( ?)data-wsj-(\d+)-(\d+)=""/g, (m, sp, g, k) => { const v = get(g, k, null); return v === null ? m : sp + v; })
      .replace(/__wsj_(\d+)_(\d+)__/g, (m, g, k) => get(g, k, m))
      .replace(/[^\s"'()]*#wsj(\d+)_(\d+)(?!\d)/g, (m, g, k) => get(g, k, m));
  }

  // ---------- includes, imports and macros ----------
  const IMPORT_RE = /\{%-?\s*import\s+['"]([^'"]+)['"]\s+as\s+(\w+)/g;
  const FROM_RE = /\{%-?\s*from\s+['"]([^'"]+)['"]\s+import\s+([\w\s,]+?)\s*(?:with(?:out)?\s+context\s*)?-?%\}/g;
  const INCLUDE_RE = /^\{%-?\s*include\s+['"]([^'"]+)['"][^%]*-?%\}$/;
  const MACRO_RE = /\{%-?\s*macro\s+(\w+)\s*\([\s\S]*?\)\s*-?%\}([\s\S]*?)\{%-?\s*endmacro\s*-?%\}/g;
  const CALL_RE = /^\{\{-?\s*(?:(\w+)\.)?(\w+)\s*\([\s\S]*\)\s*-?\}\}$/;

  /** Template names that `html` pulls in via import / from-import / include. */
  function templateRefs(html) {
    const refs = new Set();
    for (const m of html.matchAll(IMPORT_RE)) refs.add(m[1]);
    for (const m of html.matchAll(FROM_RE)) refs.add(m[1]);
    for (const m of html.matchAll(/\{%-?\s*include\s+['"]([^'"]+)['"]/g)) refs.add(m[1]);
    return [...refs];
  }

  // macro name -> { html: body, file: template it is defined in (null for this file) }
  function macrosOf(html, file) {
    const out = {};
    for (const m of (html || '').matchAll(MACRO_RE)) out[m[1]] = { html: m[2], file: file || null };
    return out;
  }

  /**
   * Build an `expand` function for protectTemplate. `files` maps template
   * names to their source. Bodies are shown unrendered (both sides of an
   * {% if %} etc.), one level deep. Returns { html, file } or null.
   */
  function templateExpander(html, files) {
    const local = macrosOf(html);
    const ns = {};
    for (const m of html.matchAll(IMPORT_RE)) ns[m[2]] = macrosOf(files[m[1]], m[1]);
    for (const m of html.matchAll(FROM_RE)) {
      const macros = macrosOf(files[m[1]], m[1]);
      for (const part of m[2].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        if (macros[name] !== undefined) local[alias || name] = macros[name];
      }
    }
    return function (s) {
      let m = INCLUDE_RE.exec(s);
      if (m) return files[m[1]] != null ? { html: files[m[1]], file: m[1] } : null;
      m = CALL_RE.exec(s);
      if (!m) return null;
      const body = m[1] ? ns[m[1]] && ns[m[1]][m[2]] : local[m[2]];
      return body !== undefined ? body : null;
    };
  }

  return { DISABLED_TYPE, disableScripts, prepareForEditing, isTemplate, protectTemplate, restoreTemplate, templateRefs, templateExpander };
});
