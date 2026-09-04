import type {
  Diagnostic,
  ImportDocument,
  ImportConstraints,
  ImportFrame,
  ImportImage,
  ImportInstance,
  ImportInstanceOverride,
  ImportNode,
  ImportPage,
  ImportShape,
  ImportShadow,
  ImportText,
  ImportTextRun,
} from './model';

export const IMPORT_FIXTURE_DOCUMENT = 'fixture.json';
const ASSET_PATH = /^assets\/\d{6}\.(?:png|svg)$/;
const MAX_NODE_DEPTH = 100;
type JsonRecord = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new Error(`${path} must be ${expected}`);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object');
  return value as JsonRecord;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array');
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string') fail(path, 'a string');
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean');
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value === null ? null : string(value, path);
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function constraints(value: unknown, path: string): ImportConstraints | null {
  if (value === null) return null;
  const raw = record(value, path);
  const horizontal = string(raw.horizontal, `${path}.horizontal`) as ImportConstraints['horizontal'];
  const vertical = string(raw.vertical, `${path}.vertical`) as ImportConstraints['vertical'];
  const allowed = ['min', 'center', 'max', 'stretch', 'scale'];
  if (!allowed.includes(horizontal)) fail(`${path}.horizontal`, allowed.join(', '));
  if (!allowed.includes(vertical)) fail(`${path}.vertical`, allowed.join(', '));
  return { horizontal, vertical };
}

function shadow(value: unknown, path: string): ImportShadow {
  const raw = record(value, path);
  return {
    color: string(raw.color, `${path}.color`),
    offsetX: number(raw.offsetX, `${path}.offsetX`),
    offsetY: number(raw.offsetY, `${path}.offsetY`),
  };
}

function textRun(value: unknown, path: string): ImportTextRun {
  const raw = record(value, path);
  return {
    start: number(raw.start, `${path}.start`),
    end: number(raw.end, `${path}.end`),
    fontFamily: string(raw.fontFamily, `${path}.fontFamily`),
    fontSize: number(raw.fontSize, `${path}.fontSize`),
    color: string(raw.color, `${path}.color`),
    bold: boolean(raw.bold, `${path}.bold`),
    italic: boolean(raw.italic, `${path}.italic`),
    underline: boolean(raw.underline, `${path}.underline`),
    strikethrough: boolean(raw.strikethrough, `${path}.strikethrough`),
  };
}

function instanceOverride(value: unknown, path: string): ImportInstanceOverride {
  const raw = record(value, path);
  return {
    targetId: string(raw.targetId, `${path}.targetId`),
    targetPath: array(raw.targetPath, `${path}.targetPath`)
      .map((item, index) => string(item, `${path}.targetPath[${index}]`)),
    componentId: nullableString(raw.componentId, `${path}.componentId`),
    name: nullableString(raw.name, `${path}.name`),
    text: nullableString(raw.text, `${path}.text`),
    visible: raw.visible === null ? null : boolean(raw.visible, `${path}.visible`),
    opacity: raw.opacity === null ? null : number(raw.opacity, `${path}.opacity`),
    width: raw.width === null ? null : number(raw.width, `${path}.width`),
    height: raw.height === null ? null : number(raw.height, `${path}.height`),
    fillColor: nullableString(raw.fillColor, `${path}.fillColor`),
    strokeColor: nullableString(raw.strokeColor, `${path}.strokeColor`),
    strokeWidth: raw.strokeWidth === null ? null : number(raw.strokeWidth, `${path}.strokeWidth`),
    cornerRadius: cornerRadius(raw.cornerRadius, `${path}.cornerRadius`),
    fontFamily: nullableString(raw.fontFamily, `${path}.fontFamily`),
    fontSize: raw.fontSize === null ? null : number(raw.fontSize, `${path}.fontSize`),
    bold: raw.bold === null ? null : boolean(raw.bold, `${path}.bold`),
    italic: raw.italic === null ? null : boolean(raw.italic, `${path}.italic`),
    underline: raw.underline === null ? null : boolean(raw.underline, `${path}.underline`),
    strikethrough: raw.strikethrough === null ? null : boolean(raw.strikethrough, `${path}.strikethrough`),
  };
}

function base(raw: JsonRecord, path: string) {
  const width = number(raw.width, `${path}.width`);
  const height = number(raw.height, `${path}.height`);
  if (width < 0 || height < 0) fail(path, 'a node with non-negative width and height');
  return {
    id: string(raw.id, `${path}.id`),
    name: string(raw.name, `${path}.name`),
    x: number(raw.x, `${path}.x`),
    y: number(raw.y, `${path}.y`),
    width,
    height,
    visible: boolean(raw.visible, `${path}.visible`),
    opacity: number(raw.opacity, `${path}.opacity`),
    rotation: number(raw.rotation, `${path}.rotation`),
    scaleX: number(raw.scaleX, `${path}.scaleX`),
    scaleY: number(raw.scaleY, `${path}.scaleY`),
    mask: boolean(raw.mask, `${path}.mask`),
    constraints: constraints(raw.constraints, `${path}.constraints`),
    layoutChild: boolean(raw.layoutChild, `${path}.layoutChild`),
  };
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const raw = record(value, path);
  return Object.fromEntries(Object.entries(raw).map(([key, item]) => [key, string(item, `${path}.${key}`)]));
}

function cornerRadius(value: unknown, path: string): [number, number, number, number] | null {
  if (value === null) return null;
  const values = array(value, path);
  if (values.length !== 4) fail(path, 'an array of four finite numbers or null');
  return values.map((item, index) => number(item, `${path}[${index}]`)) as [number, number, number, number];
}

function points(value: unknown, path: string): number[] | null {
  if (value === null) return null;
  return array(value, path).map((item, index) => number(item, `${path}[${index}]`));
}

function diagnostic(value: unknown, path: string): Diagnostic {
  const raw = record(value, path);
  const severity = string(raw.severity, `${path}.severity`);
  const nodeName = optionalString(raw.nodeName, `${path}.nodeName`);
  const nodeType = optionalString(raw.nodeType, `${path}.nodeType`);
  const pageId = optionalString(raw.pageId, `${path}.pageId`);
  const pageName = optionalString(raw.pageName, `${path}.pageName`);
  const rootId = optionalString(raw.rootId, `${path}.rootId`);
  const rootName = optionalString(raw.rootName, `${path}.rootName`);
  if (severity !== 'warning' && severity !== 'error') fail(`${path}.severity`, '"warning" or "error"');
  return {
    code: string(raw.code, `${path}.code`),
    message: string(raw.message, `${path}.message`),
    nodeId: string(raw.nodeId, `${path}.nodeId`),
    severity,
    ...(nodeName === undefined ? {} : { nodeName }),
    ...(nodeType === undefined ? {} : { nodeType }),
    ...(pageId === undefined ? {} : { pageId }),
    ...(pageName === undefined ? {} : { pageName }),
    ...(rootId === undefined ? {} : { rootId }),
    ...(rootName === undefined ? {} : { rootName }),
  };
}

function node(value: unknown, path: string, files: Record<string, Uint8Array>, depth = 0): ImportNode {
  if (depth > MAX_NODE_DEPTH) fail(path, `a node tree no deeper than ${MAX_NODE_DEPTH}`);
  const raw = record(value, path);
  const kind = string(raw.kind, `${path}.kind`);
  const common = base(raw, path);

  if (kind === 'frame') {
    const sourceType = string(raw.sourceType, `${path}.sourceType`) as ImportFrame['sourceType'];
    const frame: ImportFrame = {
      kind,
      ...common,
      sourceType,
      ...(sourceType === 'group' ? { flattenable: boolean(raw.flattenable, `${path}.flattenable`) } : {}),
      variantProperties: stringRecord(raw.variantProperties, `${path}.variantProperties`),
      layout: raw.layout === null ? null : (() => {
        const layout = record(raw.layout, `${path}.layout`);
        const mode = string(layout.mode, `${path}.layout.mode`) as 'horizontal' | 'vertical';
        if (mode !== 'horizontal' && mode !== 'vertical') fail(`${path}.layout.mode`, '"horizontal" or "vertical"');
        return { mode, gap: number(layout.gap, `${path}.layout.gap`) };
      })(),
      clipContent: boolean(raw.clipContent, `${path}.clipContent`),
      backgroundColor: nullableString(raw.backgroundColor, `${path}.backgroundColor`),
      children: array(raw.children, `${path}.children`)
        .map((child, index) => node(child, `${path}.children[${index}]`, files, depth + 1)),
    };
    if (!['frame', 'group', 'component', 'componentSet'].includes(frame.sourceType)) {
      fail(`${path}.sourceType`, '"frame", "group", "component", or "componentSet"');
    }
    return frame;
  }
  if (kind === 'instance') {
    const instance: ImportInstance = {
      kind,
      ...common,
      componentId: string(raw.componentId, `${path}.componentId`),
      overrides: array(raw.overrides, `${path}.overrides`)
        .map((item, index) => instanceOverride(item, `${path}.overrides[${index}]`)),
    };
    return instance;
  }
  if (kind === 'text') {
    const text: ImportText = {
      kind,
      ...common,
      text: string(raw.text, `${path}.text`),
      fontFamily: string(raw.fontFamily, `${path}.fontFamily`),
      fontSize: number(raw.fontSize, `${path}.fontSize`),
      color: string(raw.color, `${path}.color`),
      align: string(raw.align, `${path}.align`) as ImportText['align'],
      verticalAlign: string(raw.verticalAlign, `${path}.verticalAlign`) as ImportText['verticalAlign'],
      lineHeight: raw.lineHeight === null ? null : number(raw.lineHeight, `${path}.lineHeight`),
      letterSpacing: number(raw.letterSpacing, `${path}.letterSpacing`),
      autoSize: string(raw.autoSize, `${path}.autoSize`) as ImportText['autoSize'],
      singleLine: boolean(raw.singleLine, `${path}.singleLine`),
      bold: boolean(raw.bold, `${path}.bold`),
      italic: boolean(raw.italic, `${path}.italic`),
      underline: boolean(raw.underline, `${path}.underline`),
      strikethrough: boolean(raw.strikethrough, `${path}.strikethrough`),
      runs: array(raw.runs, `${path}.runs`).map((item, index) => textRun(item, `${path}.runs[${index}]`)),
      shadow: raw.shadow === null ? null : shadow(raw.shadow, `${path}.shadow`),
    };
    if (!['left', 'center', 'right'].includes(text.align)) fail(`${path}.align`, '"left", "center", or "right"');
    if (!['top', 'middle', 'bottom'].includes(text.verticalAlign)) {
      fail(`${path}.verticalAlign`, '"top", "middle", or "bottom"');
    }
    if (!['none', 'both', 'height', 'ellipsis'].includes(text.autoSize)) {
      fail(`${path}.autoSize`, '"none", "both", "height", or "ellipsis"');
    }
    return text;
  }
  if (kind === 'shape') {
    const shape: ImportShape = {
      kind,
      ...common,
      shape: string(raw.shape, `${path}.shape`) as ImportShape['shape'],
      fillColor: string(raw.fillColor, `${path}.fillColor`),
      strokeColor: nullableString(raw.strokeColor, `${path}.strokeColor`),
      strokeWidth: number(raw.strokeWidth, `${path}.strokeWidth`),
      cornerRadius: cornerRadius(raw.cornerRadius, `${path}.cornerRadius`),
      points: points(raw.points, `${path}.points`),
      shadows: array(raw.shadows, `${path}.shadows`)
        .map((item, index) => shadow(item, `${path}.shadows[${index}]`)),
    };
    if (!['rectangle', 'ellipse', 'polygon'].includes(shape.shape)) {
      fail(`${path}.shape`, '"rectangle", "ellipse", or "polygon"');
    }
    if (shape.strokeWidth < 0) fail(`${path}.strokeWidth`, 'a non-negative number');
    if (shape.shape === 'polygon') {
      if (!shape.points || shape.points.length < 6 || shape.points.length % 2 !== 0) {
        fail(`${path}.points`, 'at least three x/y coordinate pairs');
      }
      if (shape.cornerRadius !== null) fail(`${path}.cornerRadius`, 'null for a polygon');
    } else if (shape.points !== null) {
      fail(`${path}.points`, 'null for a rectangle or ellipse');
    }
    return shape;
  }
  if (kind === 'image') {
    const asset = string(raw.asset, `${path}.asset`);
    const format = string(raw.format, `${path}.format`) as ImportImage['format'];
    if (format !== 'png' && format !== 'svg') fail(`${path}.format`, '"png" or "svg"');
    if (!ASSET_PATH.test(asset) || !asset.endsWith(`.${format}`)) {
      fail(`${path}.asset`, `a safe assets/000001.${format} path`);
    }
    const bytes = files[asset];
    if (!bytes?.byteLength) fail(`${path}.asset`, 'an existing non-empty asset');
    const image: ImportImage = { kind, ...common, format, bytes: new Uint8Array(bytes) };
    return image;
  }
  return fail(`${path}.kind`, '"frame", "instance", "text", "shape", or "image"');
}

function parseDocument(value: unknown, files: Record<string, Uint8Array>): ImportDocument {
  const raw = record(value, 'fixture');
  const pages: ImportPage[] = array(raw.pages, 'fixture.pages').map((value, pageIndex) => {
    const page = record(value, `fixture.pages[${pageIndex}]`);
    const roots = array(page.roots, `fixture.pages[${pageIndex}].roots`).map((value, rootIndex) => {
      const root = node(value, `fixture.pages[${pageIndex}].roots[${rootIndex}]`, files);
      if (root.kind !== 'frame') fail(`fixture.pages[${pageIndex}].roots[${rootIndex}].kind`, '"frame"');
      return root;
    });
    return {
      id: string(page.id, `fixture.document.pages[${pageIndex}].id`),
      name: string(page.name, `fixture.document.pages[${pageIndex}].name`),
      roots,
    };
  });
  if (pages.length === 0) fail('fixture.pages', 'a non-empty array');

  const pageIds = new Set<string>();
  const nodeIds = new Set<string>();
  const componentIds = new Set<string>();
  const instances: ImportInstance[] = [];
  const inspect = (item: ImportNode): void => {
    if (nodeIds.has(item.id)) fail('fixture', `unique node IDs; duplicate ${item.id}`);
    nodeIds.add(item.id);
    if (item.kind === 'instance') instances.push(item);
    if (item.kind === 'frame') {
      if (item.sourceType === 'component') componentIds.add(item.id);
      item.children.forEach(inspect);
    }
  };
  for (const page of pages) {
    if (pageIds.has(page.id)) fail('fixture.pages', `unique page IDs; duplicate ${page.id}`);
    pageIds.add(page.id);
    page.roots.forEach(inspect);
  }
  for (const instance of instances) {
    if (!componentIds.has(instance.componentId)) {
      fail(`fixture instance ${instance.id}.componentId`, 'the ID of a Component in the same fixture');
    }
  }
  return {
    name: string(raw.name, 'fixture.document.name'),
    pages,
    diagnostics: array(raw.diagnostics, 'fixture.document.diagnostics')
      .map((value, index) => diagnostic(value, `fixture.document.diagnostics[${index}]`)),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function serializeNode(item: ImportNode, assets: Record<string, Uint8Array>): unknown {
  if (item.kind === 'frame') {
    return { ...item, children: item.children.map((child) => serializeNode(child, assets)) };
  }
  if (item.kind !== 'image') return item;

  // ponytail: linear dedupe is enough for test fixtures; add a content-hash index if image counts reach thousands.
  const existing = Object.entries(assets)
    .find(([path, bytes]) => path.endsWith(`.${item.format}`) && sameBytes(bytes, item.bytes));
  if (existing) return { ...item, bytes: undefined, asset: existing[0] };
  const index = Object.keys(assets).length + 1;
  if (index > 999_999) throw new Error('Fixture contains more than 999,999 unique image assets');
  const asset = `assets/${index.toString().padStart(6, '0')}.${item.format}`;
  assets[asset] = new Uint8Array(item.bytes);
  return { ...item, bytes: undefined, asset };
}

export function serializeImportFixture(document: ImportDocument): Record<string, Uint8Array> {
  const assets: Record<string, Uint8Array> = {};
  const fixture = {
    ...document,
    pages: document.pages.map((page) => ({
      ...page,
      roots: page.roots.map((root) => serializeNode(root, assets)),
    })),
  };
  return {
    [IMPORT_FIXTURE_DOCUMENT]: new TextEncoder().encode(`${JSON.stringify(fixture, null, 2)}\n`),
    ...assets,
  };
}

export function parseImportFixture(files: Record<string, Uint8Array>): ImportDocument {
  const documentBytes = files[IMPORT_FIXTURE_DOCUMENT];
  if (!documentBytes) throw new Error(`Invalid fixture directory: ${IMPORT_FIXTURE_DOCUMENT} is missing`);
  if (documentBytes.byteLength > 16 * 1024 * 1024) {
    throw new Error(`Invalid fixture directory: ${IMPORT_FIXTURE_DOCUMENT} is too large`);
  }
  const assetBytes = Object.entries(files)
    .filter(([path]) => ASSET_PATH.test(path))
    .reduce((total, [, bytes]) => total + bytes.byteLength, 0);
  if (assetBytes > 512 * 1024 * 1024) throw new Error('Invalid fixture directory: assets exceed 512 MiB');

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(documentBytes));
  } catch (error) {
    throw new Error(`Invalid ${IMPORT_FIXTURE_DOCUMENT}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseDocument(parsed, files);
}
