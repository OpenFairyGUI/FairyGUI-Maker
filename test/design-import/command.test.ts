import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import { Resvg } from '@resvg/resvg-js';

import {
  makerImportSha256,
  MAKER_IMPORT_GENERATED_SNAPSHOT,
  serializeMakerImportBundleV1,
  type ImportDocument,
} from '../../src/design-import';
import { importDesignSource, MAKER_IMPORT_STATE, planProjectReimport } from '../../src/design-import/node';

const fixtureRoot = join(process.cwd(), 'test', 'fixtures', 'design-import');

test('imports real FIG and PSD files into new validated projects and refuses overwrite', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fairygui-maker-import-command-'));
  try {
    for (const name of ['basic-shapes.fig', 'artboard.psd']) {
      const sourcePath = join(fixtureRoot, name);
      const outputPath = join(parent, name.replace('.', '-'));
      const result = await importDesignSource({ sourcePath, outputPath });
      assert.equal(result.source.sha256, await makerImportSha256(await readFile(sourcePath)));
      assert.ok(result.report.nodes > 0);
      assert.ok(Object.keys(result.ids).length > 0);
      const project = await readProjectAsUam(new NodeIO(), result.fairyPath, { hydrateResourceBytes: true });
      assert.equal(project.projectId, result.projectId);
      const stateBefore = await readFile(join(outputPath, MAKER_IMPORT_STATE), 'utf8');
      const state = JSON.parse(stateBefore);
      assert.equal(state.schemaVersion, 2);
      assert.equal(state.compiler.compilerVersion, 'deterministic-v1');
      assert.equal(state.compiler.plannerVersion, 'deterministic-v1');
      assert.equal(state.source.path, sourcePath);
      assert.ok(Object.keys(result.ids).every((nodeId) => state.sourceNodes[nodeId]));
      assert.equal(await access(join(outputPath, ...MAKER_IMPORT_GENERATED_SNAPSHOT.split('/'))).then(() => true, () => false), true);
      await assert.rejects(importDesignSource({ sourcePath, outputPath }), /EEXIST/);
      assert.equal(await readFile(join(outputPath, MAKER_IMPORT_STATE), 'utf8'), stateBefore);

      const repeatedPath = `${outputPath}-fresh-process`;
      await promisify(execFile)(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval',
        "import { importDesignSource } from './src/design-import/node.ts'; await importDesignSource({ sourcePath: process.argv[1], outputPath: process.argv[2] });",
        sourcePath, repeatedPath,
      ], { env: { ...process.env, LANG: 'tr_TR.UTF-8', TZ: 'Pacific/Honolulu' } });
      for (const file of await readdir(outputPath, { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        const filePath = join(file.parentPath, file.name);
        const repeatedFilePath = join(repeatedPath, relative(outputPath, filePath));
        assert.deepEqual(await readFile(repeatedFilePath), await readFile(filePath), `Fresh build bytes differ: ${filePath}`);
      }
      const before = await planProjectReimport(outputPath);
      // A pre-batch-18 State v2 has no compiler/planner version fields and remains readable.
      delete state.compiler.compilerVersion;
      delete state.compiler.plannerVersion;
      await writeFile(join(outputPath, MAKER_IMPORT_STATE), JSON.stringify(state));
      assert.deepEqual(await planProjectReimport(outputPath), before);
      state.compiler.compilerVersion = 'future';
      await writeFile(join(outputPath, MAKER_IMPORT_STATE), JSON.stringify(state));
      await assert.rejects(planProjectReimport(outputPath), /Planner\/Compiler version/);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('plans source-aware reimport without writing the target project', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fairygui-maker-reimport-command-'));
  const bundlePath = join(parent, 'bundle');
  const outputPath = join(parent, 'output');
  const common = {
    visible: true,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    mask: false,
    constraints: null,
    layoutChild: true,
  } as const;
  const text = (id: string, value: string, x: number): ImportDocument['pages'][number]['roots'][number]['children'][number] => ({
    kind: 'text',
    ...common,
    id,
    name: id,
    x,
    y: 0,
    width: 100,
    height: 30,
    text: value,
    fontFamily: 'Arial',
    fontSize: 16,
    color: '#FFFFFF',
    align: 'left',
    verticalAlign: 'top',
    lineHeight: null,
    letterSpacing: 0,
    autoSize: 'none',
    singleLine: true,
    bold: false,
    italic: false,
    underline: false,
    strikethrough: false,
    runs: [],
    shadow: null,
  });
  const document = (children: ImportDocument['pages'][number]['roots'][number]['children']): ImportDocument => ({
    name: 'ReimportFixture',
    diagnostics: [],
    pages: [{
      id: 'page',
      name: 'Page',
      roots: [{
        kind: 'frame',
        ...common,
        id: 'root',
        name: 'Root',
        x: 0,
        y: 0,
        width: 700,
        height: 100,
        sourceType: 'frame',
        variantProperties: {},
        layout: null,
        clipContent: false,
        backgroundColor: null,
        children,
      }],
    }],
  });
  const writeBundle = async (value: ImportDocument): Promise<void> => {
    const sourceBytes = new TextEncoder().encode(JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? [...item] : item));
    const files = await serializeMakerImportBundleV1({
      source: { kind: 'raster', name: 'reimport.json', sha256: await makerImportSha256(sourceBytes) },
      document: value,
    });
    for (const [filePath, bytes] of Object.entries(files)) {
      const target = join(bundlePath, ...filePath.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  };

  try {
    const original = document([
      text('preserved', 'Preserved', 0),
      text('changed', 'Before', 100),
      text('removed', 'Removed', 200),
      text('conflict', 'Before', 300),
      text('removed-user', 'Removed with user data', 400),
      text('changed-user-safe', 'Before', 500),
    ]);
    await writeBundle(original);
    const imported = await importDesignSource({ sourcePath: bundlePath, outputPath });
    const io = new NodeIO();
    const userProject = await readProjectAsUam(io, imported.fairyPath, { hydrateResourceBytes: true });
    const component = userProject.packages[0].resources.find((resource) => resource.kind === 'component');
    assert.ok(component?.kind === 'component');
    component.component.displayList.find(({ name }) => name === 'preserved')!.position.x += 1;
    const conflictNode = component.component.displayList.find(({ name }) => name === 'conflict');
    assert.ok(conflictNode?.kind === 'text');
    conflictNode.text = 'User edit';
    component.component.displayList.find(({ name }) => name === 'removed-user')!.customData = 'keep me';
    component.component.displayList.find(({ name }) => name === 'changed-user-safe')!.position.x += 1;
    await writeProjectFromUam(io, userProject, imported.fairyPath);
    const projectBefore = await readFile(imported.fairyPath);

    await writeBundle(document([
      text('preserved', 'Preserved', 0),
      text('changed', 'After', 100),
      text('conflict', 'After', 300),
      text('changed-user-safe', 'After', 500),
      text('added', 'Added', 600),
    ]));
    const plan = await planProjectReimport(outputPath);
    assert.ok(plan.added.some(({ sourceNodeId }) => sourceNodeId === 'added'));
    assert.ok(plan.changed.some(({ sourceNodeId }) => sourceNodeId === 'changed'));
    assert.ok(plan.changed.some(({ sourceNodeId }) => sourceNodeId === 'changed-user-safe'));
    assert.ok(plan.removed.some(({ sourceNodeId }) => sourceNodeId === 'removed'));
    assert.ok(plan.preserved.some(({ sourceNodeId, reason }) => sourceNodeId === 'preserved' && reason === 'user-change-preserved'));
    assert.ok(plan.conflict.some(({ sourceNodeId }) => sourceNodeId === 'conflict'));
    assert.ok(plan.conflict.some(({ sourceNodeId, reason }) => sourceNodeId === 'removed-user' && reason === 'source-removed-project-changed'));
    assert.deepEqual(await readFile(imported.fairyPath), projectBefore);

    const snapshotPath = join(outputPath, ...MAKER_IMPORT_GENERATED_SNAPSHOT.split('/'));
    const snapshot = await readFile(snapshotPath);
    await writeFile(snapshotPath, Buffer.concat([snapshot, Buffer.from(' ')]));
    await assert.rejects(planProjectReimport(outputPath), /snapshot digest does not match/);
    await writeFile(snapshotPath, snapshot);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('imports a canonical bundle and applies pixel ratio, trim, and scale9 bindings', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'fairygui-maker-bundle-command-'));
  const bundlePath = join(parent, 'bundle');
  const outputPath = join(parent, 'output');
  try {
    const png = new Uint8Array(new Resvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="12"><rect width="16" height="12" fill="#f00"/></svg>',
      { font: { loadSystemFonts: false } },
    ).render().asPng());
    const common = {
      visible: true,
      opacity: 1,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      mask: false,
      constraints: null,
      layoutChild: true,
    } as const;
    const document: ImportDocument = {
      name: 'BundleImport',
      diagnostics: [],
      pages: [{
        id: 'page',
        name: 'Page',
        roots: [{
          kind: 'frame',
          ...common,
          id: 'root',
          name: 'Root',
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          sourceType: 'frame',
          variantProperties: {},
          layout: null,
          clipContent: false,
          backgroundColor: null,
          children: [{
            kind: 'image',
            ...common,
            id: 'image',
            name: 'Image',
            x: 3,
            y: 4,
            width: 10,
            height: 10,
            format: 'png',
            bytes: png,
          }],
        }],
      }],
    };
    const files = await serializeMakerImportBundleV1({
      source: { kind: 'raster', name: 'source.png', sha256: await makerImportSha256(png) },
      document,
      assetBindings: {
        image: {
          pixelRatio: 2,
          trimOffset: { x: 1, y: 2 },
          scale9Grid: { x: 2, y: 3, width: 4, height: 3 },
        },
      },
    });
    for (const [path, bytes] of Object.entries(files)) {
      const target = join(bundlePath, ...path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }

    const result = await importDesignSource({ sourcePath: bundlePath, outputPath });
    const project = await readProjectAsUam(new NodeIO(), result.fairyPath, { hydrateResourceBytes: true });
    const resource = project.packages[0].resources.find((item) => item.kind === 'image');
    assert.ok(resource?.kind === 'image');
    assert.deepEqual(resource.dimensions, { width: 16, height: 12 });
    assert.equal(resource.image.scaleOption, 1);
    assert.deepEqual(resource.image.scale9Grid, [2, 2, 8, 6]);
    const component = project.packages[0].resources.find((item) => item.kind === 'component');
    const image = component?.kind === 'component'
      ? component.component.displayList.find((item) => item.kind === 'image')
      : undefined;
    assert.ok(image?.kind === 'image');
    assert.deepEqual(image.position, { x: 4, y: 6 });
    assert.deepEqual(image.size, { width: 8, height: 6 });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
