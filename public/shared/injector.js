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
   * @param {object} opts   { baseHref, cssHref, jsHref }
   */
  function prepareForEditing(html, opts) {
    opts = opts || {};
    let out = disableScripts(html);
    const headInject =
      (opts.baseHref ? '<base href="' + escapeAttr(opts.baseHref) + '" data-wsed="base">' : '') +
      '<link rel="stylesheet" href="' + escapeAttr(opts.cssHref || '/__wsed/inject.css') + '" data-wsed="css">';
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

  return { DISABLED_TYPE, disableScripts, prepareForEditing };
});
