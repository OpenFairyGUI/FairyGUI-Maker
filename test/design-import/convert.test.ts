import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GraphType, GroupLayoutType, ProjectWriter, RelationType } from '@openfairygui/core';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import {
  compilePlanToUam,
  convertDocument,
  IMPORT_FIXTURE_DOCUMENT,
  parseImportFixture,
  planDocument,
  safeName,
  serializeImportFixture,
  MemoryFileSystem,
  type ConversionImageBinding,
  type FairyBuildPlanV2,
  type ImportDocument,
  type ImportFrame,
  type ImportInstanceOverride,
  type ImportNode,
  type ImportShape,
} from '../../src/design-import';

const document: ImportDocument = {
  name: 'Demo',
  diagnostics: [],
  pages: [{
    id: 'page:1',
    name: 'Main',
    roots: [{
      kind: 'frame',
      id: '1:1',
      name: 'MainView',
      x: 0,
      y: 0,
      width: 320,
      height: 180,
      visible: true,
      opacity: 1,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      mask: false,
      constraints: null,
      layoutChild: true,
      sourceType: 'frame',
      variantProperties: {},
      layout: null,
      clipContent: false,
      backgroundColor: null,
      children: [{
        kind: 'image',
        format: 'png',
        id: '1:2',
        name: 'Icon',
        x: 16,
        y: 16,
        width: 2,
        height: 2,
        visible: true,
        opacity: 1,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        mask: false,
        constraints: null,
        layoutChild: true,
        bytes: new Uint8Array([137, 80, 78, 71]),
      }, {
        kind: 'shape',
        id: '1:3',
        name: 'Triangle',
        x: 32,
        y: 16,
        width: 20,
        height: 20,
        visible: true,
        opacity: 1,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        mask: false,
        constraints: null,
        layoutChild: true,
        shape: 'polygon',
        fillColor: '#ffffff',
        strokeColor: null,
        strokeWidth: 0,
        cornerRadius: null,
        points: [10, 0, 20, 20, 0, 20],
        shadows: [],
      }],
    }],
  }],
};

test('converts an ImportDocument and writes a readable FairyGUI project', async () => {
  assert.equal(safeName('CON'), '_CON');
  const files = serializeImportFixture(document);
  assert.deepEqual(parseImportFixture(files), document);
  assert.deepEqual(Object.keys(files).sort(), ['assets/000001.png', 'fixture.json']);
  const fixture = JSON.parse(new TextDecoder().decode(files[IMPORT_FIXTURE_DOCUMENT])) as {
    name: string;
    pages: Array<{ roots: Array<{ children: Array<{ asset: string }> }> }>;
  };
  assert.equal(fixture.name, 'Demo');
  assert.equal(fixture.pages[0].roots[0].children[0].asset, 'assets/000001.png');
  const svgDocument = structuredClone(document);
  const svgImage = svgDocument.pages[0].roots[0].children[0];
  assert.ok(svgImage.kind === 'image');
  svgImage.format = 'svg';
  svgImage.bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
  const svgFiles = serializeImportFixture(svgDocument);
  assert.deepEqual(Object.keys(svgFiles).sort(), ['assets/000001.svg', 'fixture.json']);
  assert.deepEqual(parseImportFixture(svgFiles), svgDocument);
  const missingDocument = { ...files };
  delete missingDocument[IMPORT_FIXTURE_DOCUMENT];
  assert.throws(
    () => parseImportFixture(missingDocument),
    /fixture\.json is missing/,
  );
  assert.throws(
    () => parseImportFixture({
      [IMPORT_FIXTURE_DOCUMENT]: files[IMPORT_FIXTURE_DOCUMENT],
    }),
    /existing non-empty asset/,
  );
  assert.throws(
    () => parseImportFixture({ [IMPORT_FIXTURE_DOCUMENT]: new Uint8Array([0xff]) }),
    /Invalid fixture\.json/,
  );
  const converted = convertDocument(document);
  assert.deepEqual(converted.report, {
    sourceName: 'Demo',
    pages: 1,
    roots: 1,
    nodes: 3,
    frames: 1,
    editableText: 0,
    editableShapes: 1,
    editableInstances: 0,
    variantSets: 0,
    rasterizedNodes: 0,
    imageBytes: 4,
    diagnostics: {},
    diagnosticGroups: [],
    diagnosticDetails: [],
    ids: { reused: 0, added: 6, changed: 0, removed: 0 },
  });
  const repeated = convertDocument(document, converted.ids);
  assert.deepEqual(repeated.report.ids, { reused: 6, added: 0, changed: 0, removed: 0 });
  assert.equal(repeated.project.projectId, converted.project.projectId);

  const directory = await mkdtemp(join(tmpdir(), 'fairygui-maker-import-'));
  try {
    const path = join(directory, 'Demo.fairy');
    const io = new NodeIO();
    await writeProjectFromUam(io, converted.project, path);
    const reloaded = await readProjectAsUam(io, path, { hydrateResourceBytes: true });
    assert.equal(reloaded.packages[0].resources.length, 2);
    const component = reloaded.packages[0].resources.find((resource) => resource.kind === 'component');
    const graph = component?.kind === 'component'
      ? component.component.displayList.find((node) => node.kind === 'graph')
      : undefined;
    assert.ok(graph?.kind === 'graph');
    assert.equal(graph.graphType, GraphType.Polygon);
    assert.deepEqual(graph.points, [10, 0, 20, 20, 0, 20]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plans selected roots with their component dependencies and preserves legacy compilation', () => {
  const base = (id: string, name: string) => ({
    id, name, x: 0, y: 0, width: 100, height: 40, visible: true, opacity: 1,
    rotation: 0, scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true,
  });
  const frame = (id: string, children: ImportNode[] = [], sourceType: ImportFrame['sourceType'] = 'component'): ImportFrame => ({
    kind: 'frame', ...base(id, id), sourceType, variantProperties: {}, layout: null,
    clipContent: false, backgroundColor: null, children,
  });
  const source: ImportDocument = {
    name: 'Selection',
    diagnostics: [
      { code: 'DEPENDENCY', message: 'kept', nodeId: 'dependency', severity: 'warning' },
      { code: 'OMITTED', message: 'removed', nodeId: 'omitted', severity: 'warning' },
    ],
    pages: [{
      id: 'page',
      name: 'Page',
      roots: [
        frame('dependency'),
        frame('omitted'),
        frame('screen', [{
          kind: 'instance',
          ...base('instance', 'Instance'),
          componentId: 'dependency',
          overrides: [],
        }], 'frame'),
      ],
    }],
  };

  const plan = planDocument(source, { rootIds: ['screen'] });
  assert.deepEqual(plan.packages[0].components.map(({ sourceNodeId, exported }) => ({ sourceNodeId, exported })), [
    { sourceNodeId: 'dependency', exported: false },
    { sourceNodeId: 'screen', exported: true },
  ]);
  assert.deepEqual(plan.diagnostics.map(({ code }) => code), ['DEPENDENCY']);
  assert.throws(() => planDocument(source, { rootIds: ['missing'] }), /root does not exist/);

  const selected = compilePlanToUam(source, structuredClone(plan));
  const dependency = selected.project.packages[0].resources.find(
    (resource) => resource.id === selected.ids['dependency:resource'],
  );
  const screen = selected.project.packages[0].resources.find(
    (resource) => resource.id === selected.ids['screen:resource'],
  );
  assert.equal(dependency?.path, '/_internal/');
  assert.equal(screen?.path, '/');
  assert.equal(selected.ids['omitted:resource'], undefined);

  const first = convertDocument(source);
  const expected = convertDocument(source, first.ids);
  const throughPlan = compilePlanToUam(source, planDocument(source), first.ids);
  assert.deepEqual(throughPlan, expected);

  const omittedDependency = structuredClone(plan);
  omittedDependency.packages[0].components = omittedDependency.packages[0].components.filter(({ exported }) => exported);
  assert.throws(() => compilePlanToUam(source, omittedDependency), /PLAN_COMPONENT_DEPENDENCY_MISSING/);
  const missing = structuredClone(source);
  const instance = missing.pages[0].roots[2].children[0];
  assert.ok(instance.kind === 'instance');
  instance.componentId = 'missing-component';
  const missingPlan = planDocument(missing, { rootIds: ['screen'] });
  assert.ok(missingPlan.diagnostics.some(({ code, severity }) => code === 'PLAN_COMPONENT_DEPENDENCY_MISSING' && severity === 'error'));
  missingPlan.diagnostics = [];
  assert.throws(() => compilePlanToUam(missing, missingPlan), /PLAN_COMPONENT_DEPENDENCY_MISSING/);

  const ignored = structuredClone(plan);
  ignored.semanticOverlay.nodes.dependency = { target: 'ignore' };
  assert.throws(() => compilePlanToUam(source, ignored), /PLAN_COMPONENT_DEPENDENCY_MISSING/);
});

test('fresh builds have stable IDs and project bytes, with collision-safe State v2 reuse', async () => {
  const original = structuredClone(document);
  const first = convertDocument(document);
  assert.deepEqual(convertDocument(document), first);
  assert.deepEqual(document, original);
  assert.ok(Object.values(first.ids).every((id) => /^[a-z0-9]{8}$/.test(id)));
  assert.equal(new Set(Object.values(first.ids)).size, Object.keys(first.ids).length);

  const files = new MemoryFileSystem();
  const repeatedFiles = new MemoryFileSystem();
  await writeProjectFromUam({ writeProject: (...args) => new ProjectWriter(files).write(...args) }, first.project, '/Demo.fairy');
  await writeProjectFromUam({ writeProject: (...args) => new ProjectWriter(repeatedFiles).write(...args) },
    convertDocument(structuredClone(document)).project, '/Demo.fairy');
  assert.deepEqual(repeatedFiles.toZipEntries('Demo'), files.toZipEntries('Demo'));

  // The package is visited first, but cannot take an existing project's ID.
  const previous = { $project: first.ids.$package, 'removed:node': first.ids.$project };
  const collision = convertDocument(document, previous);
  assert.equal(collision.ids.$project, previous.$project);
  assert.notEqual(collision.ids.$package, first.ids.$package);
  assert.ok(!Object.values(collision.ids).includes(previous['removed:node']));
  assert.deepEqual(convertDocument(document, previous), collision);
  assert.deepEqual(convertDocument(document, collision.ids).project, collision.project);
  assert.deepEqual(previous, { $project: first.ids.$package, 'removed:node': first.ids.$project });

  const legacyIds = Object.fromEntries(Object.keys(first.ids).map((key, index) => [key, index.toString(36).padStart(8, '0')]));
  assert.deepEqual(convertDocument(document, legacyIds).ids, legacyIds);
  const changed = structuredClone(document);
  changed.pages[0].roots[0].width += 10;
  assert.deepEqual(convertDocument(changed).ids, first.ids);
  changed.name += ' another document';
  assert.notEqual(convertDocument(changed).project.projectId, first.project.projectId);
});

test('BuildPlan v2 binds source bytes and image bindings and rejects untrusted plans', () => {
  const source = structuredClone(document);
  source.diagnostics.push({ code: 'SOURCE_WARNING', severity: 'warning', message: 'Original evidence', nodeId: '1:2' });
  source.diagnostics.push({ code: 'DOCUMENT_WARNING', severity: 'error', message: 'Global evidence', nodeId: '' });
  const binding: ConversionImageBinding = {
    pixelRatio: 1, trimOffset: { x: 0, y: 0 }, pixelSize: { width: 2, height: 2 }, scale9Grid: null,
  };
  const imageBindings = { '1:2': binding };
  const plan = planDocument(source, { imageBindings });
  assert.equal(plan.schemaVersion, 2);
  assert.match(plan.sourceDigest, /^[a-f0-9]{64}$/);
  const originalPlan = structuredClone(plan);
  const originalSource = structuredClone(source);
  const originalBindings = structuredClone(imageBindings);
  const expected = compilePlanToUam(source, plan, {}, imageBindings);
  assert.deepEqual(plan, originalPlan);
  assert.deepEqual(source, originalSource);
  assert.deepEqual(imageBindings, originalBindings);

  const alteredDiagnostics = structuredClone(plan);
  alteredDiagnostics.diagnostics[0].message = 'Forged evidence';
  assert.deepEqual(source, originalSource);
  assert.deepEqual(compilePlanToUam(source, alteredDiagnostics, {}, imageBindings), expected);
  alteredDiagnostics.diagnostics = [];
  assert.deepEqual(compilePlanToUam(source, alteredDiagnostics, {}, imageBindings), expected);
  alteredDiagnostics.semanticOverlay.nodes['1:1'] = { target: 'rasterize' };
  assert.ok(compilePlanToUam(source, alteredDiagnostics, {}, imageBindings).diagnostics
    .some(({ code }) => code === 'SEMANTIC_RASTERIZE_UNAVAILABLE'));

  const reordered: ImportDocument = { pages: source.pages, diagnostics: source.diagnostics, name: source.name };
  reordered.diagnostics = source.diagnostics.map((diagnostic) => Object.fromEntries(Object.entries(diagnostic).reverse()) as typeof diagnostic);
  assert.equal(planDocument(reordered, { imageBindings }).sourceDigest, plan.sourceDigest);
  assert.equal(JSON.stringify(planDocument(reordered, { imageBindings })), JSON.stringify(plan));
  const renamedPlan = structuredClone(plan);
  renamedPlan.sourceName = 'Renamed';
  renamedPlan.packages[0].name = 'Renamed package';
  renamedPlan.packages[0].components[0].name = 'Renamed component';
  assert.deepEqual(compilePlanToUam(source, renamedPlan, {}, imageBindings).ids, expected.ids);
  assert.throws(() => compilePlanToUam(source, plan), /source digest mismatch/);
  assert.throws(() => compilePlanToUam(source, plan, {}, { '1:2': { ...binding, pixelRatio: 2 } }), /source digest mismatch/);
  assert.throws(() => planDocument(source, { imageBindings: { missing: binding } }), /missing image node/);
  assert.throws(() => planDocument(source, { imageBindings: { '1:2': { ...binding, pixelRatio: 0 } } }));
  for (const mutate of [
    (value: ImportDocument) => { value.pages[0].roots[0].width += 1; },
    (value: ImportDocument) => { (value.pages[0].roots[0].children[0] as Extract<ImportNode, { kind: 'image' }>).bytes[0] ^= 1; },
    (value: ImportDocument) => { value.diagnostics[0].message += ' changed'; },
  ]) {
    const changed = structuredClone(source);
    mutate(changed);
    assert.throws(() => compilePlanToUam(changed, plan, {}, imageBindings), /source digest mismatch/);
  }
  for (const mutate of [
    (value: FairyBuildPlanV2) => { (value as { schemaVersion: number }).schemaVersion = 1; },
    (value: FairyBuildPlanV2) => { (value as { plannerVersion: string }).plannerVersion = 'future'; },
    (value: FairyBuildPlanV2) => { (value as { compilerVersion: string }).compilerVersion = 'future'; },
    (value: FairyBuildPlanV2) => { (value as { sourceSchemaVersion: number }).sourceSchemaVersion = 100; },
    (value: FairyBuildPlanV2) => { value.packages[0].key = '$project'; },
    (value: FairyBuildPlanV2) => { value.packages[0].components[0].key = '$package'; },
    (value: FairyBuildPlanV2) => { value.packages.push(structuredClone(value.packages[0])); },
    (value: FairyBuildPlanV2) => { value.packages[0].components.push(structuredClone(value.packages[0].components[0])); },
    (value: FairyBuildPlanV2) => { value.semanticOverlay.nodes['1:2'] = { target: 'button' }; },
    (value: FairyBuildPlanV2) => { Object.assign(value, { unexpected: true }); },
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => compilePlanToUam(source, changed, {}, imageBindings));
  }
  const duplicate = structuredClone(source);
  duplicate.pages[0].roots[0].children[1].id = '1:2';
  assert.throws(() => planDocument(duplicate), /duplicate node ID/);
  const keyCollision = structuredClone(document);
  keyCollision.pages[0].id = 'root:resource';
  keyCollision.pages[0].roots[0].id = '$package:root';
  keyCollision.pages.push({ id: 'second', name: 'Second', roots: [] });
  assert.throws(() => convertDocument(keyCollision), /key namespace collision/);
});

test('keeps original resource names and suffixes only collisions', async () => {
  const duplicate = structuredClone(document);
  const firstRoot = duplicate.pages[0].roots[0];
  firstRoot.name = 'Panel';
  const firstImage = firstRoot.children[0];
  assert.ok(firstImage.kind === 'image');
  const secondImage = structuredClone(firstImage);
  secondImage.id = '1:4';
  secondImage.name = 'icon';
  secondImage.bytes = new Uint8Array([...secondImage.bytes, 0]);
  firstRoot.children.push(secondImage);
  const secondRoot = structuredClone(firstRoot);
  secondRoot.id = '1:5';
  secondRoot.name = 'panel';
  secondRoot.children = [];
  duplicate.pages[0].roots.push(secondRoot);

  const converted = convertDocument(duplicate);
  assert.deepEqual(converted.project.packages[0].resources.map((resource) => resource.name), [
    'Icon',
    'icon_2',
    'Panel',
    'panel_2',
  ]);
  assert.deepEqual(converted.project.packages[0].resources
    .filter((resource) => resource.kind === 'image')
    .map((resource) => resource.fileName), ['Icon.png', 'icon_2.png']);
  assert.ok(converted.project.packages[0].resources.every((resource) => !resource.name.includes(resource.id)));

  const directory = await mkdtemp(join(tmpdir(), 'fairygui-maker-import-resource-names-'));
  try {
    const path = join(directory, 'Names.fairy');
    const io = new NodeIO();
    await writeProjectFromUam(io, converted.project, path);
    const reloaded = await readProjectAsUam(io, path, { hydrateResourceBytes: true });
    assert.deepEqual(new Set(reloaded.packages[0].resources.map((resource) => resource.name)), new Set([
      'Icon',
      'icon_2',
      'Panel',
      'panel_2',
    ]));
    assert.deepEqual(new Set(reloaded.packages[0].resources
      .filter((resource) => resource.kind === 'image')
      .map((resource) => resource.fileName)), new Set(['Icon.png', 'icon_2.png']));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('deduplicates identical image bytes within a package', () => {
  const duplicate = structuredClone(document);
  const root = duplicate.pages[0].roots[0];
  const first = root.children[0];
  assert.ok(first.kind === 'image');
  const second = structuredClone(first);
  second.id = '1:4';
  second.name = 'Repeated icon';
  second.x = 48;
  root.children.push(second);

  const converted = convertDocument(duplicate);
  const images = converted.project.packages[0].resources.filter((resource) => resource.kind === 'image');
  assert.deepEqual(convertDocument(duplicate), converted);
  assert.deepEqual(convertDocument(duplicate, converted.ids).ids, converted.ids);
  assert.equal(images.length, 1);
  assert.equal(converted.ids['1:2:resource'], converted.ids['1:4:resource']);
  const component = converted.project.packages[0].resources.find((resource) => resource.kind === 'component');
  assert.ok(component?.kind === 'component');
  const references = component.component.displayList.filter((node) => node.kind === 'image');
  assert.equal(references.length, 2);
  assert.equal(references[0].resource.resourceId, references[1].resource.resourceId);
  assert.equal(images[0].path, '/_internal/assets/');
});

test('preserves supported layout, constraints, rich text, shadows, and instance overrides', () => {
  const semantic: ImportDocument = {
    name: 'Semantic',
    diagnostics: [],
    pages: [{
      id: 'page',
      name: 'Page',
      roots: [{
        kind: 'frame', id: 'component', name: 'Source', x: 0, y: 0, width: 100, height: 20,
        visible: true, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1,
        mask: false, constraints: null, layoutChild: true,
        sourceType: 'component', variantProperties: {}, layout: null, clipContent: false, backgroundColor: null,
        children: [{
          kind: 'text', id: 'label', name: 'Label', x: 0, y: 0, width: 100, height: 20,
          visible: true, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1,
          mask: false, constraints: null, layoutChild: true,
          text: 'Default', fontFamily: 'Arial', fontSize: 12, color: '#ffffff', align: 'left',
          verticalAlign: 'top', lineHeight: null, letterSpacing: 0, autoSize: 'none', singleLine: true, bold: false,
          italic: false, underline: false, strikethrough: false, runs: [], shadow: null,
        }],
      }, {
        kind: 'frame', id: 'root', name: 'Root', x: 0, y: 0, width: 200, height: 40,
        visible: true, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1,
        mask: false, constraints: null, layoutChild: true,
        sourceType: 'frame', variantProperties: {}, layout: { mode: 'horizontal', gap: 8 },
        clipContent: false, backgroundColor: null, children: [{
          kind: 'text', id: 'mixed', name: 'Mixed', x: 0, y: 0, width: 40, height: 20,
          visible: true, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, mask: false,
          constraints: { horizontal: 'stretch', vertical: 'center' }, layoutChild: true,
          text: 'AB', fontFamily: 'Arial', fontSize: 12, color: '#ffffff', align: 'left',
          verticalAlign: 'top', lineHeight: null, letterSpacing: 0, autoSize: 'none', singleLine: false, bold: false,
          italic: false, underline: false, strikethrough: false, shadow: { color: '#80000000', offsetX: 1, offsetY: 2 },
          runs: [
            { start: 0, end: 1, fontFamily: 'Arial', fontSize: 12, color: '#ffffff', bold: false, italic: false, underline: false, strikethrough: false },
            { start: 1, end: 2, fontFamily: 'Arial', fontSize: 12, color: '#ff0000', bold: true, italic: false, underline: false, strikethrough: false },
          ],
        }, {
          kind: 'shape', id: 'box', name: 'Box', x: 48, y: 0, width: 20, height: 20,
          visible: true, opacity: 1, rotation: 0, scaleX: -1, scaleY: 1, mask: false,
          constraints: { horizontal: 'scale', vertical: 'max' }, layoutChild: true,
          shape: 'rectangle', fillColor: '#ffffff', strokeColor: null, strokeWidth: 0,
          cornerRadius: null, points: null, shadows: [{ color: '#80000000', offsetX: 2, offsetY: 3 }],
        }, {
          kind: 'instance', id: 'instance', name: 'Source instance', x: 76, y: 0, width: 100, height: 20,
          visible: true, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1,
          mask: false, constraints: null, layoutChild: true,
          componentId: 'component', overrides: [{
            targetId: 'label', targetPath: ['label'], componentId: null,
            name: null, text: 'Override', visible: null, opacity: null,
            width: null, height: null, fillColor: '#00ff00', strokeColor: null, strokeWidth: null,
            cornerRadius: null, fontFamily: null, fontSize: 14, bold: null, italic: null,
            underline: null, strikethrough: null,
          }],
        }],
      }],
    }],
  };
  const converted = convertDocument(semantic);
  assert.deepEqual(convertDocument(semantic), converted);
  const resources = converted.project.packages[0].resources;
  const root = resources.find((resource) => resource.id === converted.ids['root:resource']);
  assert.ok(root?.kind === 'component');
  assert.equal(root.name, 'Root');
  const group = root.component.displayList.find((node) => node.kind === 'group');
  assert.ok(group?.kind === 'group');
  assert.equal(group.layout, GroupLayoutType.Horizontal);
  assert.equal(group.columnGap, 8);
  const mixed = root.component.displayList.find((node) => node.id === converted.ids['mixed:node']);
  assert.ok(mixed?.kind === 'richText');
  assert.match(mixed.text, /\[color=#ff0000\]\[b\]B\[\/b\]\[\/color\]/);
  assert.equal(mixed.shadowColor, '#80000000');
  assert.ok(mixed.relations.some((relation) => relation.type === RelationType.Right_Right));
  assert.equal(mixed.group, group.id);
  const shadow = root.component.displayList.find((node) => node.name === 'Box shadow');
  assert.ok(shadow?.kind === 'graph');
  assert.equal(shadow.position.x, 50);
  const box = root.component.displayList.find((node) => node.name === 'Box');
  assert.equal(box?.scale.x, -1);
  const instance = root.component.displayList.find((node) => node.id === converted.ids['instance:node']);
  assert.ok(instance?.kind === 'component');
  const clone = resources.find((resource) => resource.id === instance.resource.resourceId);
  assert.ok(clone?.kind === 'component');
  assert.equal(clone.name, 'Source instance');
  const label = clone.component.displayList.find((node) => node.id === converted.ids['label:node']);
  assert.ok(label?.kind === 'text');
  assert.equal(label.text, 'Override');
  assert.equal(label.color, '#00ff00');
  assert.equal(label.fontSize, 14);
  assert.equal(label.singleLine, true);
});

test('applies nested overrides by cloning only the referenced component path', () => {
  const common = (id: string, name: string) => ({
    id, name, x: 0, y: 0, width: 100, height: 20, visible: true, opacity: 1, rotation: 0,
    scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true,
  });
  const text = (id: string, value: string): Extract<ImportNode, { kind: 'text' }> => ({
    kind: 'text', ...common(id, id), text: value, fontFamily: 'Arial', fontSize: 12,
    color: '#ffffff', align: 'left', verticalAlign: 'top', lineHeight: null, letterSpacing: 0,
    autoSize: 'none', singleLine: false, bold: false, italic: false, underline: false, strikethrough: false,
    runs: [], shadow: null,
  });
  const frame = (id: string, children: ImportNode[]): ImportFrame => ({
    kind: 'frame', ...common(id, id), sourceType: 'component', variantProperties: {}, layout: null,
    clipContent: false, backgroundColor: null, children,
  });
  const instance = (
    id: string,
    componentId: string,
    overrides: Extract<ImportNode, { kind: 'instance' }>['overrides'] = [],
  ): Extract<ImportNode, { kind: 'instance' }> => ({
    kind: 'instance', ...common(id, id), componentId, overrides,
  });
  const override = (targetPath: string[], values: Partial<ImportInstanceOverride>): ImportInstanceOverride => ({
    targetId: targetPath.at(-1)!, targetPath, componentId: null, name: null, text: null,
    visible: null, opacity: null, width: null, height: null, fillColor: null, strokeColor: null,
    strokeWidth: null, cornerRadius: null, fontFamily: null, fontSize: null, bold: null,
    italic: null, underline: null, strikethrough: null, ...values,
  });
  const nested: ImportDocument = {
    name: 'Nested overrides', diagnostics: [], pages: [{ id: 'page', name: 'Page', roots: [
      frame('leaf', [text('label', 'Default')]),
      frame('replacement', [text('replacement-label', 'Replacement')]),
      frame('outer', [instance('nested-instance', 'leaf')]),
      {
        kind: 'frame', ...common('root', 'Root'), sourceType: 'frame', variantProperties: {}, layout: null,
        clipContent: false, backgroundColor: null, children: [
          instance('text-instance', 'outer', [override(['nested-instance', 'label'], { text: 'Nested value' })]),
          instance('swap-instance', 'outer', [override(['nested-instance'], { componentId: 'replacement' })]),
        ],
      },
    ] }],
  };

  const converted = convertDocument(nested);
  assert.deepEqual(convertDocument(nested), converted);
  assert.deepEqual(convertDocument(nested, converted.ids).project, converted.project);
  const resources = converted.project.packages[0].resources;
  const root = resources.find((resource) => resource.id === converted.ids['root:resource']);
  assert.ok(root?.kind === 'component');
  const textInstance = root.component.displayList.find((node) => node.id === converted.ids['text-instance:node']);
  assert.ok(textInstance?.kind === 'component');
  const textClone = resources.find((resource) => resource.id === textInstance.resource.resourceId);
  assert.ok(textClone?.kind === 'component');
  const nestedCloneRef = textClone.component.displayList.find((node) => node.id === converted.ids['nested-instance:node']);
  assert.ok(nestedCloneRef?.kind === 'component');
  const leafClone = resources.find((resource) => resource.id === nestedCloneRef.resource.resourceId);
  assert.ok(leafClone?.kind === 'component');
  const label = leafClone.component.displayList.find((node) => node.id === converted.ids['label:node']);
  assert.ok(label?.kind === 'text');
  assert.equal(label.text, 'Nested value');

  const swapInstance = root.component.displayList.find((node) => node.id === converted.ids['swap-instance:node']);
  assert.ok(swapInstance?.kind === 'component');
  const swapClone = resources.find((resource) => resource.id === swapInstance.resource.resourceId);
  assert.ok(swapClone?.kind === 'component');
  const swapped = swapClone.component.displayList.find((node) => node.id === converted.ids['nested-instance:node']);
  assert.ok(swapped?.kind === 'component');
  assert.equal(swapped.resource.resourceId, converted.ids['replacement:resource']);
});

test('keeps variant controller page names safe for FairyGUI serialization', async () => {
  const common = (id: string, name: string) => ({
    id, name, x: 0, y: 0, width: 100, height: 20, visible: true, opacity: 1, rotation: 0,
    scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true,
  });
  const variant = (id: string, state: string): ImportFrame => ({
    kind: 'frame', ...common(id, state), sourceType: 'component',
    variantProperties: { State: state, Size: 'Large' }, layout: null,
    clipContent: false, backgroundColor: null, children: [],
  });
  const variants: ImportDocument = {
    name: 'Variants', diagnostics: [], pages: [{ id: 'page', name: 'Page', roots: [{
      kind: 'frame', ...common('set', 'Button'), sourceType: 'componentSet', variantProperties: {},
      layout: null, clipContent: false, backgroundColor: null,
      children: [variant('idle', 'Idle,Primary'), variant('pressed', 'Pressed')],
    }] }],
  };
  const converted = convertDocument(variants);
  assert.deepEqual(convertDocument(variants), converted);
  const set = converted.project.packages[0].resources.find(
    (resource) => resource.id === converted.ids['set:resource'],
  );
  assert.ok(set?.kind === 'component');
  assert.equal(set.path, '/');
  assert.deepEqual(converted.project.packages[0].resources
    .filter((resource) => resource.id === converted.ids['idle:resource'] || resource.id === converted.ids['pressed:resource'])
    .map((resource) => resource.path), ['/_variants/Button/', '/_variants/Button/']);
  assert.deepEqual(set.component.controllers[0].pages.map((page) => page.name), [
    'Size=Large · State=Idle，Primary',
    'Size=Large · State=Pressed',
  ]);

  const directory = await mkdtemp(join(tmpdir(), 'fairygui-maker-import-variants-'));
  try {
    const path = join(directory, 'Variants.fairy');
    const io = new NodeIO();
    await writeProjectFromUam(io, converted.project, path);
    const reloaded = await readProjectAsUam(io, path);
    const reloadedSet = reloaded.packages[0].resources.find((resource) => resource.id === set.id);
    assert.ok(reloadedSet?.kind === 'component');
    assert.equal(reloadedSet.component.controllers[0].pages.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('flattens safe source groups with rebased nested coordinates and keeps unsafe groups as components', () => {
  const common = (id: string, name: string, x: number, y: number, width: number, height: number) => ({
    id, name, x, y, width, height, visible: true, opacity: 1, rotation: 0,
    scaleX: 1, scaleY: 1, mask: false,
    constraints: null, layoutChild: true,
  });
  const shape = (id: string, x: number, y: number): ImportShape => ({
    kind: 'shape', ...common(id, id, x, y, 10, 10), shape: 'rectangle', fillColor: '#ffffff',
    strokeColor: null, strokeWidth: 0, cornerRadius: null, points: null, shadows: [],
  });
  const frame = (
    id: string,
    x: number,
    y: number,
    children: ImportNode[],
    sourceType: ImportFrame['sourceType'] = 'group',
    flattenable = true,
  ): ImportFrame => ({
    kind: 'frame', ...common(id, id, x, y, 100, 80), sourceType,
    ...(sourceType === 'group' ? { flattenable } : {}),
    variantProperties: {}, layout: null, clipContent: false, backgroundColor: null, children,
  });
  const grouped: ImportDocument = {
    name: 'Groups',
    diagnostics: [],
    pages: [{
      id: 'page',
      name: 'Page',
      roots: [frame('root', 0, 0, [
        frame('outer', 10, 20, [
          shape('outer-shape', 3, 4),
          frame('inner', 30, 40, [shape('inner-shape', 1, 2)]),
        ]),
        frame('unsafe', 120, 20, [shape('unsafe-shape', 0, 0)], 'group', false),
      ], 'frame')],
    }],
  };

  const converted = convertDocument(grouped);
  const resources = converted.project.packages[0].resources;
  const root = resources.find((resource) => resource.id === converted.ids['root:resource']);
  assert.ok(root?.kind === 'component');
  const display = root.component.displayList;
  const outer = display.find((node) => node.id === converted.ids['outer:node']);
  const inner = display.find((node) => node.id === converted.ids['inner:node']);
  const outerShape = display.find((node) => node.id === converted.ids['outer-shape:node']);
  const innerShape = display.find((node) => node.id === converted.ids['inner-shape:node']);
  assert.ok(outer?.kind === 'group');
  assert.ok(inner?.kind === 'group');
  assert.deepEqual(outer.position, { x: 10, y: 20 });
  assert.deepEqual(inner.position, { x: 40, y: 60 });
  assert.deepEqual(outerShape?.position, { x: 13, y: 24 });
  assert.deepEqual(innerShape?.position, { x: 41, y: 62 });
  assert.equal(outerShape && 'group' in outerShape ? outerShape.group : undefined, outer.id);
  assert.equal(inner.group, outer.id);
  assert.equal(innerShape && 'group' in innerShape ? innerShape.group : undefined, inner.id);
  const unsafe = display.find((node) => node.id === converted.ids['unsafe:node']);
  assert.ok(unsafe?.kind === 'component');
  assert.ok(resources.some((resource) => resource.id === converted.ids['unsafe:resource']));
  assert.equal(resources.some((resource) => resource.id === converted.ids['outer:resource']), false);
  assert.equal(resources.some((resource) => resource.id === converted.ids['inner:resource']), false);
});
