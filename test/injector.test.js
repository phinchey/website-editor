'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { prepareForEditing, disableScripts, DISABLED_TYPE, protectTemplate, restoreTemplate, isTemplate, templateRefs, templateExpander } = require('../public/shared/injector.js');
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

test('protectTemplate replaces Jinja with inert placeholders and resolves static urls', () => {
  const src = `<link href="{{ url_for('static', filename='styles/s.css') }}">` +
    `<option value="a" {% if x == 'a' %}selected{% endif %}>A</option>` +
    `<table>{% for r in rows %}<tr><td>{{ r.name }}</td></tr>{% endfor %}</table>` +
    `<style>body{background:url({{ url_for("static", filename="bg.png") }})}</style>`;
  assert.ok(isTemplate(src));
  const t = protectTemplate(src, { staticBase: 'http://h/preview/static/' });
  assert.match(t.html, /href="http:\/\/h\/preview\/static\/styles\/s\.css#wsj\d+_0"/);
  assert.match(t.html, /<option value="a" data-wsj-\d+-1="">A/);
  assert.match(t.html, /<table><!--wsj:\d+:2--><tr><td>\{\{ r\.name \}\}<\/td><\/tr><!--wsj:\d+:3--><\/table>/);
  assert.match(t.html, /url\(http:\/\/h\/preview\/static\/bg\.png#wsj\d+_4\)/);
  assert.strictEqual(restoreTemplate(t.html, { [t.gen]: t.map }), src);
});

test('restoreTemplate leaves placeholders from unknown generations alone', () => {
  assert.strictEqual(restoreTemplate('<!--wsj:999:0-->', {}), '<!--wsj:999:0-->');
});

test('includes and imported macros render read-only and collapse back on restore', () => {
  const src = `{% import '_m.html' as m %}{% from '_m.html' import b as bee %}{% include 'nav.html' %}` +
    `<div>{{ m.a(x=1) }}</div><div>{{ bee() }}</div><p>{{ m.missing() }}</p>`;
  const files = { '_m.html': '{% macro a(x) %}<ul><li>A {{ x }}</li></ul>{% endmacro %}{% macro b() %}<b>B</b>{% endmacro %}', 'nav.html': '<nav>N</nav>' };
  assert.deepStrictEqual(templateRefs(src).sort(), ['_m.html', 'nav.html']);
  const t = protectTemplate(src, { expand: templateExpander(src, files) });
  assert.match(t.html, /<!--wsj-inc:\d+:\d+ src=nav\.html--><nav>N<\/nav><!--\/wsj-inc:\d+:\d+-->/);
  assert.match(t.html, /<div><!--wsj-inc:(\d+:\d+) src=_m\.html--><ul><li>A \{\{ x \}\}<\/li><\/ul><!--\/wsj-inc:\1--><\/div>/);
  assert.match(t.html, /<div><!--wsj-inc:(\d+:\d+) src=_m\.html--><b>B<\/b><!--\/wsj-inc:\1--><\/div>/);
  assert.match(t.html, /<p>\{\{ m\.missing\(\) \}\}<\/p>/);
  assert.strictEqual(restoreTemplate(t.html, { [t.gen]: t.map }), src);
});

test('prepareForEditing marks partials so they are saved without a wrapper', () => {
  assert.match(prepareForEditing('<ul></ul>', { fragment: true }), /<meta name="wsed-fragment" data-wsed="fragment">/);
  assert.doesNotMatch(prepareForEditing('<ul></ul>', {}), /wsed-fragment/);
});

test('local macros render without a source file; dashes in names cannot end the marker comment', () => {
  const src = `{% macro a() %}<i>A</i>{% endmacro %}{% include 'a--b.html' %}{{ a() }}`;
  const t = protectTemplate(src, { expand: templateExpander(src, { 'a--b.html': '<nav>N</nav>' }) });
  assert.match(t.html, /<!--wsj-inc:\d+:\d+ src=a%2D%2Db\.html--><nav>/);
  assert.match(t.html, /<!--wsj-inc:\d+:\d+--><i>A<\/i>/);
  assert.strictEqual(restoreTemplate(t.html, { [t.gen]: t.map }), src);
});
