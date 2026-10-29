'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { prepareForEditing, disableScripts, DISABLED_TYPE } = require('../public/shared/injector.js');
const { resolveInside, toRel } = require('../server/paths.js');
const path = require('path');

test('disableScripts neutralises scripts and parks the original type', () => {
  const out = disableScripts('<script src="a.js"></script><script type="module">x</script><SCRIPT>y</SCRIPT>');
  assert.match(out, /<script src="a.js" type="text\/x-wsed-disabled">/);
  assert.match(out, /<script data-wsed-type="module" type="text\/x-wsed-disabled">x<\/script>/);
  assert.match(out, /<SCRIPT type="text\/x-wsed-disabled">y<\/SCRIPT>/);
  assert.strictEqual(disableScripts(out), out, 'idempotent');
});

test('prepareForEditing injects base, css and js in the right places', () => {
  const html = '<!DOCTYPE html>\n<html><head><title>t</title></head><body><p>hi</p></body></html>';
  const out = prepareForEditing(html, { baseHref: 'http://x/preview/dir/', cssHref: '/c.css', jsHref: '/j.js' });
  assert.match(out, /<head><base href="http:\/\/x\/preview\/dir\/" data-wsed="base"><link rel="stylesheet" href="\/c.css" data-wsed="css"><title>/);
  assert.match(out, /<p>hi<\/p><script src="\/j.js" data-wsed="js"><\/script><\/body>/);
});

test('prepareForEditing copes with fragments without head/body', () => {
  const out = prepareForEditing('<h1>bare</h1>', {});
  assert.ok(out.startsWith('<link rel="stylesheet"'));
  assert.ok(out.endsWith('data-wsed="js"></script>'));
});

test('resolveInside refuses to escape the workspace', () => {
  const root = path.resolve('/tmp/ws');
  assert.strictEqual(resolveInside(root, 'a/b.html'), path.join(root, 'a', 'b.html'));
  assert.strictEqual(resolveInside(root, '/leading/slash.html'), path.join(root, 'leading', 'slash.html'));
  assert.strictEqual(resolveInside(root, ''), root);
  assert.throws(() => resolveInside(root, '../etc/passwd'), /escapes/);
  assert.throws(() => resolveInside(root, 'a/../../x'), /escapes/);
  assert.strictEqual(toRel(root, path.join(root, 'a', 'b')), 'a/b');
});
