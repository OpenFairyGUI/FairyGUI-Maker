import { randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { NodeIO } from '@openfairygui/core/node';
import { assertValidUamProject, readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import { z } from 'zod';
import { MAX_PENDING_UPLOADS, PENDING_UPLOAD_TTL_MS, receiveUpload, UploadError, type UploadBody } from '../upload';

import type { MakerImportSourceV1 } from './bundle';
import { compilePlanToUam, safeName, type ConversionReport } from './convert';
import type { Diagnostic, ImportDocument, ImportNode } from './model';
import {
  MAKER_IMPORT_STATE,
  parseDesignSource,
  readBundleDirectory,
  sourceNodeIds,
  writeMakerImportStateV2,
  type DesignImportResult,
} from './node';
import { planDocument, type ConversionImageBinding, type FairyBuildPlanV2 } from './plan';
import {
  assertSemanticTarget,
  createSemanticOverlay,
  validateSemanticOverlay,
  type MakerSemanticOverlayV1,
  type SemanticNodeDirective,
} from './semantic-overlay';

export const IMPORT_DRAFT_VERSION = 1 as const;
export const IMPORT_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MAX_IMPORT_SOURCE_BYTES = 530 * 1024 * 1024;
export const MAX_VISUAL_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_FILES = 5_000;
const SOURCE_LOCATOR = 'source-locator.json';
const require = createRequire(import.meta.url);
const { version: MAKER_VERSION } = require('../../package.json') as { version: string };

export type ImportDraftStatus = 'uploading' | 'created' | 'parsed' | 'planned' | 'compiled' | 'materialized';

export interface ImportDraftOutlineNode {
  id: string;
  name: string;
  kind: ImportNode['kind'];
  width: number;
  height: number;
  children?: ImportDraftOutlineNode[];
}

export interface ImportDraftOutline {
  name: string;
  pages: Array<{ id: string; name: string; roots: ImportDraftOutlineNode[] }>;
}

export interface ImportVisualEvidenceV1 {
  schemaVersion: 1;
  packageId: string;
  componentId: string;
  packageName: string;
  componentName: string;
  // Older v1 evidence remains readable; new Workbench captures always include the Broker stamp.
  renderState?: { renderSessionId: string; sourceRevision: string; semanticStateVersion: number; viewStateVersion: number };
  reference: { width: number; height: number };
  capture: { width: number; height: number };
  comparison: {
    width: number;
    height: number;
    totalPixels: number;
    differentPixels: number;
    meanAbsoluteError: number;
    maxChannelDelta: number;
  };
  createdAt: string;
}

export type ImportVisualEvidenceInput = Omit<ImportVisualEvidenceV1, 'createdAt'>;

export interface ImportDraftV1 {
  schemaVersion: typeof IMPORT_DRAFT_VERSION;
  draftId: string;
  revision: number;
  status: ImportDraftStatus;
  input: {
    kind: 'fig' | 'psd' | 'bundle';
    name: string;
  };
  upload: {
    files: Array<{ path: string; size: number }>;
  } | null;
  semanticOverlay: {
    revision: number;
    mappedNodes: number;
  } | null;
  source: MakerImportSourceV1 | null;
  diagnostics: Diagnostic[];
  buildPlan: {
    schemaVersion: 1 | 2;
    packages: number;
    components: number;
  } | null;
  generated: {
    fairyFile: string;
    projectId: string;
    ids: Record<string, string>;
    report: ConversionReport;
  } | null;
  visualEvidence: ImportVisualEvidenceV1 | null;
  materialized: {
    outputDirectory: string;
    at: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

const draftIdPattern = /^draft_[0-9a-f-]{36}$/;
const dateString = z.string().max(64).refine((value) => Number.isFinite(Date.parse(value)), 'Invalid date');
const fileName = z.string().min(1).max(255).refine(
  (value) => value === path.basename(value) && value !== '.' && value !== '..' && !value.includes('\0'),
  'Invalid file name',
);
const uploadPath = z.string().min(1).max(1_024).refine(
  (value) => {
    try {
      return normalizeUploadPath(value) === value;
    } catch {
      return false;
    }
  },
  'Invalid upload path',
);
const uploadInputSchema = z.object({
  kind: z.enum(['fig', 'psd', 'bundle']),
  name: fileName,
  files: z.array(z.object({
    path: uploadPath,
    size: z.number().int().nonnegative().max(MAX_IMPORT_SOURCE_BYTES),
  }).strict()).min(1).max(MAX_SOURCE_FILES),
}).strict().superRefine((input, context) => {
  if (new Set(input.files.map(({ path: filePath }) => filePath.toLowerCase())).size !== input.files.length) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Upload paths must be unique' });
  }
  if (input.files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_SOURCE_BYTES) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Design import source exceeds the 530 MiB input limit' });
  }
  if (input.kind === 'bundle') {
    if (!input.files.some(({ path: filePath }) => filePath === 'maker-import.json')) {
      context.addIssue({ code: 'custom', path: ['files'], message: 'Maker Import Bundle must contain maker-import.json' });
    }
    return;
  }
  if (input.files.length !== 1 || input.files[0]?.path !== input.name || path.extname(input.name).toLowerCase() !== `.${input.kind}`) {
    context.addIssue({ code: 'custom', path: ['files'], message: `A ${input.kind.toUpperCase()} draft must contain exactly its named .${input.kind} file` });
  }
});
const sourceLocatorSchema = z.object({ path: z.string().min(1).max(32_768) }).strict();
const sourceSchema = z.object({
  kind: z.enum(['fig', 'psd', 'figma-rest', 'raster']),
  name: z.string().min(1).max(255),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const diagnosticSchema = z.object({
  code: z.string(),
  message: z.string(),
  nodeId: z.string(),
  severity: z.enum(['warning', 'error']),
  nodeName: z.string().optional(),
  nodeType: z.string().optional(),
  pageId: z.string().optional(),
  pageName: z.string().optional(),
  rootId: z.string().optional(),
  rootName: z.string().optional(),
}).strict();
export const visualEvidenceSchema = z.object({
  schemaVersion: z.literal(1),
  packageId: z.string().min(1).max(128),
  componentId: z.string().min(1).max(128),
  packageName: z.string().min(1).max(256),
  componentName: z.string().min(1).max(256),
  renderState: z.object({
    renderSessionId: z.string().regex(/^render_[0-9a-f-]{36}$/),
    sourceRevision: z.string().min(1).max(128),
    semanticStateVersion: z.number().int().nonnegative(),
    viewStateVersion: z.number().int().nonnegative(),
  }).strict().optional(),
  reference: z.object({ width: z.number().int().positive().max(8_192), height: z.number().int().positive().max(8_192) }).strict(),
  capture: z.object({ width: z.number().int().positive().max(8_192), height: z.number().int().positive().max(8_192) }).strict(),
  comparison: z.object({
    width: z.number().int().positive().max(8_192),
    height: z.number().int().positive().max(8_192),
    totalPixels: z.number().int().positive().max(32_000_000),
    differentPixels: z.number().int().nonnegative().max(32_000_000),
    meanAbsoluteError: z.number().nonnegative().max(255),
    maxChannelDelta: z.number().int().nonnegative().max(255),
  }).strict(),
  createdAt: dateString,
}).strict();
const draftSchema = z.object({
  schemaVersion: z.literal(IMPORT_DRAFT_VERSION),
  draftId: z.string().regex(draftIdPattern),
  revision: z.number().int().positive(),
  status: z.enum(['uploading', 'created', 'parsed', 'planned', 'compiled', 'materialized']),
  input: z.object({
    kind: z.enum(['fig', 'psd', 'bundle']),
    name: fileName,
  }).strict(),
  upload: z.object({
    files: z.array(z.object({ path: uploadPath, size: z.number().int().nonnegative().max(MAX_IMPORT_SOURCE_BYTES) }).strict()).min(1).max(MAX_SOURCE_FILES),
  }).strict().nullable().default(null),
  semanticOverlay: z.object({
    revision: z.number().int().positive(),
    mappedNodes: z.number().int().nonnegative(),
  }).strict().nullable().default(null),
  source: sourceSchema.nullable(),
  diagnostics: z.array(diagnosticSchema),
  buildPlan: z.object({
    schemaVersion: z.union([z.literal(1), z.literal(2)]),
    packages: z.number().int().nonnegative(),
    components: z.number().int().nonnegative(),
  }).strict().nullable(),
  generated: z.object({
    fairyFile: fileName.refine((value) => value.toLowerCase().endsWith('.fairy'), 'Invalid FairyGUI project file'),
    projectId: z.string().min(1).max(128),
    ids: z.record(z.string(), z.string()),
    report: z.unknown(),
  }).strict().nullable(),
  visualEvidence: visualEvidenceSchema.nullable().default(null),
  materialized: z.object({ outputDirectory: z.string().min(1), at: dateString }).strict().nullable(),
  createdAt: dateString,
  updatedAt: dateString,
  expiresAt: dateString,
}).strict().superRefine((draft, context) => {
  if (draft.status === 'uploading' && !draft.upload) {
    context.addIssue({ code: 'custom', path: ['upload'], message: 'Uploading draft is missing its file manifest' });
  }
  if (draft.status === 'uploading' && draft.upload && !uploadInputSchema.safeParse({ ...draft.input, files: draft.upload.files }).success) {
    context.addIssue({ code: 'custom', path: ['upload'], message: 'Uploading draft has an invalid file manifest' });
  }
  if (draft.status !== 'uploading' && draft.upload) {
    context.addIssue({ code: 'custom', path: ['upload'], message: 'Completed upload must not retain its file manifest' });
  }
  if (!['uploading', 'created'].includes(draft.status) && !draft.source) {
    context.addIssue({ code: 'custom', path: ['source'], message: 'Parsed draft is missing source metadata' });
  }
  if (['planned', 'compiled', 'materialized'].includes(draft.status) && !draft.buildPlan) {
    context.addIssue({ code: 'custom', path: ['buildPlan'], message: 'Planned draft is missing its build plan' });
  }
  if (['compiled', 'materialized'].includes(draft.status) && !draft.generated) {
    context.addIssue({ code: 'custom', path: ['generated'], message: 'Compiled draft is missing generated metadata' });
  }
  if (draft.status === 'materialized' && !draft.materialized) {
    context.addIssue({ code: 'custom', path: ['materialized'], message: 'Materialized draft is missing its receipt' });
  }
});

export class ImportDraftError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

type ParsedSnapshot = {
  document: ImportDocument;
  imageBindings: Record<string, ConversionImageBinding>;
};

export type ImportDraftUploadInput = z.infer<typeof uploadInputSchema>;

export class ImportDraftStore {
  private readonly drafts = new Map<string, ImportDraftV1>();
  private readonly root: string;
  // ponytail: one store-wide queue is enough for local imports; split per draft only if parallel imports become measurable.
  private mutationTail: Promise<unknown> = Promise.resolve();
  private readonly uploads = new Map<string, { controller: AbortController; done: Promise<unknown> }>();

  constructor(dataDir: string) {
    this.root = path.join(path.resolve(dataDir), 'import-drafts');
  }

  async init(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !draftIdPattern.test(entry.name)) continue;
      const draftRoot = this.resolveDraftRoot(entry.name);
      try {
        const metadata = await stat(path.join(draftRoot, 'draft.json'));
        if (!metadata.isFile() || metadata.size > 32 * 1024 * 1024) throw new Error('invalid draft metadata');
        const draft = draftSchema.parse(JSON.parse(await readFile(path.join(draftRoot, 'draft.json'), 'utf8'))) as ImportDraftV1;
        if (draft.draftId !== entry.name || Date.parse(draft.expiresAt) <= Date.now()) {
          await rm(draftRoot, { recursive: true, force: true });
          continue;
        }
        this.drafts.set(draft.draftId, draft);
        for (const child of await readdir(draftRoot, { withFileTypes: true })) {
          if (child.isDirectory() && (child.name === '.uploads' || child.name.startsWith('.generated-') || child.name.startsWith('.visual-evidence-'))) {
            await rm(path.join(draftRoot, child.name), { recursive: true, force: true });
          }
        }
      } catch {
        await rm(draftRoot, { recursive: true, force: true });
      }
    }
  }

  list(limit = 50): ImportDraftV1[] {
    return [...this.drafts.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((draft) => structuredClone(draft));
  }

  get(draftId: string): ImportDraftV1 | null {
    const draft = this.drafts.get(draftId);
    return draft ? structuredClone(draft) : null;
  }

  count(): number {
    return this.drafts.size;
  }

  async getDetail(draftId: string): Promise<{
    draft: ImportDraftV1;
    buildPlan: FairyBuildPlanV2 | null;
    outline: ImportDraftOutline | null;
    semanticOverlay: MakerSemanticOverlayV1 | null;
  } | null> {
    const draft = this.drafts.get(draftId);
    if (!draft) return null;
    const buildPlan = draft.buildPlan
      ? await readJson<FairyBuildPlanV2>(path.join(this.resolveDraftRoot(draftId), 'build-plan.json'))
      : null;
    const snapshot = draft.source ? await this.readParsedSnapshot(draftId) : null;
    const outline = snapshot ? outlineDocument(snapshot.document) : null;
    const semanticOverlay = snapshot ? await this.readSemanticOverlay(draftId, snapshot.document) : null;
    return { draft: structuredClone(draft), buildPlan, outline, semanticOverlay };
  }

  async create(sourcePathInput: string): Promise<ImportDraftV1> {
    return this.mutate(async () => {
      const sourcePath = path.resolve(sourcePathInput);
      const sourceStat = await lstat(sourcePath).catch(() => null);
      if (!sourceStat) throw new ImportDraftError('Design import source does not exist');
      if (sourceStat.isSymbolicLink()) throw new ImportDraftError('Design import source cannot be a symbolic link');

      let kind: ImportDraftV1['input']['kind'];
      if (sourceStat.isDirectory()) kind = 'bundle';
      else if (sourceStat.isFile() && path.extname(sourcePath).toLowerCase() === '.fig') kind = 'fig';
      else if (sourceStat.isFile() && path.extname(sourcePath).toLowerCase() === '.psd') kind = 'psd';
      else throw new ImportDraftError('Design import source must be a .fig file, .psd file, or Maker Import Bundle directory');
      if (sourceStat.isFile() && sourceStat.size > MAX_IMPORT_SOURCE_BYTES) {
        throw new ImportDraftError('Design import source exceeds the 530 MiB input limit');
      }

      const draftId = `draft_${randomUUID()}`;
      const draftRoot = this.resolveDraftRoot(draftId);
      const sourceRoot = path.join(draftRoot, 'source');
      try {
        await mkdir(sourceRoot, { recursive: true });
        if (kind === 'bundle') {
          const files = await readBundleDirectory(sourcePath);
          const bundleRoot = path.join(sourceRoot, 'bundle');
          await mkdir(bundleRoot);
          for (const [relativePath, bytes] of Object.entries(files)) {
            const target = path.join(bundleRoot, ...relativePath.split('/'));
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, bytes, { flag: 'wx' });
          }
        } else {
          await copyFile(sourcePath, path.join(sourceRoot, path.basename(sourcePath)));
        }
        await writeJson(path.join(draftRoot, SOURCE_LOCATOR), { path: sourcePath });

        const now = new Date().toISOString();
        const draft: ImportDraftV1 = {
          schemaVersion: IMPORT_DRAFT_VERSION,
          draftId,
          revision: 1,
          status: 'created',
          input: { kind, name: path.basename(sourcePath) },
          upload: null,
          semanticOverlay: null,
          source: null,
          diagnostics: [],
          buildPlan: null,
          generated: null,
          visualEvidence: null,
          materialized: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(Date.now() + IMPORT_DRAFT_TTL_MS).toISOString(),
        };
        await writeJson(path.join(draftRoot, 'draft.json'), draft);
        this.drafts.set(draftId, draft);
        return structuredClone(draft);
      } catch (error) {
        await rm(draftRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async createUpload(inputValue: ImportDraftUploadInput): Promise<ImportDraftV1> {
    await this.pruneExpiredUploads();
    return this.mutate(async () => {
      const input = uploadInputSchema.parse(inputValue);
      const pending = [...this.drafts.values()].filter((draft) => draft.status === 'uploading');
      if (pending.length >= MAX_PENDING_UPLOADS) {
        throw new UploadError('import_draft_upload_limit_reached', 503);
      }
      const pendingBytes = pending.reduce((total, draft) => total + (draft.upload?.files.reduce((size, file) => size + file.size, 0) ?? 0), 0);
      if (pendingBytes + input.files.reduce((total, file) => total + file.size, 0) > MAX_IMPORT_SOURCE_BYTES) {
        throw new UploadError('import_draft_upload_capacity_exceeded', 503);
      }
      const draftId = `draft_${randomUUID()}`;
      const draftRoot = this.resolveDraftRoot(draftId);
      try {
        await mkdir(path.join(draftRoot, 'source', ...(input.kind === 'bundle' ? ['bundle'] : [])), { recursive: true });
        const now = new Date().toISOString();
        const draft: ImportDraftV1 = {
          schemaVersion: IMPORT_DRAFT_VERSION,
          draftId,
          revision: 1,
          status: 'uploading',
          input: { kind: input.kind, name: input.name },
          upload: { files: input.files },
          semanticOverlay: null,
          source: null,
          diagnostics: [],
          buildPlan: null,
          generated: null,
          visualEvidence: null,
          materialized: null,
          createdAt: now,
          updatedAt: now,
          expiresAt: new Date(Date.now() + PENDING_UPLOAD_TTL_MS).toISOString(),
        };
        await writeJson(path.join(draftRoot, 'draft.json'), draft);
        this.drafts.set(draftId, draft);
        return structuredClone(draft);
      } catch (error) {
        await rm(draftRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async writeUploadFile(draftId: string, filePath: string, body: UploadBody, signal?: AbortSignal): Promise<{ path: string; size: number }> {
    this.requireCurrentDraft(draftId, ['uploading']);
    if (this.uploads.has(draftId)) throw new ImportDraftError('Import draft upload is busy', 409);
    const controller = new AbortController();
    const cancellation = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const done = this.mutate(async () => {
      const draft = this.requireCurrentDraft(draftId, ['uploading']);
      if (Date.parse(draft.expiresAt) <= Date.now()) throw new ImportDraftError('Import draft upload expired', 404);
      const safePath = normalizeUploadPath(filePath);
      const declared = draft.upload?.files.find((file) => file.path === safePath);
      if (!declared) throw new ImportDraftError('Upload file was not declared');
      const target = path.join(this.uploadRoot(draft), ...safePath.split('/'));
      const result = await receiveUpload(target, path.join(this.resolveDraftRoot(draftId), '.uploads'), body, declared, cancellation);
      const updated = { ...draft, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + PENDING_UPLOAD_TTL_MS).toISOString() };
      await writeJson(path.join(this.resolveDraftRoot(draftId), 'draft.json'), updated);
      this.drafts.set(draftId, updated);
      return { path: safePath, size: result.size };
    });
    this.uploads.set(draftId, { controller, done });
    try {
      return await done;
    } finally {
      this.uploads.delete(draftId);
    }
  }

  async completeUpload(draftId: string, expectedRevision: number): Promise<ImportDraftV1> {
    if (this.uploads.has(draftId)) throw new ImportDraftError('Import draft upload is busy', 409);
    return this.mutate(async () => {
      const draft = this.requireDraft(draftId, expectedRevision, ['uploading']);
      if (Date.parse(draft.expiresAt) <= Date.now()) throw new ImportDraftError('Import draft upload expired', 404);
      for (const file of draft.upload?.files ?? []) {
        const metadata = await lstat(path.join(this.uploadRoot(draft), ...file.path.split('/'))).catch(() => null);
        if (!metadata?.isFile() || metadata.isSymbolicLink() || metadata.size !== file.size) {
          throw new ImportDraftError(`Upload is incomplete: ${file.path}`, 409);
        }
      }
      return this.update(draft, 'created', { upload: null });
    });
  }

  async parse(draftId: string, expectedRevision: number): Promise<ImportDraftV1> {
    return this.mutate(async () => {
      const draft = this.requireDraft(draftId, expectedRevision, ['created']);
      const parsed = await parseDesignSource(this.sourcePath(draft));
      const semanticOverlay = createSemanticOverlay(parsed.document);
      await writeJson(path.join(this.resolveDraftRoot(draftId), 'import-document.json'), {
        document: parsed.document,
        imageBindings: parsed.imageBindings,
      });
      await writeJson(path.join(this.resolveDraftRoot(draftId), 'semantic-overlay.json'), semanticOverlay);
      return this.update(draft, 'parsed', {
        source: parsed.source,
        diagnostics: parsed.document.diagnostics,
        semanticOverlay: { revision: 1, mappedNodes: Object.keys(semanticOverlay.nodes).length },
      });
    });
  }

  async updateSemanticDirective(
    draftId: string,
    expectedRevision: number,
    nodeId: string,
    input: SemanticNodeDirective,
  ): Promise<{ draft: ImportDraftV1; semanticOverlay: MakerSemanticOverlayV1 }> {
    return this.mutate(async () => {
      const draft = this.requireDraft(draftId, expectedRevision, ['parsed']);
      const snapshot = await this.readParsedSnapshot(draftId);
      const node = findNode(snapshot.document, nodeId);
      if (!node) throw new ImportDraftError(`Semantic mapping node does not exist: ${nodeId}`);
      const directive = assertSemanticTarget(node, input);
      const semanticOverlay = await this.readSemanticOverlay(draftId, snapshot.document);
      semanticOverlay.nodes[nodeId] = directive;
      await writeJson(path.join(this.resolveDraftRoot(draftId), 'semantic-overlay.json'), semanticOverlay);
      const updated = await this.update(draft, 'parsed', {
        semanticOverlay: {
          revision: (draft.semanticOverlay?.revision ?? 1) + 1,
          mappedNodes: Object.keys(semanticOverlay.nodes).length,
        },
      });
      return { draft: updated, semanticOverlay };
    });
  }

  async plan(draftId: string, expectedRevision: number, rootIds?: string[]): Promise<{ draft: ImportDraftV1; buildPlan: FairyBuildPlanV2 }> {
    return this.mutate(async () => {
      const draft = this.requireDraft(draftId, expectedRevision, ['parsed', 'planned']);
      const snapshot = await this.readParsedSnapshot(draftId);
      const semanticOverlay = await this.readSemanticOverlay(draftId, snapshot.document);
      const buildPlan = planDocument(snapshot.document, { rootIds, semanticOverlay, imageBindings: snapshot.imageBindings });
      await writeJson(path.join(this.resolveDraftRoot(draftId), 'build-plan.json'), buildPlan);
      const updated = await this.update(draft, 'planned', {
        diagnostics: buildPlan.diagnostics,
        buildPlan: {
          schemaVersion: buildPlan.schemaVersion,
          packages: buildPlan.packages.length,
          components: buildPlan.packages.reduce((count, pkg) => count + pkg.components.length, 0),
        },
        semanticOverlay: {
          revision: draft.semanticOverlay?.revision ?? 1,
          mappedNodes: Object.keys(semanticOverlay.nodes).length,
        },
      });
      return { draft: updated, buildPlan };
    });
  }

  async compile(draftId: string, expectedRevision: number): Promise<ImportDraftV1> {
    return this.mutate(async () => {
      const draft = this.requireDraft(draftId, expectedRevision, ['planned']);
      const draftRoot = this.resolveDraftRoot(draftId);
      const snapshot = await this.readParsedSnapshot(draftId);
      const buildPlan = await readJson<FairyBuildPlanV2>(path.join(draftRoot, 'build-plan.json'));
      const converted = compilePlanToUam(snapshot.document, buildPlan, {}, snapshot.imageBindings);
      const ids = sourceNodeIds(snapshot.document, converted.ids);
      const generatedRoot = path.join(draftRoot, 'generated');
      const stagingRoot = path.join(draftRoot, `.generated-${randomUUID()}`);
      try {
        await rm(generatedRoot, { recursive: true, force: true });
        const projectRoot = path.join(stagingRoot, 'project');
        await mkdir(projectRoot, { recursive: true });
        const fairyFile = `${safeName(buildPlan.sourceName)}.fairy`;
        const fairyPath = path.join(projectRoot, fairyFile);
        const io = new NodeIO();
        await writeProjectFromUam(io, converted.project, fairyPath);
        const generatedProject = await readProjectAsUam(io, fairyPath, { hydrateResourceBytes: true });
        assertValidUamProject(generatedProject);
        await writeJson(path.join(stagingRoot, 'uam.json'), converted.project);
        const sourceLocator = await readJson<unknown>(path.join(draftRoot, SOURCE_LOCATOR))
          .then((value) => sourceLocatorSchema.parse(value), (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
        const semanticOverlay = buildPlan.semanticOverlay;
        await writeMakerImportStateV2({
          projectRoot,
          fairyFile,
          source: draft.source!,
          ...(sourceLocator ? { sourcePath: sourceLocator.path } : {}),
          document: snapshot.document,
          project: generatedProject,
          makerVersion: MAKER_VERSION,
          profile: { buildPlan: buildPlan.profile, semantic: semanticOverlay.profile },
          semanticOverlay,
          conversionIds: converted.ids,
        });
        await rename(stagingRoot, generatedRoot);
        return this.update(draft, 'compiled', {
          diagnostics: converted.diagnostics,
          generated: {
            fairyFile,
            projectId: converted.project.projectId,
            ids,
            report: converted.report,
          },
        });
      } catch (error) {
        await rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    });
  }

  async materialize(draftId: string, expectedRevision: number, outputPath: string): Promise<{ draft: ImportDraftV1; result: DesignImportResult }> {
    return this.mutate(async () => {
      const draft = this.requireDraft(draftId, expectedRevision, ['compiled']);
      if (!draft.source || !draft.generated) throw new ImportDraftError('Import draft is incomplete', 409);
      const outputDirectory = path.resolve(outputPath);
      if (!path.basename(outputDirectory)) throw new ImportDraftError('Materialize target must be a named directory');
      if (await lstat(outputDirectory).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      })) throw new ImportDraftError('Materialize target already exists (EEXIST)', 409);

      const temporary = path.join(path.dirname(outputDirectory), `.${path.basename(outputDirectory)}.maker-${randomUUID()}`);
      try {
        await copyRegularDirectory(path.join(this.resolveDraftRoot(draftId), 'generated', 'project'), temporary);
        assertValidUamProject(await readProjectAsUam(
          new NodeIO(),
          path.join(temporary, draft.generated.fairyFile),
          { hydrateResourceBytes: true },
        ));
        await rename(temporary, outputDirectory);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }

      const at = new Date().toISOString();
      const updated = await this.update(draft, 'materialized', {
        materialized: { outputDirectory, at },
      });
      return {
        draft: updated,
        result: {
          source: draft.source,
          outputDirectory,
          fairyPath: path.join(outputDirectory, draft.generated.fairyFile),
          statePath: path.join(outputDirectory, MAKER_IMPORT_STATE),
          projectId: draft.generated.projectId,
          ids: draft.generated.ids,
          report: draft.generated.report,
        },
      };
    });
  }

  async delete(draftId: string, expectedRevision: number): Promise<void> {
    this.requireDraft(draftId, expectedRevision);
    this.uploads.get(draftId)?.controller.abort(new UploadError('import_draft_upload_cancelled', 409));
    return this.mutate(async () => {
      this.requireDraft(draftId, expectedRevision);
      await rm(this.resolveDraftRoot(draftId), { recursive: true, force: true });
      this.drafts.delete(draftId);
    });
  }

  async pruneExpiredUploads(): Promise<void> {
    for (const draft of this.drafts.values()) {
      if (draft.status === 'uploading' && Date.parse(draft.expiresAt) <= Date.now()) await this.delete(draft.draftId, draft.revision);
    }
  }

  async close(): Promise<void> {
    const uploads = [...this.uploads.values()];
    for (const upload of uploads) upload.controller.abort();
    await Promise.allSettled(uploads.map((upload) => upload.done));
  }

  async saveVisualEvidence(
    draftId: string,
    expectedRevision: number,
    input: ImportVisualEvidenceInput,
    images: { reference: Uint8Array; capture: Uint8Array; diff: Uint8Array },
  ): Promise<ImportDraftV1> {
    return this.mutate(async () => {
      const draft = this.requireDraft(draftId, expectedRevision, ['compiled', 'materialized']);
      const dimensions = {
        reference: pngDimensions(images.reference),
        capture: pngDimensions(images.capture),
        diff: pngDimensions(images.diff),
      };
      for (const [name, data] of Object.entries(images)) {
        if (data.byteLength > MAX_VISUAL_EVIDENCE_BYTES) throw new ImportDraftError(`${name} PNG exceeds the 16 MiB limit`);
      }
      if (dimensions.reference.width !== input.reference.width || dimensions.reference.height !== input.reference.height
        || dimensions.capture.width !== input.capture.width || dimensions.capture.height !== input.capture.height
        || dimensions.diff.width !== input.comparison.width || dimensions.diff.height !== input.comparison.height) {
        throw new ImportDraftError('Visual evidence dimensions do not match the PNG files');
      }
      if (input.comparison.width !== Math.max(input.reference.width, input.capture.width)
        || input.comparison.height !== Math.max(input.reference.height, input.capture.height)
        || input.comparison.totalPixels !== input.comparison.width * input.comparison.height
        || input.comparison.differentPixels > input.comparison.totalPixels) {
        throw new ImportDraftError('Visual evidence comparison metrics are inconsistent');
      }

      const evidence = visualEvidenceSchema.parse({ ...input, createdAt: new Date().toISOString() }) as ImportVisualEvidenceV1;
      const root = this.resolveDraftRoot(draftId);
      const target = path.join(root, 'visual-evidence');
      const staging = path.join(root, `.visual-evidence-${randomUUID()}`);
      try {
        await mkdir(staging);
        await Promise.all([
          writeFile(path.join(staging, 'reference.png'), images.reference, { flag: 'wx' }),
          writeFile(path.join(staging, 'capture.png'), images.capture, { flag: 'wx' }),
          writeFile(path.join(staging, 'diff.png'), images.diff, { flag: 'wx' }),
          writeJson(path.join(staging, 'report.json'), evidence),
        ]);
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
        return this.update(draft, draft.status, { visualEvidence: evidence });
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    });
  }

  async readVisualEvidenceImage(draftId: string, image: 'reference' | 'capture' | 'diff'): Promise<Uint8Array> {
    const draft = this.requireCurrentDraft(draftId);
    if (!draft.visualEvidence) throw new ImportDraftError('Visual evidence not found', 404);
    return readFile(path.join(this.resolveDraftRoot(draftId), 'visual-evidence', `${image}.png`));
  }

  getGeneratedProjectPath(draftId: string): string | null {
    const draft = this.requireCurrentDraft(draftId);
    return draft.generated ? path.join(this.resolveDraftRoot(draftId), 'generated', 'project') : null;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation);
    this.mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private requireDraft(draftId: string, expectedRevision: number, statuses?: ImportDraftStatus[]): ImportDraftV1 {
    const draft = this.requireCurrentDraft(draftId, statuses);
    if (draft.revision !== expectedRevision) throw new ImportDraftError(`Import draft revision is ${draft.revision}`, 409);
    return draft;
  }

  private requireCurrentDraft(draftId: string, statuses?: ImportDraftStatus[]): ImportDraftV1 {
    if (!draftIdPattern.test(draftId)) throw new ImportDraftError('Invalid import draft ID');
    const draft = this.drafts.get(draftId);
    if (!draft) throw new ImportDraftError('Import draft not found', 404);
    if (statuses && !statuses.includes(draft.status)) {
      throw new ImportDraftError(`Import draft cannot advance from ${draft.status}`, 409);
    }
    return draft;
  }

  private async update(
    draft: ImportDraftV1,
    status: ImportDraftStatus,
    patch: Partial<Pick<ImportDraftV1, 'upload' | 'semanticOverlay' | 'source' | 'diagnostics' | 'buildPlan' | 'generated' | 'visualEvidence' | 'materialized'>>,
  ): Promise<ImportDraftV1> {
    const updatedAt = new Date().toISOString();
    const updated: ImportDraftV1 = {
      ...draft,
      ...patch,
      status,
      revision: draft.revision + 1,
      updatedAt,
      expiresAt: new Date(Date.now() + IMPORT_DRAFT_TTL_MS).toISOString(),
    };
    await writeJson(path.join(this.resolveDraftRoot(draft.draftId), 'draft.json'), updated);
    this.drafts.set(draft.draftId, updated);
    return structuredClone(updated);
  }

  private async readParsedSnapshot(draftId: string): Promise<ParsedSnapshot> {
    return readJson<ParsedSnapshot>(path.join(this.resolveDraftRoot(draftId), 'import-document.json'));
  }

  private async readSemanticOverlay(draftId: string, document: ImportDocument): Promise<MakerSemanticOverlayV1> {
    try {
      return validateSemanticOverlay(document, await readJson<MakerSemanticOverlayV1>(
        path.join(this.resolveDraftRoot(draftId), 'semantic-overlay.json'),
      ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return createSemanticOverlay(document);
    }
  }

  private sourcePath(draft: ImportDraftV1): string {
    return path.join(this.resolveDraftRoot(draft.draftId), 'source', draft.input.kind === 'bundle' ? 'bundle' : draft.input.name);
  }

  private uploadRoot(draft: ImportDraftV1): string {
    return path.join(this.resolveDraftRoot(draft.draftId), 'source', ...(draft.input.kind === 'bundle' ? ['bundle'] : []));
  }

  private resolveDraftRoot(draftId: string): string {
    if (!draftIdPattern.test(draftId)) throw new ImportDraftError('Invalid import draft ID');
    const target = path.resolve(this.root, draftId);
    if (!target.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new ImportDraftError('Import draft path escapes its store');
    return target;
  }
}

function pngDimensions(data: Uint8Array) {
  if (data.byteLength < 24 || Buffer.from(data.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a'
    || Buffer.from(data.subarray(12, 16)).toString('ascii') !== 'IHDR') {
    throw new ImportDraftError('Visual evidence must be a valid PNG');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (!width || !height || width > 8_192 || height > 8_192 || width * height > 32_000_000) {
    throw new ImportDraftError('Visual evidence PNG dimensions are unsupported');
  }
  return { width, height };
}

function normalizeUploadPath(value: string): string {
  if (!value || value.includes('\\') || value.startsWith('/') || /[\0:]/.test(value)
    || value.split('/').some((part) => /[. ]$/.test(part))) {
    throw new ImportDraftError('Upload path must be a safe relative path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '..' || normalized.startsWith('../')) {
    throw new ImportDraftError('Upload path escapes its draft');
  }
  return normalized;
}

function outlineDocument(document: ImportDocument): ImportDraftOutline {
  const outlineNode = (node: ImportNode): ImportDraftOutlineNode => ({
    id: node.id,
    name: node.name,
    kind: node.kind,
    width: node.width,
    height: node.height,
    ...(node.kind === 'frame' ? { children: node.children.map(outlineNode) } : {}),
  });
  return {
    name: document.name,
    pages: document.pages.map((page) => ({
      id: page.id,
      name: page.name,
      roots: page.roots.map(outlineNode),
    })),
  };
}

function findNode(document: ImportDocument, nodeId: string): ImportNode | null {
  let found: ImportNode | null = null;
  const visit = (node: ImportNode): void => {
    if (node.id === nodeId) found = node;
    else if (!found && node.kind === 'frame') node.children.forEach(visit);
  };
  document.pages.forEach((page) => page.roots.forEach(visit));
  return found;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, (_key, item) => (
      item instanceof Uint8Array ? { $uint8: Buffer.from(item).toString('base64') } : item
    ), 2)}\n`, { flag: 'wx' });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8'), (_key, item) => (
    item && typeof item === 'object' && Object.keys(item).length === 1 && typeof item.$uint8 === 'string'
      ? Uint8Array.from(Buffer.from(item.$uint8, 'base64'))
      : item
  )) as T;
}

async function copyRegularDirectory(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: false });
  for (const entry of (await readdir(source, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) throw new Error(`Generated import project contains a symbolic link: ${entry.name}`);
    if (metadata.isDirectory()) await copyRegularDirectory(sourcePath, targetPath);
    else if (metadata.isFile()) await copyFile(sourcePath, targetPath);
    else throw new Error(`Generated import project contains an unsupported entry: ${entry.name}`);
  }
}
