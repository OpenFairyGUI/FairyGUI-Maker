import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import test from 'node:test';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import { convertDocument, safeName } from '../../src/design-import/convert';
import { MemoryFileSystem } from '../../src/design-import/memory-fs';
import type { ImportDocument } from '../../src/design-import/model';

test('ZIP wrappers reject traversal, absolute paths and cross-platform reserved names, even for empty archives', async () => {
  const files = new MemoryFileSystem();
  const invalid = ['', ' ', '.', '..', '../escape', '..\\escape', '/absolute', '\\server\\share', 'C:\\escape',
    'C:escape', 'a/b', 'a\\b', 'CON', 'nul.txt', 'COM1', 'LPT².log', 'trailing.', 'trailing ', 'control\0', 'control\u007f', 'a'.repeat(81)];
  for (const name of invalid) assert.throws(() => files.toZipEntries(name), /ZIP wrapper/, name);
  await files.writeFile('/project.fairy', 'project');
  await files.writeFile('/assets/Main/package.xml', 'package');
  await assert.rejects(files.readdir('/project.fairy'), /Not a directory/);
  await assert.rejects(files.readdir('/missing'), /Not a directory/);
  assert.deepEqual(await files.readdir('/assets/Main'), ['package.xml']);
  for (const name of invalid) assert.throws(() => files.toZipEntries(name), /ZIP wrapper/, name);
  const entries = files.toZipEntries('工程 Demo');
  assert.deepEqual(Object.keys(entries), ['工程 Demo/project.fairy', '工程 Demo/assets/Main/package.xml']);
  for (const name of Object.keys(entries)) assert.ok(posix.normalize(name).startsWith('工程 Demo/'));
  assert.equal(safeName('COM¹'), '_COM¹');
  assert.equal(safeName(`${'a'.repeat(79)}.suffix`), 'a'.repeat(79));
});

test('package and resource names share deterministic case-insensitive NFC collision rules and survive disk roundtrip', async () => {
  const names = ['UI', 'ui', 'ui_2', 'UI.', 'é', 'e\u0301', 'NUL', '_nul', 'x'.repeat(80), 'X'.repeat(80)];
  const source: ImportDocument = {
    name: 'Names', diagnostics: [], pages: names.map((name, i) => ({ id: `page${i}`, name, roots: [{
      kind: 'frame', id: `root${i}`, name: 'Root', x: 0, y: 0, width: 100, height: 30, visible: true,
      opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true,
      sourceType: 'frame', variantProperties: {}, layout: null, clipContent: false, backgroundColor: null, children: [],
    }] })),
  };
  const converted = convertDocument(source);
  const expected = ['UI', 'ui_2', 'ui_2_2', 'UI_3', 'é', 'é_2', '_NUL', '_nul_2', 'x'.repeat(80), `${'X'.repeat(78)}_2`];
  assert.deepEqual(converted.project.packages.map((pkg) => pkg.name), expected);
  assert.deepEqual(convertDocument(source), converted);
  assert.deepEqual(convertDocument(source, converted.ids).project, converted.project);
  const directory = await mkdtemp(join(tmpdir(), 'maker-import-paths-'));
  try {
    const target = join(directory, 'Names.fairy');
    await writeProjectFromUam(new NodeIO(), converted.project, target);
    const restored = await readProjectAsUam(new NodeIO(), target);
    assert.deepEqual(new Set(restored.packages.map((pkg) => pkg.name)), new Set(expected));
    assert.equal(restored.packages.length, names.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
