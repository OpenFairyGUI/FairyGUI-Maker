import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import { writePsdUint8Array } from 'ag-psd';
import { convertDocument } from '../../src/design-import';
import { parsePsdFile } from '../../src/design-import/node';

const pixels = new Uint8ClampedArray([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255,
]);

const thirdPartyFixtures = [
  { name: 'type-layer.psd', nodes: 2, editableText: 1, rasterizedNodes: 0, components: 1, images: 0 },
  { name: 'artboard.psd', nodes: 5, editableText: 1, rasterizedNodes: 2, components: 2, images: 2 },
  { name: 'mask.psd', nodes: 4, editableText: 0, rasterizedNodes: 3, components: 1, images: 3 },
  { name: 'effects-enabled.psd', nodes: 5, editableText: 0, rasterizedNodes: 4, components: 1, images: 1 },
];

function fixture(): Uint8Array {
  return writePsdUint8Array({
    width: 100,
    height: 60,
    children: [{
      id: 10,
      name: 'HUD',
      children: [{
        id: 11,
        name: 'Score',
        left: 10,
        top: 5,
        right: 12,
        bottom: 7,
        imageData: { width: 2, height: 2, data: pixels },
        text: {
          text: '1,250',
          style: { font: { name: 'Arial' }, fontSize: 24, fillColor: { r: 255, g: 255, b: 255 } },
          paragraphStyle: { justification: 'center' },
        },
      }, {
        id: 12,
        name: 'Icon',
        left: 20,
        top: 10,
        right: 22,
        bottom: 12,
        imageData: { width: 2, height: 2, data: pixels },
      }],
    }],
  });
}

test('reads a real PSD layer tree and converts text plus pixels', async () => {
  assert.throws(() => parsePsdFile(new Uint8Array([0])), /missing 8BPS signature/);
  const psb = fixture();
  psb[5] = 2;
  assert.throws(() => parsePsdFile(psb), /PSB files are not supported/);
  const oversized = fixture();
  new DataView(oversized.buffer, oversized.byteOffset, oversized.byteLength).setUint32(18, 10_001);
  assert.throws(() => parsePsdFile(oversized), /document exceeds 10000 px/);

  const source = fixture();
  const document = parsePsdFile(source, 'Game HUD');
  const root = document.pages[0].roots[0];
  assert.equal(root.name, 'Game HUD');
  assert.equal(root.children[0].kind, 'frame');
  const group = root.children[0];
  assert.ok(group.kind === 'frame');
  assert.deepEqual(group.children.map((child) => child.kind), ['text', 'image']);
  assert.equal(group.x, 10);
  assert.equal(group.y, 5);
  assert.equal(group.children[1].x, 10);
  assert.deepEqual(document.diagnostics.map((item) => item.code), ['RASTERIZED_NODE']);
  const image = group.children[1];
  assert.ok(image.kind === 'image');
  assert.deepEqual(Array.from(image.bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);

  const directory = await mkdtemp(join(tmpdir(), 'fairygui-maker-import-psd-'));
  try {
    const output = join(directory, 'Game HUD.fairy');
    const converted = convertDocument(document);
    await writeProjectFromUam(new NodeIO(), converted.project, output);
    const project = await readProjectAsUam(new NodeIO(), output, { hydrateResourceBytes: true });
    assert.equal(project.packages[0].resources.filter((item) => item.kind === 'image').length, 1);
    assert.equal(project.packages[0].resources.filter((item) => item.kind === 'component').length, 2);
    assert.ok(converted.ids['psd:12:resource']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('converts the pinned third-party PSD corpus into readable FairyGUI projects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fairygui-maker-import-psd-corpus-'));
  try {
    for (const expected of thirdPartyFixtures) {
      const input = join(process.cwd(), 'test', 'fixtures', 'design-import', expected.name);
      const output = join(directory, `${expected.name}.fairy`);
      const converted = convertDocument(parsePsdFile(await readFile(input), expected.name));
      const report = converted.report;
      assert.equal(report.nodes, expected.nodes, expected.name);
      assert.equal(report.editableText, expected.editableText, expected.name);
      assert.equal(report.rasterizedNodes, expected.rasterizedNodes, expected.name);

      await writeProjectFromUam(new NodeIO(), converted.project, output);
      const project = await readProjectAsUam(new NodeIO(), output, { hydrateResourceBytes: true });
      const resources = project.packages.flatMap((item) => item.resources);
      assert.equal(resources.filter((item) => item.kind === 'component').length, expected.components, expected.name);
      assert.equal(resources.filter((item) => item.kind === 'image').length, expected.images, expected.name);
      const imageNodes = resources.filter((item) => item.kind === 'component')
        .flatMap((item) => item.component.displayList)
        .filter((item) => item.kind === 'image');
      assert.equal(imageNodes.length, expected.rasterizedNodes, expected.name);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
