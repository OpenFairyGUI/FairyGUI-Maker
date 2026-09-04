import assert from 'node:assert/strict';
import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam } from '@openfairygui/core/uam';

import { ImportDraftError, ImportDraftStore } from '../../src/design-import/draft-store';
import { MAKER_IMPORT_GENERATED_SNAPSHOT } from '../../src/design-import/import-state';

const fixture = path.join(process.cwd(), 'test', 'fixtures', 'design-import', 'basic-shapes.fig');
const exists = (filePath: string) => access(filePath).then(() => true, () => false);

test('import drafts isolate source, compile in Maker data, materialize atomically, and reload', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'fairygui-maker-draft-'));
  const dataDir = path.join(parent, 'data');
  const sourcePath = path.join(parent, 'source.fig');
  const outputPath = path.join(parent, 'output');
  await copyFile(fixture, sourcePath);
  try {
    const store = new ImportDraftStore(dataDir);
    await store.init();
    let draft = await store.create(sourcePath);
    assert.equal(draft.status, 'created');
    assert.equal(draft.revision, 1);
    await writeFile(sourcePath, 'changed after draft creation');

    draft = await store.parse(draft.draftId, draft.revision);
    assert.equal(draft.status, 'parsed');
    assert.ok(draft.source?.sha256);
    assert.ok(draft.diagnostics.length > 0);
    assert.equal(await exists(outputPath), false);
    await assert.rejects(
      store.plan(draft.draftId, 1),
      (error) => error instanceof ImportDraftError && error.status === 409,
    );

    const planned = await store.plan(draft.draftId, draft.revision);
    draft = planned.draft;
    assert.equal(draft.status, 'planned');
    assert.equal(planned.buildPlan.schemaVersion, 1);
    assert.equal(await exists(outputPath), false);

    const resumed = new ImportDraftStore(dataDir);
    await resumed.init();
    draft = await resumed.compile(draft.draftId, draft.revision);
    assert.equal(draft.status, 'compiled');
    assert.equal(await exists(path.join(dataDir, 'import-drafts', draft.draftId, 'generated', 'uam.json')), true);
    assert.equal(await exists(outputPath), false);

    const golden = await readFile(path.join(process.cwd(), 'test', 'fixtures', 'design-import', 'basic-shapes.viewer.png'));
    const width = golden.readUInt32BE(16);
    const height = golden.readUInt32BE(20);
    draft = await resumed.saveVisualEvidence(draft.draftId, draft.revision, {
      schemaVersion: 1,
      packageId: 'package',
      componentId: 'component',
      packageName: 'Basic Shapes',
      componentName: 'Rectangle',
      reference: { width, height },
      capture: { width, height },
      comparison: { width, height, totalPixels: width * height, differentPixels: 0, meanAbsoluteError: 0, maxChannelDelta: 0 },
    }, { reference: golden, capture: golden, diff: golden });
    assert.equal(draft.visualEvidence?.comparison.differentPixels, 0);
    assert.deepEqual(await resumed.readVisualEvidenceImage(draft.draftId, 'capture'), golden);

    const existingTarget = path.join(parent, 'existing');
    await writeFile(existingTarget, 'keep');
    await assert.rejects(
      resumed.materialize(draft.draftId, draft.revision, existingTarget),
      (error) => error instanceof ImportDraftError && error.status === 409,
    );
    assert.equal(await readFile(existingTarget, 'utf8'), 'keep');

    const blockedParent = path.join(parent, 'blocked-parent');
    await writeFile(blockedParent, 'not a directory');
    const failedTarget = path.join(blockedParent, 'output');
    await assert.rejects(resumed.materialize(draft.draftId, draft.revision, failedTarget));
    assert.equal(await exists(failedTarget), false);
    assert.equal(resumed.get(draft.draftId)?.revision, draft.revision);

    const materialized = await resumed.materialize(draft.draftId, draft.revision, outputPath);
    draft = materialized.draft;
    assert.equal(draft.status, 'materialized');
    assert.equal(draft.revision, 6);
    const project = await readProjectAsUam(new NodeIO(), materialized.result.fairyPath, { hydrateResourceBytes: true });
    assert.equal(project.projectId, draft.generated?.projectId);
    const state = JSON.parse(await readFile(materialized.result.statePath, 'utf8'));
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.source.path, sourcePath);
    assert.equal(await exists(path.join(outputPath, ...MAKER_IMPORT_GENERATED_SNAPSHOT.split('/'))), true);

    const reloaded = new ImportDraftStore(dataDir);
    await reloaded.init();
    assert.equal(reloaded.get(draft.draftId)?.status, 'materialized');
    assert.equal(reloaded.get(draft.draftId)?.visualEvidence?.componentName, 'Rectangle');
    assert.equal((await reloaded.getDetail(draft.draftId))?.buildPlan?.schemaVersion, 1);
    await reloaded.delete(draft.draftId, draft.revision);
    assert.equal(reloaded.get(draft.draftId), null);
    assert.equal(await exists(path.join(dataDir, 'import-drafts', draft.draftId)), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('expired import drafts are removed when the store restarts', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'fairygui-maker-draft-expiry-'));
  const dataDir = path.join(parent, 'data');
  try {
    const store = new ImportDraftStore(dataDir);
    await store.init();
    const draft = await store.create(fixture);
    const metadataPath = path.join(dataDir, 'import-drafts', draft.draftId, 'draft.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.expiresAt = '2000-01-01T00:00:00.000Z';
    await writeFile(metadataPath, JSON.stringify(metadata));

    const reloaded = new ImportDraftStore(dataDir);
    await reloaded.init();
    assert.equal(reloaded.get(draft.draftId), null);
    assert.equal(await exists(path.dirname(metadataPath)), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('browser uploads resume from their declared manifest and expose a source outline', async () => {
  const parent = await mkdtemp(path.join(tmpdir(), 'fairygui-maker-draft-upload-'));
  const data = await readFile(fixture);
  try {
    const store = new ImportDraftStore(parent);
    await store.init();
    const uploading = await store.createUpload({
      kind: 'fig',
      name: 'browser.fig',
      files: [{ path: 'browser.fig', size: data.byteLength }],
    });
    assert.equal(uploading.status, 'uploading');

    const resumed = new ImportDraftStore(parent);
    await resumed.init();
    await assert.rejects(resumed.writeUploadFile(uploading.draftId, 'browser.fig', data.subarray(1)));
    await resumed.writeUploadFile(uploading.draftId, 'browser.fig', data);
    await resumed.writeUploadFile(uploading.draftId, 'browser.fig', data);
    let draft = await resumed.completeUpload(uploading.draftId, uploading.revision);
    assert.equal(draft.status, 'created');
    draft = await resumed.parse(draft.draftId, draft.revision);
    const detail = await resumed.getDetail(draft.draftId);
    assert.equal(detail?.outline?.pages.length, 1);
    assert.ok(detail?.outline?.pages[0].roots.length);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
