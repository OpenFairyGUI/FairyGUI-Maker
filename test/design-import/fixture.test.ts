import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { canonicalJson, makerImportSha256, serializeMakerImportBundleV1 } from '../../src/design-import/bundle';
import { parseImportFixture } from '../../src/design-import/fixture';
import type { ImportDocument, ImportText, ImportTextRun } from '../../src/design-import/model';
import { importDesignSource } from '../../src/design-import/node';

const common = {
  x: 0, y: 0, width: 100, height: 30, visible: true, opacity: 1, rotation: 0,
  scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true,
};
const style = { fontFamily: 'Arial', fontSize: 16, color: '#ffffff', bold: false, italic: false, underline: false, strikethrough: false };
const text: ImportText = {
  ...common, ...style, kind: 'text', id: 'text', name: 'Text', text: 'A😀BC', align: 'left', verticalAlign: 'top',
  lineHeight: null, letterSpacing: 0, autoSize: 'none', singleLine: false, runs: [], shadow: null,
};
const document = (): ImportDocument => ({
  name: 'Fixture', diagnostics: [], pages: [{ id: 'page', name: 'Page', roots: [{
    ...common, kind: 'frame', id: 'root', name: 'Root', sourceType: 'frame', variantProperties: {},
    layout: null, clipContent: false, backgroundColor: null, children: [structuredClone(text)],
  }] }],
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const parse = (value: unknown) => parseImportFixture({ 'fixture.json': bytes(value) });

test('fixture text runs are ordered UTF-16 ranges, with gaps allowed and invalid ranges rejected', () => {
  const source = document();
  const node = source.pages[0].roots[0].children[0] as ImportText;
  node.runs = [{ ...style, start: 1, end: 3 }, { ...style, start: 4, end: 5 }];
  assert.deepEqual(parse(source), source);
  const invalid: Array<Array<Pick<ImportTextRun, 'start' | 'end'>>> = [
    [{ start: -1, end: 1 }], [{ start: 0.5, end: 2 }], [{ start: 0, end: 1.5 }],
    [{ start: 0, end: 6 }], [{ start: 1, end: 1 }], [{ start: 2, end: 1 }],
    [{ start: 0, end: 3 }, { start: 2, end: 5 }], [{ start: 3, end: 5 }, { start: 0, end: 1 }],
  ];
  for (const runs of invalid) {
    node.runs = runs.map((run) => ({ ...style, ...run }));
    assert.throws(() => parse(source), /ordered, non-overlapping integer ranges/, JSON.stringify(runs));
  }
});

test('fixture enforces node, collection, metadata and aggregate string budgets', () => {
  const cases: Array<[string, (value: ImportDocument) => void, RegExp]> = [
    ['pages', (d) => { d.pages = Array.from({ length: 101 }, () => d.pages[0]); }, /at most 100 entries/],
    ['roots', (d) => { d.pages[0].roots = Array.from({ length: 1_001 }, () => d.pages[0].roots[0]); }, /at most 1000 entries/],
    ['metadata', (d) => { d.name = 'a'.repeat(1_025); }, /at most 1024 UTF-16/],
    ['text', (d) => { (d.pages[0].roots[0].children[0] as ImportText).text = 'a'.repeat(1_048_577); }, /UTF-16 budget/],
    ['runs', (d) => { (d.pages[0].roots[0].children[0] as ImportText).runs = Array.from({ length: 4_097 }, () => ({ ...style, start: 0, end: 1 })); }, /at most 4096 entries/],
    ['variants', (d) => { d.pages[0].roots[0].variantProperties = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`v${i}`, 'x'])); }, /at most 256 entries/],
    ['total nodes', (d) => { d.pages[0].roots[0].children = Array.from({ length: 10_000 }, (_, i) => ({ ...text, id: `n${i}` })); }, /at most 10000 nodes/],
    ['total strings', (d) => { d.pages[0].roots[0].children = Array.from({ length: 5 }, (_, i) => ({ ...text, id: `n${i}`, text: 'x'.repeat(1_048_576) })); }, /UTF-16 budget/],
    ['unused collection', (d) => { Object.assign(d, { unused: Array(10_001).fill(null) }); }, /at most 10000 entries/],
    ['unused nesting', (d) => { let item: unknown = null; for (let i = 0; i < 220; i++) item = { child: item }; Object.assign(d, { unused: item }); }, /bounded JSON tree/],
  ];
  for (const [name, change, error] of cases) {
    const source = document();
    change(source);
    assert.throws(() => parse(source), error, name);
  }
  assert.deepEqual(parse(document()), document(), 'a rejected input does not poison the next parse');
});

test('invalid text runs fail the real bundle import before creating a target project', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'maker-fixture-boundary-'));
  try {
    const source = join(parent, 'source');
    const target = join(parent, 'target');
    const files = await serializeMakerImportBundleV1({
      source: { kind: 'raster', name: 'fixture', sha256: '0'.repeat(64) }, document: document(),
    });
    const fixture = JSON.parse(new TextDecoder().decode(files['fixture.json']));
    fixture.pages[0].roots[0].children[0].runs = [{ ...style, start: 0, end: 100 }];
    files['fixture.json'] = new TextEncoder().encode(`${JSON.stringify(canonicalJson(fixture), null, 2)}\n`);
    const manifest = JSON.parse(new TextDecoder().decode(files['maker-import.json']));
    manifest.document.byteLength = files['fixture.json'].length;
    manifest.document.sha256 = await makerImportSha256(files['fixture.json']);
    files['maker-import.json'] = new TextEncoder().encode(`${JSON.stringify(canonicalJson(manifest), null, 2)}\n`);
    await mkdir(source);
    for (const [name, data] of Object.entries(files)) await writeFile(join(source, name), data);
    await assert.rejects(importDesignSource({ sourcePath: source, outputPath: target }), /ordered, non-overlapping integer ranges/);
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally { await rm(parent, { recursive: true, force: true }); }
});
