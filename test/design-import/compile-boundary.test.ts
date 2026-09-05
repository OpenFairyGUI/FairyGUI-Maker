import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { convertDocument, compilePlanToUam } from '../../src/design-import/convert';
import { serializeMakerImportBundleV1 } from '../../src/design-import/bundle';
import { planDocument } from '../../src/design-import/plan';
import { importDesignSource } from '../../src/design-import/node';
import type { ImportDocument, ImportFrame, ImportInstance, ImportInstanceOverride, ImportNode, ImportText } from '../../src/design-import/model';

const common = (id: string) => ({ id, name: id, x: 0, y: 0, width: 100, height: 30, visible: true,
  opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true });
const style = { fontFamily: 'Arial', fontSize: 16, color: '#ffffff', bold: false, italic: false, underline: false, strikethrough: false };
const text = (value: string): ImportText => ({ ...common('text'), ...style, kind: 'text', text: value,
  align: 'left', verticalAlign: 'top', lineHeight: null, letterSpacing: 0, autoSize: 'none',
  singleLine: false, runs: [], shadow: null });
const frame = (id: string, children: ImportNode[]): ImportFrame => ({ ...common(id), kind: 'frame',
  sourceType: 'component', variantProperties: {}, layout: null, clipContent: false, backgroundColor: null, children });
const document = (...roots: ImportFrame[]): ImportDocument => ({ name: 'Boundaries', diagnostics: [], pages: [{ id: 'page', name: 'Page', roots }] });
const override = (targetId = 'text', targetPath: string[] = []): ImportInstanceOverride => ({
  targetId, targetPath, componentId: null, name: null, text: 'Changed', visible: null, opacity: null,
  width: null, height: null, fillColor: null, strokeColor: null, strokeWidth: null, cornerRadius: null,
  fontFamily: null, fontSize: null, bold: null, italic: null, underline: null, strikethrough: null,
});
const instance = (id: string, componentId: string, overrides: ImportInstanceOverride[] = []): ImportInstance =>
  ({ ...common(id), kind: 'instance', componentId, overrides });

test('compilation escapes literal UBB/HTML, retains unstyled gaps, and diagnoses plain-text fallback', () => {
  const label = text('A[b]<&>BC');
  label.runs = [{ ...style, start: 1, end: 8, bold: true }];
  const source = document(frame('root', [label]));
  const converted = convertDocument(source);
  const result = converted.project.packages[0].resources[0];
  assert.ok(result.kind === 'component');
  const node = result.component.displayList[0];
  assert.ok(node.kind === 'richText');
  assert.equal(node.text, 'A[b]\\[b]&lt;&amp;&gt;B[/b]C');
  assert.equal(node.ubbEnabled, true);
  for (const change of [
    (n: ImportText) => { n.text += '\\'; },
    (n: ImportText) => { n.runs[0].fontFamily = 'Arial"/><img src="https://invalid.example/'; },
    (n: ImportText) => { n.runs[0].color = '#fff][img]https://invalid.example/[/img]'; },
    (n: ImportText) => { n.runs[0].strikethrough = true; },
  ]) {
    const input = structuredClone(source);
    const label = input.pages[0].roots[0].children[0] as ImportText;
    change(label);
    const output = convertDocument(input);
    const resource = output.project.packages[0].resources[0];
    assert.ok(resource.kind === 'component');
    const plain = resource.component.displayList[0];
    assert.ok(plain.kind === 'text');
    assert.equal(plain.ubbEnabled, false);
    assert.equal(plain.text, label.text);
    assert.equal(output.report.diagnostics.RICH_TEXT_PLAIN_FALLBACK, 1);
  }
  const invalid = structuredClone(source);
  (invalid.pages[0].roots[0].children[0] as ImportText).runs[0].end = 100;
  assert.throws(() => compilePlanToUam(invalid, planDocument(invalid)), /ordered, non-overlapping integer ranges/);
});

test('overriding a rich text value switches to a plain node, preventing HTML interpretation', () => {
  const label = text('Default');
  label.runs = [{ ...style, start: 0, end: 7, bold: true }];
  const value = '<img src="https://invalid.example/">[img]ui://bad[/img]';
  const converted = convertDocument(document(frame('component', [label]), frame('root', [
    instance('instance', 'component', [{ ...override(), text: value }]),
  ])));
  const clone = converted.project.packages[0].resources.find((resource) => resource.id === converted.ids['instance:overridden-resource']);
  assert.ok(clone?.kind === 'component');
  const node = clone.component.displayList[0];
  assert.ok(node.kind === 'text');
  assert.equal(node.text, value);
  assert.equal(node.ubbEnabled, false);
});

test('override limits reject direct compiler callers, clone amplification and deep reference routes', () => {
  const leaf = frame('leaf', [text('Default')]);
  assert.throws(() => convertDocument(document(leaf, frame('root', [
    instance('many', 'leaf', Array.from({ length: 257 }, () => override())),
  ]))), /INSTANCE_OVERRIDE_LIMIT/);
  assert.throws(() => convertDocument(document(leaf, frame('root', [
    instance('deep-path', 'leaf', [override('text', Array(33).fill('text'))]),
  ]))), /INSTANCE_OVERRIDE_LIMIT/);
  assert.throws(() => convertDocument(document(frame('empty', []), frame('root',
    Array.from({ length: 1_025 }, (_, i) => instance(`i${i}`, 'empty', [override()])),
  ))), /1024 clones/);
  assert.throws(() => convertDocument(document(frame('large', [text('x'.repeat(1024 * 1024))]), frame('root',
    Array.from({ length: 33 }, (_, i) => instance(`i${i}`, 'large', [override()])),
  ))), /cloned component data exceeds 32 MiB/);
  const chain = Array.from({ length: 33 }, (_, i) => frame(`c${i}`, [instance(`edge${i}`, i === 32 ? 'leaf' : `c${i + 1}`)]));
  assert.throws(() => convertDocument(document(leaf, ...chain, frame('root', [instance('deep', 'c0', [override()])]))), /component route exceeds 32 levels/);
  assert.doesNotThrow(() => convertDocument(document(leaf, frame('root', [instance('ok', 'leaf', [override()])]))));
});

test('clone budget failure leaves no target directory through the actual import command', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'maker-override-budget-'));
  try {
    const source = join(parent, 'source');
    const target = join(parent, 'target');
    const files = await serializeMakerImportBundleV1({
      source: { kind: 'raster', name: 'large-overrides', sha256: '0'.repeat(64) },
      document: document(frame('large', [text('x'.repeat(1024 * 1024))]), frame('root',
        Array.from({ length: 33 }, (_, i) => instance(`i${i}`, 'large', [override()])))),
    });
    await mkdir(source);
    for (const [name, data] of Object.entries(files)) await writeFile(join(source, name), data);
    await assert.rejects(importDesignSource({ sourcePath: source, outputPath: target }), /INSTANCE_OVERRIDE_LIMIT/);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
