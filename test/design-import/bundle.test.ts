import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAKER_IMPORT_BUNDLE_MANIFEST,
  makerImportSha256,
  parseMakerImportBundleV1,
  serializeMakerImportBundleV1,
  type ImportDocument,
  type ImportFrame,
  type ImportImage,
} from '../../src/design-import';

const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const common = (id: string, x: number) => ({
  id,
  name: id,
  x,
  y: 0,
  width: 10,
  height: 10,
  visible: true,
  opacity: 1,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  mask: false,
  constraints: null,
  layoutChild: true,
});
const image = (id: string, x: number): ImportImage => ({
  kind: 'image',
  ...common(id, x),
  format: 'png',
  bytes,
});
const document: ImportDocument = {
  name: 'Bundle',
  diagnostics: [{ code: 'TEST_WARNING', message: 'kept in ImportDocument', nodeId: 'image:a', severity: 'warning' }],
  pages: [{
    id: 'page',
    name: 'Page',
    roots: [{
      kind: 'frame',
      ...common('root', 0),
      sourceType: 'frame',
      variantProperties: {},
      layout: null,
      clipContent: false,
      backgroundColor: null,
      children: [image('image:a', 0), image('image:B', 12)],
    }],
  }],
};

test('round-trips deterministic Maker Import Bundle v1 files and rejects tampering', async () => {
  const sourceBytes = new TextEncoder().encode('source');
  const input = {
    source: { kind: 'raster' as const, name: 'source.png', sha256: await makerImportSha256(sourceBytes) },
    document,
    assetBindings: {
      'image:B': {
        pixelRatio: 2,
        trimOffset: { x: 1, y: 2 },
        scale9Grid: { x: 2, y: 2, width: 6, height: 6 },
      },
    },
  };
  const files = await serializeMakerImportBundleV1(input);
  assert.deepEqual(Object.keys(files).sort(), [
    'assets/000001.png',
    'fixture.json',
    MAKER_IMPORT_BUNDLE_MANIFEST,
  ]);
  const parsed = await parseMakerImportBundleV1(files);
  assert.deepEqual(parsed.document, document);
  assert.equal(parsed.manifest.schemaVersion, 1);
  assert.equal(parsed.manifest.assets.length, 1);
  assert.deepEqual(parsed.manifest.bindings, [{
    sourceNodeId: 'image:B',
    assetPath: 'assets/000001.png',
    pixelRatio: 2,
    trimOffset: { x: 1, y: 2 },
    scale9Grid: { x: 2, y: 2, width: 6, height: 6 },
  }, {
    sourceNodeId: 'image:a',
    assetPath: 'assets/000001.png',
    pixelRatio: 1,
    trimOffset: { x: 0, y: 0 },
    scale9Grid: null,
  }]);

  const repeated = await serializeMakerImportBundleV1(input);
  for (const path of Object.keys(files)) assert.deepEqual(repeated[path], files[path], path);

  const tampered = { ...files, 'assets/000001.png': Uint8Array.from([...bytes, 0]) };
  await assert.rejects(parseMakerImportBundleV1(tampered), /declared byteLength and SHA-256/);
  const unsupportedManifest = JSON.parse(new TextDecoder().decode(files[MAKER_IMPORT_BUNDLE_MANIFEST])) as {
    schemaVersion: number;
  };
  unsupportedManifest.schemaVersion = 2;
  await assert.rejects(parseMakerImportBundleV1({
    ...files,
    [MAKER_IMPORT_BUNDLE_MANIFEST]: new TextEncoder().encode(JSON.stringify(unsupportedManifest)),
  }), /schemaVersion must be 1/);
  await assert.rejects(parseMakerImportBundleV1({ ...files, 'extra.txt': new Uint8Array([1]) }), /unexpected path/);
  await assert.rejects(serializeMakerImportBundleV1({
    ...input,
    assetBindings: { missing: {} },
  }), /existing ImportImage node ID/);
  await assert.rejects(serializeMakerImportBundleV1({
    ...input,
    assetBindings: { 'image:a': { scale9Grid: { x: 9, y: 0, width: 2, height: 2 } } },
  }), /inside source node image:a bounds/);

  let nested: ImportFrame = {
    kind: 'frame',
    ...common('depth:leaf', 0),
    sourceType: 'frame',
    variantProperties: {},
    layout: null,
    clipContent: false,
    backgroundColor: null,
    children: [],
  };
  for (let depth = 0; depth < 101; depth += 1) {
    nested = { ...nested, id: 'depth:' + depth, children: [nested] };
  }
  await assert.rejects(serializeMakerImportBundleV1({
    source: input.source,
    document: { name: 'Too deep', diagnostics: [], pages: [{ id: 'page', name: 'Page', roots: [nested] }] },
  }), /node tree no deeper than 100/);
});
