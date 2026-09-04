import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { NodeIO } from '@openfairygui/core/node';
import { assertValidUamProject, readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import { Resvg } from '@resvg/resvg-js';

import {
  makerImportSha256,
  parseMakerImportBundleV1,
  type MakerImportSourceV1,
} from './bundle';
import { compilePlanToUam, convertDocument, safeName, type ConversionImageBinding, type ConversionReport } from './convert';
import { parseFigmaFile } from './figma-file';
import {
  MAKER_IMPORT_GENERATED_SNAPSHOT,
  MAKER_IMPORT_SNAPSHOT_DIRECTORY,
  createMakerImportStateV2,
  createReimportPlanV1,
  digestImportValue,
  parseMakerImportGeneratedSnapshotV2,
  parseMakerImportStateV2,
  type MakerImportGeneratedSnapshotV2,
  type MakerImportStateV2,
  type ReimportPlanV1,
} from './import-state';
import type { ImportDocument, ImportNode } from './model';
import { FAIRY_COMPILER_VERSION, FAIRY_PLANNER_VERSION, planDocument } from './plan';
import { parsePsdFile } from './psd-file';
import {
  assertSemanticTarget,
  createSemanticOverlay,
  type MakerSemanticOverlayV1,
} from './semantic-overlay';

export {
  collectFigmaPageRoots,
  compareFigmaPositions,
  figImageKey,
  importFigmaDocument,
  inferResizeToFitSize,
  isFigmaMask,
  parseFigmaFile,
  type FigmaVectorFallback,
} from './figma-file';
export { parsePsdFile } from './psd-file';

export const MAKER_IMPORT_STATE = 'maker-import-state.json';
const require = createRequire(import.meta.url);
const { version: MAKER_VERSION } = require('../../package.json') as { version: string };

export interface DesignImportResult {
  source: MakerImportSourceV1;
  outputDirectory: string;
  fairyPath: string;
  statePath: string;
  projectId: string;
  ids: Record<string, string>;
  report: ConversionReport;
}

const MAX_BUNDLE_FILES = 5_000;
const MAX_BUNDLE_BYTES = 530 * 1024 * 1024;
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

export async function readBundleDirectory(root: string): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};
  let count = 0;
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink()) throw new Error(`Maker Import Bundle cannot contain symbolic links: ${entry.name}`);
      if (stats.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!stats.isFile()) throw new Error(`Maker Import Bundle contains an unsupported entry: ${entry.name}`);
      count += 1;
      totalBytes += stats.size;
      if (count > MAX_BUNDLE_FILES || totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error('Maker Import Bundle exceeds the 5,000 file or 530 MiB input limit');
      }
      files[relative(root, absolutePath).split(sep).join('/')] = await readFile(absolutePath);
    }
  };
  await visit(root);
  return files;
}

function imagePixelSize(format: 'png' | 'svg', bytes: Uint8Array): { width: number; height: number } {
  if (format === 'svg') {
    const svg = new Resvg(Buffer.from(bytes), { font: { loadSystemFonts: false } });
    return { width: svg.width, height: svg.height };
  }
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 24
    || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || buffer.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Maker Import Bundle contains an invalid PNG asset');
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) throw new Error('Maker Import Bundle contains an empty PNG asset');
  return { width, height };
}

export function sourceNodeIds(document: ImportDocument, conversionIds: Record<string, string>): Record<string, string> {
  const ids: Array<[string, string]> = [];
  const visit = (node: ImportNode): void => {
    const id = conversionIds[`${node.id}:node`] ?? conversionIds[`${node.id}:resource`];
    if (id) ids.push([node.id, id]);
    if (node.kind === 'frame') node.children.forEach(visit);
  };
  document.pages.forEach((page) => page.roots.forEach(visit));
  return Object.fromEntries(ids.sort(([left], [right]) => compareText(left, right)));
}

export async function importDesignSource(options: {
  sourcePath: string;
  outputPath: string;
}): Promise<DesignImportResult> {
  const { source, document, imageBindings } = await parseDesignSource(options.sourcePath);
  const outputDirectory = resolve(options.outputPath);
  const converted = convertDocument(document, {}, imageBindings);
  let created = false;
  try {
    await mkdir(outputDirectory, { recursive: false });
    created = true;
    const fairyPath = join(outputDirectory, `${safeName(document.name)}.fairy`);
    const io = new NodeIO();
    await writeProjectFromUam(io, converted.project, fairyPath);
    const generatedProject = await readProjectAsUam(io, fairyPath, { hydrateResourceBytes: true });
    assertValidUamProject(generatedProject);
    const ids = sourceNodeIds(document, converted.ids);
    const statePath = join(outputDirectory, MAKER_IMPORT_STATE);
    const semanticOverlay = createSemanticOverlay(document);
    await writeMakerImportStateV2({
      projectRoot: outputDirectory,
      fairyFile: basename(fairyPath),
      source,
      sourcePath: resolve(options.sourcePath),
      document,
      project: generatedProject,
      makerVersion: MAKER_VERSION,
      profile: { buildPlan: 'legacy-hybrid', semantic: semanticOverlay.profile },
      semanticOverlay,
      conversionIds: converted.ids,
    });
    return {
      source,
      outputDirectory,
      fairyPath,
      statePath,
      projectId: converted.project.projectId,
      ids,
      report: converted.report,
    };
  } catch (error) {
    if (created) await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function writeMakerImportStateV2(input: {
  projectRoot: string;
  fairyFile: string;
  source: MakerImportSourceV1;
  sourcePath?: string;
  document: ImportDocument;
  project: MakerImportGeneratedSnapshotV2['project'];
  makerVersion: string;
  profile: unknown;
  semanticOverlay: MakerSemanticOverlayV1;
  conversionIds: Record<string, string>;
}): Promise<MakerImportStateV2> {
  const snapshot: MakerImportGeneratedSnapshotV2 = {
    schemaVersion: 2,
    project: input.project,
    semanticOverlay: input.semanticOverlay,
  };
  const snapshotBytes = encodeImportJson(snapshot);
  const metadataRoot = join(input.projectRoot, MAKER_IMPORT_SNAPSHOT_DIRECTORY);
  await mkdir(metadataRoot, { recursive: true });
  await writeFile(join(input.projectRoot, ...MAKER_IMPORT_GENERATED_SNAPSHOT.split('/')), snapshotBytes, { flag: 'wx' });
  const state = await createMakerImportStateV2({
    source: input.source,
    sourcePath: input.sourcePath,
    document: input.document,
    project: input.project,
    fairyFile: input.fairyFile,
    makerVersion: input.makerVersion,
    profile: input.profile,
    semanticOverlay: input.semanticOverlay,
    conversionIds: input.conversionIds,
    generatedSnapshotDigest: await makerImportSha256(snapshotBytes),
  });
  await writeFile(join(input.projectRoot, MAKER_IMPORT_STATE), encodeImportJson(state), { flag: 'wx' });
  return state;
}

export async function planProjectReimport(projectPath: string): Promise<ReimportPlanV1> {
  const projectDirectory = resolve(projectPath);
  const projectStat = await lstat(projectDirectory).catch(() => null);
  if (!projectStat?.isDirectory() || projectStat.isSymbolicLink()) {
    throw new Error('Reimport project must be a regular directory');
  }

  const statePath = join(projectDirectory, MAKER_IMPORT_STATE);
  const stateStat = await lstat(statePath).catch(() => null);
  if (!stateStat?.isFile() || stateStat.isSymbolicLink() || stateStat.size > 32 * 1024 * 1024) {
    throw new Error('Reimport project is missing a valid maker-import-state.json');
  }
  const state = parseMakerImportStateV2(JSON.parse(await readFile(statePath, 'utf8')));
  if (!state.source.path) throw new Error('Reimport source path is unavailable; create a local-path import first');
  if (state.compiler.makerVersion !== MAKER_VERSION) {
    throw new Error(`Reimport requires Maker ${state.compiler.makerVersion}; current version is ${MAKER_VERSION}`);
  }
  if ((state.compiler.compilerVersion && state.compiler.compilerVersion !== FAIRY_COMPILER_VERSION)
    || (state.compiler.plannerVersion && state.compiler.plannerVersion !== FAIRY_PLANNER_VERSION)) {
    throw new Error('Reimport Planner/Compiler version does not match import state');
  }

  const snapshotPath = join(projectDirectory, ...state.generatedSnapshotPath.split('/'));
  const snapshotStat = await lstat(snapshotPath).catch(() => null);
  if (!snapshotStat?.isFile() || snapshotStat.isSymbolicLink() || snapshotStat.size > 768 * 1024 * 1024) {
    throw new Error('Reimport generated snapshot is missing or invalid');
  }
  const snapshotBytes = await readFile(snapshotPath);
  if (await makerImportSha256(snapshotBytes) !== state.generatedSnapshotDigest) {
    throw new Error('Reimport generated snapshot digest does not match import state');
  }
  const snapshot = parseMakerImportGeneratedSnapshotV2(decodeImportJson(snapshotBytes));
  assertValidUamProject(snapshot.project);
  if (snapshot.project.projectId !== state.project.projectId) throw new Error('Reimport snapshot project ID does not match import state');
  if (await digestImportValue(snapshot.semanticOverlay) !== state.compiler.overlayDigest) {
    throw new Error('Reimport semantic overlay digest does not match import state');
  }
  const profile = { buildPlan: 'legacy-hybrid', semantic: snapshot.semanticOverlay.profile };
  if (await digestImportValue(profile) !== state.compiler.profileDigest) {
    throw new Error('Reimport compiler profile digest does not match import state');
  }

  const fairyPath = join(projectDirectory, state.project.fairyFile);
  const currentProject = await readProjectAsUam(new NodeIO(), fairyPath, { hydrateResourceBytes: true });
  assertValidUamProject(currentProject);
  if (currentProject.projectId !== state.project.projectId) throw new Error('Reimport target project ID does not match import state');

  const parsed = await parseDesignSource(state.source.path);
  if (parsed.source.kind !== state.source.kind || parsed.document.name !== state.source.documentId) {
    throw new Error('Reimport source does not match the imported document');
  }
  const { overlay, conflicts } = mergeManualOverlay(parsed.document, snapshot.semanticOverlay);
  const plan = planDocument(parsed.document, { semanticOverlay: overlay, imageBindings: parsed.imageBindings });
  const proposed = compilePlanToUam(parsed.document, plan, state.compiler.conversionIds, parsed.imageBindings);
  return createReimportPlanV1({
    projectDirectory,
    sourcePath: state.source.path,
    state,
    previousProject: snapshot.project,
    currentProject,
    currentSource: parsed.source,
    currentDocument: parsed.document,
    proposedProject: proposed.project,
    proposedIds: proposed.ids,
    semanticConflicts: conflicts,
  });
}

function mergeManualOverlay(
  document: ImportDocument,
  previous: MakerSemanticOverlayV1,
): { overlay: MakerSemanticOverlayV1; conflicts: Set<string> } {
  const overlay = createSemanticOverlay(document);
  overlay.profile = previous.profile;
  const nodes = new Map<string, ImportNode>();
  const visit = (node: ImportNode): void => {
    nodes.set(node.id, node);
    if (node.kind === 'frame') node.children.forEach(visit);
  };
  document.pages.forEach((page) => page.roots.forEach(visit));
  const conflicts = new Set<string>();
  for (const [nodeId, directive] of Object.entries(previous.nodes)) {
    if (directive.rationale !== 'User mapping') continue;
    const node = nodes.get(nodeId);
    if (!node) continue;
    try {
      overlay.nodes[nodeId] = assertSemanticTarget(node, directive);
    } catch {
      conflicts.add(nodeId);
    }
  }
  return { overlay, conflicts };
}

function encodeImportJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, (_key, item) => (
    item instanceof Uint8Array ? { $uint8: Buffer.from(item).toString('base64') } : item
  ), 2)}\n`);
}

function decodeImportJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes), (_key, item) => (
    item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.$uint8 === 'string'
      ? Uint8Array.from(Buffer.from(item.$uint8, 'base64'))
      : item
  ));
}

export interface ParsedDesignSource {
  source: MakerImportSourceV1;
  document: ImportDocument;
  imageBindings: Record<string, ConversionImageBinding>;
}

export async function parseDesignSource(inputPath: string): Promise<ParsedDesignSource> {
  const sourcePath = resolve(inputPath);
  const stats = await lstat(sourcePath);
  if (stats.isSymbolicLink()) throw new Error('Design import source cannot be a symbolic link');

  let source: MakerImportSourceV1;
  let document: ImportDocument;
  let imageBindings: Record<string, ConversionImageBinding> = {};
  if (stats.isDirectory()) {
    const files = await readBundleDirectory(sourcePath);
    const bundle = await parseMakerImportBundleV1(files);
    source = bundle.manifest.source;
    document = bundle.document;
    imageBindings = Object.fromEntries(bundle.manifest.bindings.map((binding) => {
      const asset = bundle.manifest.assets.find((item) => item.path === binding.assetPath)!;
      return [binding.sourceNodeId, {
        pixelRatio: binding.pixelRatio,
        trimOffset: binding.trimOffset,
        scale9Grid: binding.scale9Grid,
        pixelSize: imagePixelSize(asset.format, files[asset.path]),
      }];
    }));
  } else if (stats.isFile()) {
    const extension = extname(sourcePath).toLowerCase();
    if (extension !== '.fig' && extension !== '.psd') {
      throw new Error('Design import source must be a .fig file, .psd file, or Maker Import Bundle directory');
    }
    const bytes = await readFile(sourcePath);
    source = {
      kind: extension === '.fig' ? 'fig' : 'psd',
      name: basename(sourcePath),
      sha256: await makerImportSha256(bytes),
    };
    const name = basename(sourcePath, extension);
    document = extension === '.fig'
      ? parseFigmaFile(bytes, name, 'png')
      : parsePsdFile(bytes, name);
  } else {
    throw new Error('Design import source must be a regular file or directory');
  }
  return { source, document, imageBindings };
}
