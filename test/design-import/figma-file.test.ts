import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import {
  convertDocument,
  type ImportNode,
} from '../../src/design-import';
import {
  importFigmaDocument,
  parseFigmaFile,
} from '../../src/design-import/node';
import {
  collectFigmaPageRoots,
  compareFigmaPositions,
  figImageKey,
  inferResizeToFitSize,
  isFigmaMask,
} from '../../src/design-import/figma-file';

const fixture = join(process.cwd(), 'test', 'fixtures', 'design-import', 'basic-shapes.fig');
const thirdPartyFixtures = ['clip-test.fig', 'medium-complex.fig'];

test('orders Figma fractional positions by code point', () => {
  assert.deepEqual(['\'', '&', '%', '$'].sort(compareFigmaPositions), ['$', '%', '&', '\'']);
});

test('reads legacy component sets, component properties, reflection, and safe Auto Layout bounds', () => {
  const guid = (localID: number) => ({ sessionID: 1, localID });
  const parent = (localID: number, position: string) => ({ guid: guid(localID), position });
  const nodes = [
    { guid: guid(0), type: 'DOCUMENT', name: 'Document' },
    { guid: guid(1), type: 'CANVAS', name: 'Page', parentIndex: parent(0, '!') },
    { guid: guid(2), type: 'CANVAS', name: 'Internal Only Canvas', parentIndex: parent(0, '"') },
    { guid: guid(10), type: 'FRAME', name: 'Root', parentIndex: parent(1, '!'), size: { x: 200, y: 100 } },
    {
      guid: guid(11), type: 'INSTANCE', name: 'Configured', parentIndex: parent(10, '$'), size: { x: 100, y: 20 },
      symbolData: { symbolID: guid(30), symbolOverrides: [] },
      componentPropAssignments: [
        { defID: guid(90), value: { textValue: { characters: 'Configured label' } } },
        { defID: guid(91), value: { boolValue: false } },
        { defID: guid(92), value: { guidValue: guid(22) } },
      ],
    },
    {
      guid: guid(12), type: 'ROUNDED_RECTANGLE', name: 'Reflected', parentIndex: parent(10, '%'),
      size: { x: 20, y: 20 }, transform: { m00: -1, m01: 0, m02: 20, m10: 0, m11: 1, m12: 0 },
    },
    {
      guid: guid(13), type: 'FRAME', name: 'Hug layout', parentIndex: parent(10, '&'), size: { x: 100, y: 20 },
      stackMode: 'HORIZONTAL', stackCounterSizing: 'RESIZE_TO_FIT',
    },
    {
      guid: guid(14), type: 'ROUNDED_RECTANGLE', name: 'Anchored child', parentIndex: parent(13, '!'),
      size: { x: 20, y: 20 }, horizontalConstraint: 'MAX',
    },
    {
      guid: guid(20), type: 'FRAME', name: 'Legacy set', parentIndex: parent(2, '!'), size: { x: 100, y: 20 },
      stateGroupPropertyValueOrders: [{ property: 'State', values: ['Off', 'On'] }],
      componentPropDefs: [{ id: guid(99), name: 'State', type: 'VARIANT' }],
    },
    {
      guid: guid(21), type: 'SYMBOL', name: 'State=Off', parentIndex: parent(20, '!'), size: { x: 100, y: 20 },
      variantPropSpecs: [{ propDefId: guid(99), value: 'Off' }],
    },
    {
      guid: guid(22), type: 'SYMBOL', name: 'State=On', parentIndex: parent(20, '"'), size: { x: 100, y: 20 },
      variantPropSpecs: [{ propDefId: guid(99), value: 'On' }],
    },
    {
      guid: guid(30), type: 'SYMBOL', name: 'Configurable', parentIndex: parent(2, '"'), size: { x: 100, y: 20 },
    },
    {
      guid: guid(31), type: 'TEXT', name: 'Label', parentIndex: parent(30, '!'), size: { x: 60, y: 20 },
      textData: { characters: 'Default', lines: [{}] }, fontName: { family: 'Arial', style: 'Regular' }, fontSize: 12,
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
      componentPropRefs: [{ defID: guid(90), componentPropNodeField: 'TEXT_DATA' }],
    },
    {
      guid: guid(32), type: 'ROUNDED_RECTANGLE', name: 'Optional', parentIndex: parent(30, '"'), size: { x: 20, y: 20 },
      componentPropRefs: [{ defID: guid(91), componentPropNodeField: 'VISIBLE' }],
    },
    {
      guid: guid(33), type: 'INSTANCE', name: 'Swappable', parentIndex: parent(30, '#'), size: { x: 20, y: 20 },
      symbolData: { symbolID: guid(21), symbolOverrides: [] },
      componentPropRefs: [{ defID: guid(92), componentPropNodeField: 'OVERRIDDEN_SYMBOL_ID' }],
    },
  ] as Parameters<typeof importFigmaDocument>[0]['nodes'];
  const nodeMap = new Map(nodes.map((node) => [`${node.guid.sessionID}:${node.guid.localID}`, node]));
  const childrenMap = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const owner = node.parentIndex?.guid;
    if (!owner) continue;
    const key = `${owner.sessionID}:${owner.localID}`;
    childrenMap.set(key, [...(childrenMap.get(key) ?? []), node]);
  }
  const imported = importFigmaDocument({
    header: { prelude: 'fig-kiwi', version: 1 }, nodes, nodeMap, childrenMap,
    schema: {}, compiledSchema: {}, rawChunks: [], message: {}, images: new Map(),
  });

  const root = imported.pages.find((page) => page.name === 'Page')!.roots[0];
  assert.deepEqual(root.children.map((node) => node.name), ['Configured', 'Reflected', 'Hug layout']);
  const instance = root.children[0];
  assert.ok(instance.kind === 'instance');
  assert.deepEqual(instance.overrides.map((override) => ({
    targetId: override.targetId,
    text: override.text,
    visible: override.visible,
    componentId: override.componentId,
  })), [
    { targetId: '1:31', text: 'Configured label', visible: null, componentId: null },
    { targetId: '1:32', text: null, visible: false, componentId: null },
    { targetId: '1:33', text: null, visible: null, componentId: '1:22' },
  ]);
  assert.equal(root.children[1].scaleY, -1);
  const layout = root.children[2];
  assert.ok(layout.kind === 'frame');
  assert.equal(layout.layout, null);
  assert.deepEqual(layout.children[0].constraints, { horizontal: 'max', vertical: 'min' });
  assert.ok(imported.diagnostics.some((item) => item.nodeId === '1:13' && item.code === 'AUTO_LAYOUT_BAKED'));

  const components = imported.pages.find((page) => page.name === 'Components')!.roots;
  const configurable = components.find((node) => node.id === '1:30')!;
  const label = configurable.children.find((node) => node.id === '1:31');
  assert.ok(label?.kind === 'text');
  assert.equal(label.singleLine, true);
  const componentSet = components.find((node) => node.id === '1:20')!;
  assert.equal(componentSet.sourceType, 'componentSet');
  assert.deepEqual(componentSet.children.map((node) => node.kind === 'frame' ? node.variantProperties : {}), [
    { State: 'Off' },
    { State: 'On' },
  ]);
});

test('falls back non-square ellipses to SVG when requested', () => {
  const guid = (localID: number) => ({ sessionID: 1, localID });
  const nodes = [
    { guid: guid(0), type: 'DOCUMENT', name: 'Document' },
    { guid: guid(1), type: 'CANVAS', name: 'Page', parentIndex: { guid: guid(0), position: '!' } },
    { guid: guid(2), type: 'FRAME', name: 'Root', parentIndex: { guid: guid(1), position: '!' }, size: { x: 100, y: 50 } },
    {
      guid: guid(3), type: 'ELLIPSE', name: 'Oval', parentIndex: { guid: guid(2), position: '!' },
      size: { x: 40, y: 12 }, fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    },
  ] as Parameters<typeof importFigmaDocument>[0]['nodes'];
  const nodeMap = new Map(nodes.map((node) => [`${node.guid.sessionID}:${node.guid.localID}`, node]));
  const childrenMap = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const owner = node.parentIndex?.guid;
    if (!owner) continue;
    const key = `${owner.sessionID}:${owner.localID}`;
    childrenMap.set(key, [...(childrenMap.get(key) ?? []), node]);
  }
  const imported = importFigmaDocument({
    header: { prelude: 'fig-kiwi', version: 1 }, nodes, nodeMap, childrenMap,
    schema: {}, compiledSchema: {}, rawChunks: [], message: {}, images: new Map(),
  }, 'Oval', 'svg');
  const oval = imported.pages[0].roots[0].children[0];
  assert.ok(oval.kind === 'image');
  assert.match(new TextDecoder().decode(oval.bytes), /<ellipse[^>]+rx="20"[^>]+ry="6"/);
  assert.ok(imported.diagnostics.some((item) => item.code === 'FIG_SHAPE_SVG_FALLBACK' && item.rootName === 'Root'));
});

test('falls back gradient shapes with effects and single-line gradient text to SVG or PNG', () => {
  const guid = (localID: number) => ({ sessionID: 1, localID });
  const parent = (localID: number, position: string) => ({ guid: guid(localID), position });
  const gradient = {
    type: 'GRADIENT_LINEAR',
    stops: [
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } },
    ],
    transform: { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 },
  };
  const nodes = [
    { guid: guid(0), type: 'DOCUMENT', name: 'Document' },
    { guid: guid(1), type: 'CANVAS', name: 'Page', parentIndex: parent(0, '!') },
    { guid: guid(2), type: 'FRAME', name: 'Root', parentIndex: parent(1, '!'), size: { x: 200, y: 100 } },
    {
      guid: guid(3), type: 'ROUNDED_RECTANGLE', name: 'Gradient background', parentIndex: parent(2, '!'),
      size: { x: 200, y: 100 }, cornerRadius: 12, fillPaints: [gradient],
      effects: [{ type: 'DROP_SHADOW', visible: true, radius: 4, offset: { x: 0, y: 4 } }],
    },
    {
      guid: guid(4), type: 'TEXT', name: 'Gradient title', parentIndex: parent(2, '"'), size: { x: 120, y: 48 },
      textData: { characters: 'game', lines: [{}] }, fontName: { family: 'Arial', style: 'Bold' }, fontSize: 40,
      textAutoResize: 'WIDTH_AND_HEIGHT', letterSpacing: { value: 4, units: 'PERCENT' }, fillPaints: [gradient],
    },
  ] as Parameters<typeof importFigmaDocument>[0]['nodes'];
  const document = {
    header: { prelude: 'fig-kiwi', version: 1 }, nodes,
    nodeMap: new Map(nodes.map((node) => [`${node.guid.sessionID}:${node.guid.localID}`, node])),
    childrenMap: new Map([
      ['1:0', [nodes[1]]],
      ['1:1', [nodes[2]]],
      ['1:2', [nodes[3], nodes[4]]],
    ]),
    schema: {}, compiledSchema: {}, rawChunks: [], message: {}, images: new Map(),
  } as Parameters<typeof importFigmaDocument>[0];

  const svg = importFigmaDocument(document, 'Gradient', 'svg');
  assert.deepEqual(svg.pages[0].roots[0].children.map((node) => node.kind), ['image', 'image']);
  const [background, title] = svg.pages[0].roots[0].children;
  assert.ok(background.kind === 'image');
  assert.ok(title.kind === 'image');
  assert.match(new TextDecoder().decode(background.bytes), /<linearGradient[\s\S]+<path[^>]+fill="url\(#gradient1\)"/);
  assert.match(new TextDecoder().decode(title.bytes), /<linearGradient[\s\S]+<text[^>]+font-family="Arial, sans-serif"[^>]+textLength="120"[^>]+>game<\/text>/);
  assert.ok(svg.diagnostics.some((item) => item.nodeId === '1:3' && item.code === 'FIG_EFFECTS_IGNORED'));
  assert.ok(svg.diagnostics.some((item) => item.nodeId === '1:3' && item.code === 'FIG_SHAPE_SVG_FALLBACK'));
  assert.ok(svg.diagnostics.some((item) => item.nodeId === '1:4' && item.code === 'FIG_TEXT_SVG_FALLBACK'));
  assert.equal(svg.diagnostics.filter((item) => item.code === 'FIG_FILE_NODE_SKIPPED').length, 0);

  const png = importFigmaDocument(document, 'Gradient', 'png');
  assert.equal(png.pages[0].roots[0].children.length, 2);
  for (const node of png.pages[0].roots[0].children) {
    assert.ok(node.kind === 'image');
    assert.deepEqual([...node.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  }
});

test('coalesces a dense vector group even when the FIG group carries the default frame-mask flag', () => {
  const guid = (localID: number) => ({ sessionID: 1, localID });
  const nodes = [
    { guid: guid(0), type: 'DOCUMENT', name: 'Document' },
    { guid: guid(1), type: 'CANVAS', name: 'Page', parentIndex: { guid: guid(0), position: '!' } },
    { guid: guid(2), type: 'FRAME', name: 'Root', parentIndex: { guid: guid(1), position: '!' }, size: { x: 100, y: 50 } },
    {
      guid: guid(3), type: 'GROUP', name: 'Dense icon', parentIndex: { guid: guid(2), position: '!' },
      size: { x: 80, y: 10 }, frameMaskDisabled: false,
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      guid: guid(4 + index), type: 'RECTANGLE', name: `Part ${index + 1}`,
      parentIndex: { guid: guid(3), position: String.fromCharCode(33 + index) },
      size: { x: 8, y: 8 }, transform: { m02: index * 10, m12: 1 },
      fillPaints: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
    })),
  ] as Parameters<typeof importFigmaDocument>[0]['nodes'];
  const nodeMap = new Map(nodes.map((node) => [`${node.guid.sessionID}:${node.guid.localID}`, node]));
  const childrenMap = new Map<string, typeof nodes>();
  for (const node of nodes) {
    const owner = node.parentIndex?.guid;
    if (!owner) continue;
    const key = `${owner.sessionID}:${owner.localID}`;
    childrenMap.set(key, [...(childrenMap.get(key) ?? []), node]);
  }
  const imported = importFigmaDocument({
    header: { prelude: 'fig-kiwi', version: 1 }, nodes, nodeMap, childrenMap,
    schema: {}, compiledSchema: {}, rawChunks: [], message: {}, images: new Map(),
  }, 'Dense', 'svg');
  const icon = imported.pages[0].roots[0].children[0];
  assert.ok(icon.kind === 'image');
  assert.equal((new TextDecoder().decode(icon.bytes).match(/<path /g) ?? []).length, 8);
  assert.ok(imported.diagnostics.some((item) => item.code === 'FIG_COMPOSITE_SVG_FALLBACK'));
});

test('infers missing resize-to-fit container bounds from children', () => {
  const child = {
    guid: { sessionID: 1, localID: 2 },
    type: 'TEXT',
    size: { x: 325, y: 57 },
    transform: { m02: 30, m12: 0 },
  } as Parameters<typeof inferResizeToFitSize>[1];
  const parent = {
    guid: { sessionID: 1, localID: 1 },
    type: 'FRAME',
    resizeToFit: true,
  } as Parameters<typeof inferResizeToFitSize>[1];
  const document = {
    childrenMap: new Map([['1:1', [child]]]),
  } as Parameters<typeof inferResizeToFitSize>[0];

  assert.deepEqual(inferResizeToFitSize(document, parent), { width: 355, height: 57 });
});

test('reads current FIG section, image hash, and mask encodings', () => {
  const frame = {
    guid: { sessionID: 1, localID: 2 },
    type: 'FRAME',
    name: 'Nested frame',
  } as Parameters<typeof collectFigmaPageRoots>[1];
  const text = {
    guid: { sessionID: 1, localID: 3 },
    type: 'TEXT',
    name: 'Loose text',
  } as Parameters<typeof collectFigmaPageRoots>[1];
  const section = {
    guid: { sessionID: 1, localID: 1 },
    type: 'SECTION',
    name: 'Section',
  } as Parameters<typeof collectFigmaPageRoots>[1];
  const document = {
    childrenMap: new Map([['1:1', [frame, text]]]),
  } as Parameters<typeof collectFigmaPageRoots>[0];
  const diagnostics: Parameters<typeof collectFigmaPageRoots>[2] = [];

  assert.deepEqual(collectFigmaPageRoots(document, section, diagnostics), [frame]);
  assert.deepEqual(diagnostics.map((item) => [item.code, item.nodeId]), [['ROOT_NODE_IGNORED', '1:3']]);
  assert.equal(figImageKey({
    type: 'IMAGE',
    image: { name: 'display-name', hash: new Uint8Array([0xab, 0xcd]) },
  }), 'abcd');
  assert.equal(isFigmaMask({
    guid: { sessionID: 1, localID: 4 },
    type: 'ROUNDED_RECTANGLE',
    name: 'Mask',
    mask: true,
  } as Parameters<typeof isFigmaMask>[0]), true);
});

test('converts a real local .fig file without a Figma token', async () => {
  assert.throws(() => parseFigmaFile(new Uint8Array([0])), /Invalid Figma \.fig file/);

  const document = parseFigmaFile(await readFile(fixture));
  assert.equal(document.name, 'Untitled');
  assert.equal(document.pages[0].name, 'Page 1');
  assert.equal(document.pages[0].roots[0].name, 'basic_shapes');
  const group = document.pages[0].roots[0].children[0];
  assert.ok(group.kind === 'frame');
  assert.equal(group.sourceType, 'group');
  assert.equal(group.flattenable, false);
  assert.deepEqual(group.children.map((node) => node.kind), ['shape', 'shape']);
  assert.equal(document.diagnostics.filter((item) => item.code === 'FIG_FILE_NODE_SKIPPED').length, 4);
  assert.ok(document.diagnostics.some((item) =>
    item.nodeId === group.id && item.code === 'GROUP_COMPONENT_FALLBACK'));

  const directory = await mkdtemp(join(tmpdir(), 'fairygui-maker-import-fig-'));
  try {
    const output = join(directory, 'Basic Shapes.fairy');
    await writeProjectFromUam(new NodeIO(), convertDocument(document).project, output);
    const project = await readProjectAsUam(new NodeIO(), output, { hydrateResourceBytes: true });
    assert.equal(project.packages.length, 1);
    assert.equal(project.packages[0].resources.filter((item) => item.kind === 'component').length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parses the pinned third-party FIG corpus', async () => {
  for (const name of thirdPartyFixtures) {
    const document = parseFigmaFile(
      await readFile(join(process.cwd(), 'test', 'fixtures', 'design-import', name)),
      name,
    );
    assert.ok(document.pages.length > 0, name);
    assert.ok(document.pages.some((page) => page.roots.length > 0), name);
    if (name === 'medium-complex.fig') {
      const nodes: ImportNode[] = document.pages.flatMap((page) => page.roots);
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node.kind === 'frame') nodes.push(...node.children);
      }
      const polygon = nodes.find((node) => node.id === '1:284');
      assert.ok(polygon?.kind === 'shape');
      assert.equal(polygon.shape, 'polygon');
      assert.deepEqual(polygon.points?.slice(0, 6), [
        298.2787780761719,
        17.855632781982422,
        266.3060607910156,
        381.9617919921875,
        0,
        388.5596618652344,
      ]);
      assert.ok(document.diagnostics.some((item) =>
        item.nodeId === '1:77' && item.code === 'FIG_FILE_NODE_SKIPPED'));
    }
  }
});

test('optionally falls back curved Vector and Boolean nodes to SVG or PNG', async () => {
  const source = await readFile(join(process.cwd(), 'test', 'fixtures', 'design-import', 'medium-complex.fig'));
  const nodes = (document: ReturnType<typeof parseFigmaFile>) => {
    const result: ImportNode[] = document.pages.flatMap((page) => page.roots);
    for (let index = 0; index < result.length; index += 1) {
      const node = result[index];
      if (node.kind === 'frame') result.push(...node.children);
    }
    return result;
  };

  const skipped = parseFigmaFile(source, 'medium-complex.fig');
  const svg = parseFigmaFile(source, 'medium-complex.fig', 'svg');
  const png = parseFigmaFile(source, 'medium-complex.fig', 'png');
  assert.equal(skipped.diagnostics.filter((item) => item.code === 'FIG_FILE_NODE_SKIPPED').length, 37);
  assert.equal(svg.diagnostics.filter((item) => item.code === 'FIG_VECTOR_SVG_FALLBACK').length, 36);
  assert.equal(svg.diagnostics.filter((item) => item.code === 'FIG_FILE_NODE_SKIPPED').length, 1);
  assert.ok(svg.diagnostics.some((item) => item.message.startsWith('BOOLEAN_OPERATION')));
  const svgImage = nodes(svg).find((node) => node.kind === 'image' && node.format === 'svg');
  const pngImage = nodes(png).find((node) => node.kind === 'image' && node.format === 'png');
  assert.ok(svgImage?.kind === 'image');
  assert.equal(new TextDecoder().decode(svgImage.bytes.slice(0, 4)), '<svg');
  assert.ok(pngImage?.kind === 'image');
  assert.deepEqual([...pngImage.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

  const converted = convertDocument(svg);
  const resource = converted.project.packages
    .flatMap((pkg) => pkg.resources)
    .find((item) => item.kind === 'image' && item.fileName?.endsWith('.svg'));
  assert.ok(resource?.kind === 'image');
  assert.equal(new TextDecoder().decode(resource.sourceBytes?.slice(0, 4)), '<svg');
  assert.equal(converted.report.diagnostics.FIG_VECTOR_SVG_FALLBACK, 36);
});
