import {
  IMPORT_FIXTURE_DOCUMENT,
  parseImportFixture,
  serializeImportFixture,
} from './fixture';
import type { ImportDocument, ImportImage, ImportNode } from './model';

export const MAKER_IMPORT_BUNDLE_VERSION = 1 as const;
export const MAKER_IMPORT_BUNDLE_MANIFEST = 'maker-import.json';

export type MakerImportSourceKindV1 = 'fig' | 'psd' | 'figma-rest' | 'raster';

export interface MakerImportSourceV1 {
  kind: MakerImportSourceKindV1;
  name: string;
  sha256: string;
}

export interface MakerImportPointV1 {
  x: number;
  y: number;
}

export interface MakerImportScale9GridV1 extends MakerImportPointV1 {
  width: number;
  height: number;
}

export interface MakerImportAssetV1 {
  path: string;
  format: ImportImage['format'];
  sha256: string;
  byteLength: number;
}

export interface MakerImportAssetBindingV1 {
  sourceNodeId: string;
  assetPath: string;
  pixelRatio: number;
  trimOffset: MakerImportPointV1;
  scale9Grid: MakerImportScale9GridV1 | null;
}

export interface MakerImportBundleManifestV1 {
  schemaVersion: typeof MAKER_IMPORT_BUNDLE_VERSION;
  source: MakerImportSourceV1;
  document: {
    path: typeof IMPORT_FIXTURE_DOCUMENT;
    sha256: string;
    byteLength: number;
  };
  assets: MakerImportAssetV1[];
  bindings: MakerImportAssetBindingV1[];
}

export interface MakerImportBundleV1 {
  manifest: MakerImportBundleManifestV1;
  document: ImportDocument;
}

export interface MakerImportBindingOverrideV1 {
  pixelRatio?: number;
  trimOffset?: MakerImportPointV1;
  scale9Grid?: MakerImportScale9GridV1 | null;
}

export interface MakerImportBundleInputV1 {
  source: MakerImportSourceV1;
  document: ImportDocument;
  assetBindings?: Record<string, MakerImportBindingOverrideV1>;
}

const MANIFEST_LIMIT = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const ASSET_PATH = /^assets\/\d{6}\.(png|svg)$/;
const SOURCE_KINDS: MakerImportSourceKindV1[] = ['fig', 'psd', 'figma-rest', 'raster'];
type JsonRecord = Record<string, unknown>;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as JsonRecord)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => [key, canonicalJson(item)]));
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(canonicalJson(value), null, 2)}\n`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function canonicalFixtureFiles(document: ImportDocument): Record<string, Uint8Array> {
  const files = serializeImportFixture(document);
  files[IMPORT_FIXTURE_DOCUMENT] = jsonBytes(JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(files[IMPORT_FIXTURE_DOCUMENT]),
  ));
  return files;
}

function fail(path: string, expected: string): never {
  throw new Error(`Invalid Maker Import Bundle v1: ${path} must be ${expected}`);
}

function record(value: unknown, path: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object');
  return value as JsonRecord;
}

function exactRecord(value: unknown, path: string, keys: string[]): JsonRecord {
  const raw = record(value, path);
  const unexpected = Object.keys(raw).filter((key) => !keys.includes(key));
  if (unexpected.length > 0) fail(path, `an object without unexpected field ${unexpected[0]}`);
  return raw;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array');
  return value;
}

function text(value: unknown, path: string, maxLength = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f]/.test(value)) {
    fail(path, `a non-empty string no longer than ${maxLength} characters`);
  }
  return value;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'a finite number');
  return value;
}

function positive(value: unknown, path: string): number {
  const result = finite(value, path);
  if (result <= 0) fail(path, 'greater than zero');
  return result;
}

function byteLength(value: unknown, path: string): number {
  const result = finite(value, path);
  if (!Number.isSafeInteger(result) || result <= 0) fail(path, 'a positive safe integer');
  return result;
}

function digest(value: unknown, path: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(path, 'a lowercase SHA-256 hex digest');
  return value;
}

function point(value: unknown, path: string): MakerImportPointV1 {
  const raw = exactRecord(value, path, ['x', 'y']);
  return { x: finite(raw.x, `${path}.x`), y: finite(raw.y, `${path}.y`) };
}

function scale9Grid(value: unknown, path: string): MakerImportScale9GridV1 | null {
  if (value === null) return null;
  const raw = exactRecord(value, path, ['x', 'y', 'width', 'height']);
  const result = {
    x: finite(raw.x, `${path}.x`),
    y: finite(raw.y, `${path}.y`),
    width: positive(raw.width, `${path}.width`),
    height: positive(raw.height, `${path}.height`),
  };
  if (result.x < 0 || result.y < 0) fail(path, 'a non-negative rectangle');
  return result;
}

function source(value: unknown, path: string): MakerImportSourceV1 {
  const raw = exactRecord(value, path, ['kind', 'name', 'sha256']);
  const kind = text(raw.kind, `${path}.kind`, 32) as MakerImportSourceKindV1;
  if (!SOURCE_KINDS.includes(kind)) fail(`${path}.kind`, SOURCE_KINDS.join(', '));
  return {
    kind,
    name: text(raw.name, `${path}.name`, 256),
    sha256: digest(raw.sha256, `${path}.sha256`),
  };
}

function asset(value: unknown, path: string): MakerImportAssetV1 {
  const raw = exactRecord(value, path, ['path', 'format', 'sha256', 'byteLength']);
  const assetPath = text(raw.path, `${path}.path`);
  const match = ASSET_PATH.exec(assetPath);
  if (!match) fail(`${path}.path`, 'an assets/000001.png or assets/000001.svg path');
  const format = text(raw.format, `${path}.format`, 3) as ImportImage['format'];
  if (format !== match[1]) fail(`${path}.format`, `the ${match[1]} extension of ${assetPath}`);
  return {
    path: assetPath,
    format,
    sha256: digest(raw.sha256, `${path}.sha256`),
    byteLength: byteLength(raw.byteLength, `${path}.byteLength`),
  };
}

function binding(value: unknown, path: string): MakerImportAssetBindingV1 {
  const raw = exactRecord(value, path, [
    'sourceNodeId', 'assetPath', 'pixelRatio', 'trimOffset', 'scale9Grid',
  ]);
  const assetPath = text(raw.assetPath, `${path}.assetPath`);
  if (!ASSET_PATH.test(assetPath)) fail(`${path}.assetPath`, 'an assets/000001.png or assets/000001.svg path');
  return {
    sourceNodeId: text(raw.sourceNodeId, `${path}.sourceNodeId`),
    assetPath,
    pixelRatio: positive(raw.pixelRatio, `${path}.pixelRatio`),
    trimOffset: point(raw.trimOffset, `${path}.trimOffset`),
    scale9Grid: scale9Grid(raw.scale9Grid, `${path}.scale9Grid`),
  };
}

function sortedUnique<T>(items: T[], value: (item: T) => string, path: string): void {
  const values = items.map(value);
  if (new Set(values).size !== values.length) fail(path, 'unique entries');
  const sorted = [...values].sort(compareText);
  if (values.some((item, index) => item !== sorted[index])) fail(path, 'entries sorted by their stable key');
}

function manifest(value: unknown): MakerImportBundleManifestV1 {
  const raw = exactRecord(value, 'manifest', ['schemaVersion', 'source', 'document', 'assets', 'bindings']);
  if (raw.schemaVersion !== MAKER_IMPORT_BUNDLE_VERSION) fail('manifest.schemaVersion', '1');
  const documentRaw = exactRecord(raw.document, 'manifest.document', ['path', 'sha256', 'byteLength']);
  if (documentRaw.path !== IMPORT_FIXTURE_DOCUMENT) {
    fail('manifest.document.path', IMPORT_FIXTURE_DOCUMENT);
  }
  const assets = array(raw.assets, 'manifest.assets').map((item, index) =>
    asset(item, `manifest.assets[${index}]`));
  const bindings = array(raw.bindings, 'manifest.bindings').map((item, index) =>
    binding(item, `manifest.bindings[${index}]`));
  sortedUnique(assets, (item) => item.path, 'manifest.assets');
  sortedUnique(bindings, (item) => item.sourceNodeId, 'manifest.bindings');
  const contentKeys = assets.map((item) => `${item.format}:${item.sha256}`);
  if (new Set(contentKeys).size !== contentKeys.length) fail('manifest.assets', 'content-deduplicated entries');
  return {
    schemaVersion: MAKER_IMPORT_BUNDLE_VERSION,
    source: source(raw.source, 'manifest.source'),
    document: {
      path: IMPORT_FIXTURE_DOCUMENT,
      sha256: digest(documentRaw.sha256, 'manifest.document.sha256'),
      byteLength: byteLength(documentRaw.byteLength, 'manifest.document.byteLength'),
    },
    assets,
    bindings,
  };
}

function imageNodes(document: ImportDocument): ImportImage[] {
  const result: ImportImage[] = [];
  const visit = (node: ImportNode): void => {
    if (node.kind === 'image') result.push(node);
    if (node.kind === 'frame') node.children.forEach(visit);
  };
  document.pages.forEach((page) => page.roots.forEach(visit));
  return result;
}

function bindingOverride(value: unknown, path: string): MakerImportBindingOverrideV1 {
  const raw = exactRecord(value, path, ['pixelRatio', 'trimOffset', 'scale9Grid']);
  return {
    ...(raw.pixelRatio === undefined ? {} : { pixelRatio: positive(raw.pixelRatio, `${path}.pixelRatio`) }),
    ...(raw.trimOffset === undefined ? {} : { trimOffset: point(raw.trimOffset, `${path}.trimOffset`) }),
    ...(raw.scale9Grid === undefined ? {} : { scale9Grid: scale9Grid(raw.scale9Grid, `${path}.scale9Grid`) }),
  };
}

function requireBytes(files: Record<string, Uint8Array>, path: string): Uint8Array {
  const value: unknown = files[path];
  if (!(value instanceof Uint8Array) || value.byteLength === 0) fail(`file ${path}`, 'non-empty bytes');
  return value;
}

function validateGrid(node: ImportImage, value: MakerImportScale9GridV1 | null, path: string): void {
  if (!value) return;
  if (value.x + value.width > node.width || value.y + value.height > node.height) {
    fail(path, `inside source node ${node.id} bounds ${node.width}x${node.height}`);
  }
}

export async function makerImportSha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto SHA-256 is unavailable');
  const digestBytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)));
  return [...digestBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function serializeMakerImportBundleV1(
  input: MakerImportBundleInputV1,
): Promise<Record<string, Uint8Array>> {
  const fixtureFiles = canonicalFixtureFiles(input.document);
  const validatedDocument = parseImportFixture(fixtureFiles);
  const documentBytes = fixtureFiles[IMPORT_FIXTURE_DOCUMENT];
  const assets = await Promise.all(Object.entries(fixtureFiles)
    .filter(([path]) => ASSET_PATH.test(path))
    .sort(([left], [right]) => compareText(left, right))
    .map(async ([path, bytes]): Promise<MakerImportAssetV1> => ({
      path,
      format: path.endsWith('.png') ? 'png' : 'svg',
      sha256: await makerImportSha256(bytes),
      byteLength: bytes.byteLength,
    })));
  const assetsByContent = new Map(assets.map((item) => [`${item.format}:${item.sha256}`, item]));
  const images = imageNodes(validatedDocument);
  const overrides = input.assetBindings === undefined
    ? {}
    : record(input.assetBindings, 'assetBindings');
  const imageIds = new Set(images.map((item) => item.id));
  const unexpectedOverride = Object.keys(overrides).find((id) => !imageIds.has(id));
  if (unexpectedOverride) fail(`assetBindings.${unexpectedOverride}`, 'an existing ImportImage node ID');

  const bindings = await Promise.all(images.map(async (image): Promise<MakerImportAssetBindingV1> => {
    const imageDigest = await makerImportSha256(image.bytes);
    const assetEntry = assetsByContent.get(`${image.format}:${imageDigest}`);
    if (!assetEntry) fail(`image ${image.id}`, 'a serialized asset');
    const override = overrides[image.id] === undefined
      ? {}
      : bindingOverride(overrides[image.id], `assetBindings.${image.id}`);
    const result: MakerImportAssetBindingV1 = {
      sourceNodeId: image.id,
      assetPath: assetEntry.path,
      pixelRatio: override.pixelRatio ?? 1,
      trimOffset: override.trimOffset ?? { x: 0, y: 0 },
      scale9Grid: override.scale9Grid ?? null,
    };
    validateGrid(image, result.scale9Grid, `assetBindings.${image.id}.scale9Grid`);
    return result;
  }));
  bindings.sort((left, right) => compareText(left.sourceNodeId, right.sourceNodeId));

  const bundleManifest = manifest({
    schemaVersion: MAKER_IMPORT_BUNDLE_VERSION,
    source: input.source,
    document: {
      path: IMPORT_FIXTURE_DOCUMENT,
      sha256: await makerImportSha256(documentBytes),
      byteLength: documentBytes.byteLength,
    },
    assets,
    bindings,
  });
  const manifestBytes = jsonBytes(bundleManifest);
  if (manifestBytes.byteLength > MANIFEST_LIMIT) fail('manifest', 'no larger than 1 MiB');
  return { [MAKER_IMPORT_BUNDLE_MANIFEST]: manifestBytes, ...fixtureFiles };
}

export async function parseMakerImportBundleV1(
  files: Record<string, Uint8Array>,
): Promise<MakerImportBundleV1> {
  const manifestBytes = requireBytes(files, MAKER_IMPORT_BUNDLE_MANIFEST);
  if (manifestBytes.byteLength > MANIFEST_LIMIT) fail('manifest', 'no larger than 1 MiB');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new Error(`Invalid ${MAKER_IMPORT_BUNDLE_MANIFEST}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const bundleManifest = manifest(parsed);
  if (!sameBytes(manifestBytes, jsonBytes(bundleManifest))) fail('manifest', 'canonical JSON bytes');
  const expectedPaths = new Set([
    MAKER_IMPORT_BUNDLE_MANIFEST,
    bundleManifest.document.path,
    ...bundleManifest.assets.map((item) => item.path),
  ]);
  const unexpectedPath = Object.keys(files).find((path) => !expectedPaths.has(path));
  if (unexpectedPath) fail('files', `without unexpected path ${unexpectedPath}`);
  const missingPath = [...expectedPaths].find((path) => files[path] === undefined);
  if (missingPath) fail('files', `to include ${missingPath}`);

  const documentBytes = requireBytes(files, bundleManifest.document.path);
  if (documentBytes.byteLength !== bundleManifest.document.byteLength
    || await makerImportSha256(documentBytes) !== bundleManifest.document.sha256) {
    fail(`file ${bundleManifest.document.path}`, 'the declared byteLength and SHA-256');
  }
  for (const item of bundleManifest.assets) {
    const bytes = requireBytes(files, item.path);
    if (bytes.byteLength !== item.byteLength || await makerImportSha256(bytes) !== item.sha256) {
      fail(`file ${item.path}`, 'the declared byteLength and SHA-256');
    }
  }

  const document = parseImportFixture(files);
  const canonicalFiles = canonicalFixtureFiles(document);
  for (const [path, bytes] of Object.entries(canonicalFiles)) {
    if (!sameBytes(bytes, requireBytes(files, path))) fail(`file ${path}`, 'canonical fixture bytes');
  }
  const assetsByContent = new Map(bundleManifest.assets.map((item) => [`${item.format}:${item.sha256}`, item]));
  const bindingsByNode = new Map(bundleManifest.bindings.map((item) => [item.sourceNodeId, item]));
  const referencedAssets = new Set<string>();
  const images = imageNodes(document);
  if (images.length !== bundleManifest.bindings.length) fail('manifest.bindings', 'one entry per ImportImage node');
  for (const image of images) {
    const item = bindingsByNode.get(image.id);
    if (!item) fail('manifest.bindings', `an entry for ImportImage node ${image.id}`);
    const expectedAsset = assetsByContent.get(`${image.format}:${await makerImportSha256(image.bytes)}`);
    if (!expectedAsset || item.assetPath !== expectedAsset.path) {
      fail(`manifest binding ${image.id}.assetPath`, 'the asset referenced by its ImportImage node');
    }
    validateGrid(image, item.scale9Grid, `manifest binding ${image.id}.scale9Grid`);
    referencedAssets.add(item.assetPath);
  }
  if (referencedAssets.size !== bundleManifest.assets.length) fail('manifest.assets', 'only referenced assets');
  return { manifest: bundleManifest, document };
}
