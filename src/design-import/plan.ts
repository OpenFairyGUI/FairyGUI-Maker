import { createHash } from 'node:crypto';
import { z } from 'zod';

import { canonicalJson } from './bundle';
import type { Diagnostic, ImportDocument, ImportNode } from './model';
import { analyzeImportFidelity, requestedRaster, supportsRasterization } from './fidelity';
import {
  createSemanticOverlay,
  semanticOverlaySchema,
  stripSemanticName,
  validateSemanticOverlay,
  type MakerSemanticOverlayV1,
} from './semantic-overlay';

export const FAIRY_BUILD_PLAN_VERSION = 2 as const;
export const FAIRY_PLANNER_VERSION = 'deterministic-v2' as const;
export const FAIRY_COMPILER_VERSION = 'deterministic-v3' as const;
export const IMPORT_DOCUMENT_SCHEMA_VERSION = 1 as const;

export interface ConversionImageBinding {
  pixelRatio: number;
  trimOffset: { x: number; y: number };
  scale9Grid: { x: number; y: number; width: number; height: number } | null;
  pixelSize: { width: number; height: number };
}

export interface FairyBuildPlanV2 {
  schemaVersion: typeof FAIRY_BUILD_PLAN_VERSION;
  sourceSchemaVersion: typeof IMPORT_DOCUMENT_SCHEMA_VERSION;
  plannerVersion: typeof FAIRY_PLANNER_VERSION;
  compilerVersion: typeof FAIRY_COMPILER_VERSION;
  sourceDocumentId: string;
  sourceDigest: string;
  profile: 'legacy-hybrid';
  sourceName: string;
  semanticOverlay: MakerSemanticOverlayV1;
  packages: Array<{
    sourcePageId: string;
    key: string;
    name: string;
    components: Array<{
      sourceNodeId: string;
      key: string;
      name: string;
      exported: boolean;
    }>;
  }>;
  diagnostics: Diagnostic[];
}

const sourceIdSchema = z.string().min(1).max(1_024);
const nameSchema = z.string().min(1).max(1_024);
const imageBindingsSchema = z.record(sourceIdSchema, z.object({
  pixelRatio: z.number().finite().positive(),
  trimOffset: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  pixelSize: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  scale9Grid: z.object({
    x: z.number().finite(), y: z.number().finite(),
    width: z.number().finite().positive(), height: z.number().finite().positive(),
  }).strict().nullable(),
}).strict());
const diagnosticSchema = z.object({
  code: z.string().min(1), message: z.string(), nodeId: z.string(),
  severity: z.enum(['warning', 'error']),
  nodeName: z.string().optional(), nodeType: z.string().optional(),
  pageId: z.string().optional(), pageName: z.string().optional(),
  rootId: z.string().optional(), rootName: z.string().optional(),
}).strict();

export const fairyBuildPlanSchema = z.object({
  schemaVersion: z.literal(FAIRY_BUILD_PLAN_VERSION),
  sourceSchemaVersion: z.literal(IMPORT_DOCUMENT_SCHEMA_VERSION),
  plannerVersion: z.literal(FAIRY_PLANNER_VERSION),
  compilerVersion: z.literal(FAIRY_COMPILER_VERSION),
  sourceDocumentId: nameSchema,
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  profile: z.literal('legacy-hybrid'),
  sourceName: nameSchema,
  semanticOverlay: semanticOverlaySchema,
  packages: z.array(z.object({
    sourcePageId: sourceIdSchema,
    key: z.string().min(1).max(2_048),
    name: nameSchema,
    components: z.array(z.object({
      sourceNodeId: sourceIdSchema,
      key: z.string().min(1).max(2_048),
      name: nameSchema,
      exported: z.boolean(),
    }).strict()).max(100_000),
  }).strict()).min(1).max(10_000),
  diagnostics: z.array(diagnosticSchema).max(100_000),
}).strict();

// The Host/CLI compiler stays synchronous; hash binary assets without expanding them into JSON arrays.
function sourceDigest(document: ImportDocument, imageBindings: Record<string, ConversionImageBinding>): string {
  const nodeValue = (node: ImportNode): unknown => node.kind === 'frame'
    ? { ...node, children: node.children.map(nodeValue) }
    : node.kind === 'image'
      ? { ...node, bytes: { sha256: createHash('sha256').update(node.bytes).digest('hex'), byteLength: node.bytes.byteLength } }
      : node;
  return createHash('sha256').update(JSON.stringify(canonicalJson({
    sourceSchemaVersion: IMPORT_DOCUMENT_SCHEMA_VERSION,
    document: { ...document, pages: document.pages.map((page) => ({ ...page, roots: page.roots.map(nodeValue) })) },
    imageBindings,
  }))).digest('hex');
}

export function planDocument(
  document: ImportDocument,
  options: {
    rootIds?: string[];
    semanticOverlay?: MakerSemanticOverlayV1;
    imageBindings?: Record<string, ConversionImageBinding>;
  } = {},
): FairyBuildPlanV2 {
  const overlay = validateSemanticOverlay(document, options.semanticOverlay ?? createSemanticOverlay(document));
  const imageBindings = imageBindingsSchema.parse(options.imageBindings ?? {});
  const roots = document.pages.flatMap((page) => page.roots);
  const rootsById = new Map(roots.map((root) => [root.id, root]));
  const ownerByNodeId = new Map<string, string>();
  const nodesById = new Map<string, ImportNode>();
  const ignored = new Set<string>();
  if (new Set(document.pages.map((page) => page.id)).size !== document.pages.length) {
    throw new Error('Build plan source contains duplicate page IDs');
  }
  for (const root of roots) {
    const visit = (node: ImportNode, parentIgnored = false): void => {
      if (nodesById.has(node.id)) throw new Error(`Build plan source contains duplicate node ID ${node.id}`);
      ownerByNodeId.set(node.id, root.id);
      nodesById.set(node.id, node);
      const isIgnored = parentIgnored || overlay.nodes[node.id]?.target === 'ignore'
        || overlay.profile.unsupportedNode === 'skip' && requestedRaster(overlay.nodes[node.id])
          && !supportsRasterization(node);
      if (isIgnored) ignored.add(node.id);
      if (node.kind === 'frame') node.children.forEach((child) => visit(child, isIgnored));
    };
    visit(root);
  }
  for (const nodeId of Object.keys(imageBindings)) {
    if (nodesById.get(nodeId)?.kind !== 'image') throw new Error(`Image binding references missing image node ${nodeId}`);
  }

  const selectedRootIds = options.rootIds ?? roots.map((root) => root.id);
  const missing = selectedRootIds.find((id) => !rootsById.has(id));
  if (missing) throw new Error(`Build plan root does not exist: ${missing}`);
  const requested = new Set(selectedRootIds.filter((id) => !ignored.has(id)));
  if (requested.size === 0) {
    throw new Error('Build plan must include at least one root frame');
  }

  const included = new Set(requested);
  const pending = [...requested];
  const dependencyDiagnostics: Diagnostic[] = [];
  while (pending.length > 0) {
    const root = rootsById.get(pending.shift()!)!;
    const visit = (node: ImportNode): void => {
      if (ignored.has(node.id)) return;
      if (node.kind === 'instance') {
        const mapped = overlay.componentLibrary?.[overlay.nodes[node.id]?.componentKey ?? ''];
        for (const componentId of new Set([mapped ?? node.componentId, ...node.overrides.map((override) => override.componentId)])) {
          if (!componentId) continue;
          const ownerId = ownerByNodeId.get(componentId);
          const component = nodesById.get(componentId);
          if (!ownerId || component?.kind !== 'frame' || component.sourceType !== 'component' || ignored.has(componentId)) {
            dependencyDiagnostics.push({
              code: 'PLAN_COMPONENT_DEPENDENCY_MISSING',
              message: `Instance references missing or ignored Component ${componentId}`,
              nodeId: node.id,
              severity: 'error',
            });
            continue;
          }
          if (ownerId && !included.has(ownerId)) {
            included.add(ownerId);
            pending.push(ownerId);
          }
        }
      }
      if (node.kind === 'frame') node.children.forEach(visit);
    };
    visit(root);
  }

  const includedNodeIds = new Set<string>();
  for (const rootId of included) {
    const visit = (node: ImportNode): void => {
      includedNodeIds.add(node.id);
      if (node.kind === 'frame') node.children.forEach(visit);
    };
    visit(rootsById.get(rootId)!);
  }
  // Check the effective containment/reference graph without recursive component expansion.
  const edges = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const id of includedNodeIds) if (!ignored.has(id)) incoming.set(id, 0);
  for (const id of incoming.keys()) {
    const node = nodesById.get(id)!;
    const targets = node.kind === 'frame' ? node.children.map((child) => child.id)
      : node.kind === 'instance' ? [overlay.componentLibrary?.[overlay.nodes[id]?.componentKey ?? ''] ?? node.componentId,
        ...node.overrides.map((override) => override.componentId)] : [];
    const dependencies = [...new Set(targets.filter((target): target is string => !!target && incoming.has(target)))];
    edges.set(id, dependencies);
    for (const target of dependencies) incoming.set(target, incoming.get(target)! + 1);
  }
  const queue = [...incoming.keys()].filter((id) => incoming.get(id) === 0);
  for (let index = 0; index < queue.length; index++) for (const target of edges.get(queue[index])!) {
    incoming.set(target, incoming.get(target)! - 1);
    if (incoming.get(target) === 0) queue.push(target);
  }
  if (queue.length !== incoming.size) dependencyDiagnostics.push({ code: 'SEMANTIC_COMPONENT_CYCLE',
    nodeId: [...incoming.keys()].find((id) => incoming.get(id)! > 0)!, severity: 'error',
    message: 'Component references, including library mappings, must not form a cycle.' });
  // Keep document-level diagnostics even when only some roots are selected.
  const sourceDiagnostics = document.diagnostics.filter((diagnostic) =>
    includedNodeIds.has(diagnostic.nodeId) || !nodesById.has(diagnostic.nodeId));
  const { diagnostics: semanticDiagnostics } = analyzeImportFidelity({ ...document,
    pages: document.pages.map((page) => ({ ...page, roots: page.roots.filter((root) => included.has(root.id)) })),
  }, overlay);

  return {
    schemaVersion: FAIRY_BUILD_PLAN_VERSION,
    sourceSchemaVersion: IMPORT_DOCUMENT_SCHEMA_VERSION,
    plannerVersion: FAIRY_PLANNER_VERSION,
    compilerVersion: FAIRY_COMPILER_VERSION,
    // ponytail: ImportDocument currently uses its name as identity; add adapter-owned IDs for cross-file namespaces.
    sourceDocumentId: document.name,
    sourceDigest: sourceDigest(document, imageBindings),
    profile: 'legacy-hybrid',
    sourceName: stripSemanticName(document.name),
    semanticOverlay: canonicalJson({
      ...overlay,
      nodes: Object.fromEntries(Object.entries(overlay.nodes).filter(([nodeId]) => includedNodeIds.has(nodeId))),
    }) as MakerSemanticOverlayV1,
    packages: document.pages.map((page) => ({
      sourcePageId: page.id,
      key: document.pages.length === 1 ? '$package' : `$package:${page.id}`,
      name: stripSemanticName(page.name),
      components: page.roots.filter((root) => included.has(root.id)).map((root) => ({
        sourceNodeId: root.id,
        key: `${root.id}:resource`,
        name: stripSemanticName(root.name),
        exported: requested.has(root.id),
      })),
    })).filter((pkg) => options.rootIds === undefined || pkg.components.length > 0),
    diagnostics: (canonicalJson([...sourceDiagnostics, ...semanticDiagnostics, ...dependencyDiagnostics]) as Diagnostic[])
      .sort((left, right) => {
        const a = JSON.stringify(left);
        const b = JSON.stringify(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }),
  };
}

export function validateBuildPlan(
  document: ImportDocument,
  input: unknown,
  imageBindings: Record<string, ConversionImageBinding>,
): FairyBuildPlanV2 {
  const parsed = fairyBuildPlanSchema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid or outdated FairyBuildPlan; run Plan again: ${parsed.error.message}`);
  const plan = parsed.data as FairyBuildPlanV2;
  const expected = planDocument(document, {
    rootIds: plan.packages.flatMap((pkg) => pkg.components.map((component) => component.sourceNodeId)),
    semanticOverlay: plan.semanticOverlay,
    imageBindings,
  });
  if (plan.sourceDocumentId !== expected.sourceDocumentId || plan.sourceDigest !== expected.sourceDigest) {
    throw new Error('FairyBuildPlan source digest mismatch; run Plan again');
  }
  const seenPages = new Set<string>();
  const seenRoots = new Set<string>();
  const sourcePages = new Map(document.pages.map((page) => [page.id, page]));
  for (const pkg of plan.packages) {
    const page = sourcePages.get(pkg.sourcePageId);
    const key = document.pages.length === 1 ? '$package' : `$package:${pkg.sourcePageId}`;
    if (!page || seenPages.has(page.id) || pkg.key !== key) {
      throw new Error('FairyBuildPlan contains invalid/duplicate page IDs or reserved package keys');
    }
    seenPages.add(page.id);
    const rootIds = new Set(page.roots.map((root) => root.id));
    for (const component of pkg.components) {
      if (!rootIds.has(component.sourceNodeId) || seenRoots.has(component.sourceNodeId)
        || component.key !== `${component.sourceNodeId}:resource`) {
        throw new Error('FairyBuildPlan contains invalid/duplicate root IDs or reserved component keys');
      }
      seenRoots.add(component.sourceNodeId);
    }
  }
  if (expected.packages.some((pkg) => pkg.components.some((component) => !seenRoots.has(component.sourceNodeId)))) {
    throw new Error('PLAN_COMPONENT_DEPENDENCY_MISSING: Build plan omits a required Component root');
  }
  const missingDependency = expected.diagnostics.find((diagnostic) => diagnostic.code === 'PLAN_COMPONENT_DEPENDENCY_MISSING');
  if (missingDependency) throw new Error(`${missingDependency.code}: ${missingDependency.message}`);
  const policyError = expected.diagnostics.find((diagnostic) => diagnostic.severity === 'error' && diagnostic.code.startsWith('SEMANTIC_'));
  if (policyError) throw new Error(`${policyError.code}: ${policyError.message}`);
  if (expected.packages.reduce((count, pkg) => count + pkg.components.length, 0) !== seenRoots.size) {
    throw new Error('FairyBuildPlan includes an ignored root');
  }
  // Plan diagnostics are a display-only snapshot, never an authority over parser/compiler evidence.
  return { ...plan, diagnostics: expected.diagnostics };
}
