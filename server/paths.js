'use strict';
const path = require('path');

/** Resolve a workspace-relative (posix style) path and refuse escapes. */
function resolveInside(root, rel) {
  const cleaned = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, cleaned);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
    const err = new Error('Path escapes workspace: ' + rel);
    err.status = 400;
    throw err;
  }
  return abs;
}

/** Convert an absolute path under root to a posix-style relative path. */
function toRel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

module.exports = { resolveInside, toRel };
