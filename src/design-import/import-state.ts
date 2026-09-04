import type { UamDisplayNode, UamProject, UamResource } from '@openfairygui/core/uam';
import { z } from 'zod';

import { makerImportSha256, type MakerImportSourceV1 } from './bundle';
import type { ImportDocument, ImportNode } from './model';
import { FAIRY_COMPILER_VERSION, FAIRY_PLANNER_VERSION } from './plan';
import { semanticOverlaySchema, type MakerSemanticOverlayV1 } from './semantic-overlay';

export const MAKER_IMPORT_STATE_VERSION = 2 as const;
export const MAKER_IMPORT_SNAPSHOT_DIRECTORY = '.maker-import';
export const MAKER_IMPORT_GENERATED_SNAPSHOT = `${MAKER_IMPORT_SNAPSHOT_DIRECTORY}/generated-snapshot.json`;
export const MAKER_IMPORT_GENERATED_SNAPSHOT_VERSION = 2 as const;

export const IMPORT_TARGET_ROLES = [
  'resource',
  'component',
  'display-node',
  'controller-page',
  'shadow',
  'layout-group',
  'override-clone',
] as const;

export type ImportTargetRole = typeof IMPORT_TARGET_ROLES[number];

export interface MakerImportTargetV2 {
  role: ImportTargetRole;
  packageId: string;
  resourceId?: string;
  displayNodeId?: string;
  controllerName?: string;
  pageId?: string;
}

export interface MakerImportSourceNodeV2 {
  name: string;
  kind: ImportNode['kind'];
  fingerprint: string;
  targets: MakerImportTargetV2[];
  sourceOwnedFields: string[];
  userOwnedFields: string[];
}

export interface MakerImportStateV2 {
  schemaVersion: typeof MAKER_IMPORT_STATE_VERSION;
  source: MakerImportSourceV1 & {
    documentId: string;
    path?: string;
  };
  compiler: {
    makerVersion: string;
    compilerVersion?: string;
    plannerVersion?: string;
    profileDigest: string;
    overlayDigest: string;
    conversionIds: Record<string, string>;
  };
  project: {
    fairyFile: string;
    projectId: string;
  };
  sourceNodes: Record<string, MakerImportSourceNodeV2>;
  generatedSnapshotDigest: string;
  generatedSnapshotPath: typeof MAKER_IMPORT_GENERATED_SNAPSHOT;
}

export interface MakerImportGeneratedSnapshotV2 {
  schemaVersion: typeof MAKER_IMPORT_GENERATED_SNAPSHOT_VERSION;
  project: UamProject;
  semanticOverlay: MakerSemanticOverlayV1;
}

export type ReimportChangeReason =
  | 'source-added'
  | 'source-changed'
  | 'source-removed'
  | 'source-removed-target-absent'
  | 'unchanged'
  | 'user-change-preserved'
  | 'source-and-project-changed'
  | 'source-removed-project-changed'
  | 'semantic-mapping-invalid';

export interface ReimportPlanEntryV1 {
  sourceNodeId: string;
  name: string;
  kind: ImportNode['kind'];
  targets: MakerImportTargetV2[];
  reason: ReimportChangeReason;
}

export interface ReimportPlanV1 {
  schemaVersion: 1;
  projectDirectory: string;
  source: {
    path: string;
    previousSha256: string;
    currentSha256: string;
  };
  added: ReimportPlanEntryV1[];
  changed: ReimportPlanEntryV1[];
  removed: ReimportPlanEntryV1[];
  preserved: ReimportPlanEntryV1[];
  conflict: ReimportPlanEntryV1[];
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const fairyIdSchema = z.string().regex(/^[a-z0-9]{8}$/);
const targetSchema = z.object({
  role: z.enum(IMPORT_TARGET_ROLES),
  packageId: fairyIdSchema,
  resourceId: fairyIdSchema.optional(),
  displayNodeId: fairyIdSchema.optional(),
  controllerName: z.string().min(1).max(128).optional(),
  pageId: fairyIdSchema.optional(),
}).strict().superRefine((target, context) => {
  if (!target.resourceId) {
    context.addIssue({ code: 'custom', path: ['resourceId'], message: 'Import target requires a resource ID' });
  }
  if (['display-node', 'shadow', 'layout-group'].includes(target.role) && !target.displayNodeId) {
    context.addIssue({ code: 'custom', path: ['displayNodeId'], message: 'Display target requires a display node ID' });
  }
  if (target.role === 'controller-page' && (!target.controllerName || !target.pageId)) {
    context.addIssue({ code: 'custom', path: ['controllerName'], message: 'Controller page target requires controller and page IDs' });
  }
});
const sourceNodeSchema = z.object({
  name: z.string().max(1_024),
  kind: z.enum(['frame', 'instance', 'text', 'shape', 'image']),
  fingerprint: sha256Schema,
  targets: z.array(targetSchema),
  sourceOwnedFields: z.array(z.string().min(1)),
  userOwnedFields: z.array(z.string().min(1)),
}).strict();

export const makerImportStateV2Schema = z.object({
  schemaVersion: z.literal(MAKER_IMPORT_STATE_VERSION),
  source: z.object({
    kind: z.enum(['fig', 'psd', 'figma-rest', 'raster']),
    name: z.string().min(1).max(255),
    sha256: sha256Schema,
    documentId: z.string().min(1).max(1_024),
    path: z.string().min(1).max(32_768).optional(),
  }).strict(),
  compiler: z.object({
    makerVersion: z.string().min(1).max(128),
    compilerVersion: z.string().min(1).max(128).optional(),
    plannerVersion: z.string().min(1).max(128).optional(),
    profileDigest: sha256Schema,
    overlayDigest: sha256Schema,
    conversionIds: z.record(z.string().min(1), fairyIdSchema),
  }).strict(),
  project: z.object({
    fairyFile: z.string().min(7).max(255).regex(/^[^/\\]+\.fairy$/i),
    projectId: fairyIdSchema,
  }).strict(),
  sourceNodes: z.record(z.string().min(1).max(1_024), sourceNodeSchema),
  generatedSnapshotDigest: sha256Schema,
  generatedSnapshotPath: z.literal(MAKER_IMPORT_GENERATED_SNAPSHOT),
}).strict();

export function parseMakerImportStateV2(input: unknown): MakerImportStateV2 {
  return makerImportStateV2Schema.parse(input) as MakerImportStateV2;
}

export function parseMakerImportGeneratedSnapshotV2(input: unknown): MakerImportGeneratedSnapshotV2 {
  const snapshot = z.object({
    schemaVersion: z.literal(MAKER_IMPORT_GENERATED_SNAPSHOT_VERSION),
    project: z.unknown(),
    semanticOverlay: semanticOverlaySchema,
  }).strict().parse(input);
  return snapshot as MakerImportGeneratedSnapshotV2;
}

export async function digestImportValue(value: unknown): Promise<string> {
  return makerImportSha256(new TextEncoder().encode(JSON.stringify(canonicalValue(value))));
}

export async function createMakerImportStateV2(input: {
  source: MakerImportSourceV1;
  sourcePath?: string;
  document: ImportDocument;
  project: UamProject;
  fairyFile: string;
  makerVersion: string;
  profile: unknown;
  semanticOverlay: MakerSemanticOverlayV1;
  conversionIds: Record<string, string>;
  generatedSnapshotDigest: string;
}): Promise<MakerImportStateV2> {
  return parseMakerImportStateV2({
    schemaVersion: MAKER_IMPORT_STATE_VERSION,
    source: {
      ...input.source,
      documentId: input.document.name,
      ...(input.sourcePath ? { path: input.sourcePath } : {}),
    },
    compiler: {
      makerVersion: input.makerVersion,
      compilerVersion: FAIRY_COMPILER_VERSION,
      plannerVersion: FAIRY_PLANNER_VERSION,
      profileDigest: await digestImportValue(input.profile),
      overlayDigest: await digestImportValue(input.semanticOverlay),
      conversionIds: sortRecord(input.conversionIds),
    },
    project: { fairyFile: input.fairyFile, projectId: input.project.projectId },
    sourceNodes: await createSourceNodeRecords(input.document, indexProject(input.project), input.conversionIds),
    generatedSnapshotDigest: input.generatedSnapshotDigest,
    generatedSnapshotPath: MAKER_IMPORT_GENERATED_SNAPSHOT,
  });
}

export async function createReimportPlanV1(input: {
  projectDirectory: string;
  sourcePath: string;
  state: MakerImportStateV2;
  previousProject: UamProject;
  currentProject: UamProject;
  currentSource: MakerImportSourceV1;
  currentDocument: ImportDocument;
  proposedProject: UamProject;
  proposedIds: Record<string, string>;
  semanticConflicts?: Set<string>;
}): Promise<ReimportPlanV1> {
  const previousProject = indexProject(input.previousProject);
  const currentProject = indexProject(input.currentProject);
  const proposedProject = indexProject(input.proposedProject);
  const currentNodes = await createSourceNodeRecords(input.currentDocument, proposedProject, input.proposedIds);
  const added: ReimportPlanEntryV1[] = [];
  const changed: ReimportPlanEntryV1[] = [];
  const removed: ReimportPlanEntryV1[] = [];
  const preserved: ReimportPlanEntryV1[] = [];
  const conflict: ReimportPlanEntryV1[] = [];
  const nodeIds = new Set([...Object.keys(input.state.sourceNodes), ...Object.keys(currentNodes)]);

  for (const sourceNodeId of [...nodeIds].sort(compareText)) {
    const previous = input.state.sourceNodes[sourceNodeId];
    const current = currentNodes[sourceNodeId];
    if (!previous && current) {
      added.push(entry(sourceNodeId, current, 'source-added'));
      continue;
    }
    if (!previous) continue;

    if (!current) {
      const baseline = await targetState(previousProject, previous.targets, true);
      const project = await targetState(currentProject, previous.targets, true);
      const projectChanged = baseline.fingerprint !== project.fingerprint;
      if (projectChanged && !project.allMissing) {
        conflict.push(entry(sourceNodeId, previous, 'source-removed-project-changed'));
      } else {
        removed.push(entry(sourceNodeId, previous, project.allMissing ? 'source-removed-target-absent' : 'source-removed'));
      }
      continue;
    }

    const projectSourceChanges = await changedTargetPaths(previousProject, currentProject, previous.targets, previous.targets);
    const projectChanged = (await changedTargetPaths(previousProject, currentProject, previous.targets, previous.targets, true)).size > 0;
    const sourceTargetChanges = await changedTargetPaths(previousProject, proposedProject, previous.targets, current.targets);

    if (input.semanticConflicts?.has(sourceNodeId)) {
      conflict.push(entry(sourceNodeId, current, 'semantic-mapping-invalid'));
    } else if (previous.fingerprint !== current.fingerprint && pathsOverlap(sourceTargetChanges, projectSourceChanges)) {
      conflict.push(entry(sourceNodeId, current, 'source-and-project-changed'));
    } else if (previous.fingerprint !== current.fingerprint) {
      changed.push(entry(sourceNodeId, current, 'source-changed'));
    } else {
      preserved.push(entry(sourceNodeId, current, projectChanged ? 'user-change-preserved' : 'unchanged'));
    }
  }

  return {
    schemaVersion: 1,
    projectDirectory: input.projectDirectory,
    source: {
      path: input.sourcePath,
      previousSha256: input.state.source.sha256,
      currentSha256: input.currentSource.sha256,
    },
    added,
    changed,
    removed,
    preserved,
    conflict,
  };
}

async function createSourceNodeRecords(
  document: ImportDocument,
  project: ProjectIndex,
  conversionIds: Record<string, string>,
): Promise<Record<string, MakerImportSourceNodeV2>> {
  const records: Array<[string, MakerImportSourceNodeV2]> = [];
  const visit = async (node: ImportNode): Promise<void> => {
    const targets = targetsForNode(node.id, project, conversionIds);
    records.push([node.id, {
      name: node.name,
      kind: node.kind,
      fingerprint: await sourceNodeFingerprint(node),
      targets,
      sourceOwnedFields: sourceOwnedFields(targets),
      userOwnedFields: userOwnedFields(targets),
    }]);
    if (node.kind === 'frame') {
      for (const child of node.children) await visit(child);
    }
  };
  for (const page of document.pages) {
    for (const root of page.roots) await visit(root);
  }
  return Object.fromEntries(records.sort(([left], [right]) => compareText(left, right)));
}

async function sourceNodeFingerprint(node: ImportNode): Promise<string> {
  if (node.kind === 'image') {
    return digestImportValue({ ...node, bytes: { sha256: await makerImportSha256(node.bytes), byteLength: node.bytes.byteLength } });
  }
  if (node.kind === 'frame') return digestImportValue({ ...node, children: node.children.map(({ id }) => id) });
  return digestImportValue(node);
}

function targetsForNode(
  sourceNodeId: string,
  project: ProjectIndex,
  conversionIds: Record<string, string>,
): MakerImportTargetV2[] {
  const targets: MakerImportTargetV2[] = [];
  const addResource = (key: string, role?: ImportTargetRole): void => {
    const id = conversionIds[key];
    const found = id ? project.resources.get(id) : undefined;
    if (!found) return;
    targets.push({
      role: role ?? (found.resource.kind === 'component' ? 'component' : 'resource'),
      packageId: found.packageId,
      resourceId: found.resource.id,
    });
  };
  const addDisplay = (key: string, role: ImportTargetRole): void => {
    const id = conversionIds[key];
    const found = id ? project.displayNodes.get(id) : undefined;
    if (!found) return;
    targets.push({
      role,
      packageId: found.packageId,
      resourceId: found.resourceId,
      displayNodeId: found.node.id,
    });
  };

  addResource(`${sourceNodeId}:resource`);
  addResource(`${sourceNodeId}:overridden-resource`, 'override-clone');
  addDisplay(`${sourceNodeId}:node`, 'display-node');
  addDisplay(`${sourceNodeId}:layout`, 'layout-group');
  for (const [key] of Object.entries(conversionIds)) {
    if (key.startsWith(`${sourceNodeId}:shadow:`)) addDisplay(key, 'shadow');
    if (!key.endsWith(`:variant:${sourceNodeId}:page`)) continue;
    const id = conversionIds[key];
    const found = project.controllerPages.get(id);
    if (found) targets.push({
      role: 'controller-page',
      packageId: found.packageId,
      resourceId: found.resourceId,
      controllerName: found.controllerName,
      pageId: id,
    });
  }
  return targets.sort((left, right) => compareText(targetKey(left), targetKey(right)));
}

async function targetState(project: ProjectIndex, targets: MakerImportTargetV2[], full = false): Promise<{
  fingerprint: string;
  allMissing: boolean;
}> {
  const values = [];
  for (const target of targets) values.push(await targetValue(project, target, full));
  return { fingerprint: await digestImportValue(values), allMissing: values.length > 0 && values.every((value) => value === null) };
}

async function changedTargetPaths(
  previousProject: ProjectIndex,
  currentProject: ProjectIndex,
  previousTargets: MakerImportTargetV2[],
  currentTargets: MakerImportTargetV2[],
  full = false,
): Promise<Set<string>> {
  const previous = new Map(previousTargets.map((target) => [targetIdentity(target), target]));
  const current = new Map(currentTargets.map((target) => [targetIdentity(target), target]));
  const identities = new Set([...previous.keys(), ...current.keys()]);
  const changes = new Set<string>();
  for (const identity of identities) {
    const leftTarget = previous.get(identity);
    const rightTarget = current.get(identity);
    const left = leftTarget ? await targetValue(previousProject, leftTarget, full) : null;
    const right = rightTarget ? await targetValue(currentProject, rightTarget, full) : null;
    for (const field of changedPaths(left, right)) changes.add(`${identity}:${field}`);
  }
  return changes;
}

function changedPaths(left: unknown, right: unknown, path = '$'): string[] {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return [path];
    return left.flatMap((item, index) => changedPaths(item, right[index], `${path}[${index}]`));
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
    return [...keys].sort(compareText).flatMap((key) => changedPaths(leftRecord[key], rightRecord[key], `${path}.${key}`));
  }
  return [path];
}

function pathsOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const leftPath of left) {
    for (const rightPath of right) {
      if (leftPath === rightPath
        || leftPath.startsWith(`${rightPath}.`)
        || leftPath.startsWith(`${rightPath}[`)
        || rightPath.startsWith(`${leftPath}.`)
        || rightPath.startsWith(`${leftPath}[`)) return true;
    }
  }
  return false;
}

async function targetValue(project: ProjectIndex, target: MakerImportTargetV2, full: boolean): Promise<unknown> {
  const found = target.resourceId ? project.resources.get(target.resourceId) : undefined;
  const resource = found?.packageId === target.packageId ? found.resource : undefined;
  if (!resource) return null;
  if (target.role === 'resource' || target.role === 'component' || target.role === 'override-clone') {
    return full ? fullResource(resource) : sourceOwnedResource(resource);
  }
  if (resource.kind !== 'component') return null;
  if (target.role === 'controller-page') {
    return resource.component.controllers
      .find(({ name }) => name === target.controllerName)?.pages
      .find(({ id }) => id === target.pageId) ?? null;
  }
  const indexedNode = target.displayNodeId ? project.displayNodes.get(target.displayNodeId) : undefined;
  const node = indexedNode?.packageId === target.packageId && indexedNode.resourceId === target.resourceId
    ? indexedNode.node
    : undefined;
  return node ? (full ? node : sourceOwnedDisplayNode(node)) : null;
}

type ProjectIndex = {
  resources: Map<string, { packageId: string; resource: UamResource }>;
  displayNodes: Map<string, { packageId: string; resourceId: string; node: UamDisplayNode }>;
  controllerPages: Map<string, { packageId: string; resourceId: string; controllerName: string }>;
};

function indexProject(project: UamProject): ProjectIndex {
  const resources = new Map<string, { packageId: string; resource: UamResource }>();
  const displayNodes = new Map<string, { packageId: string; resourceId: string; node: UamDisplayNode }>();
  const controllerPages = new Map<string, { packageId: string; resourceId: string; controllerName: string }>();
  for (const pkg of project.packages) {
    for (const resource of pkg.resources) {
      resources.set(resource.id, { packageId: pkg.id, resource });
      if (resource.kind !== 'component') continue;
      for (const node of resource.component.displayList) {
        displayNodes.set(node.id, { packageId: pkg.id, resourceId: resource.id, node });
      }
      for (const controller of resource.component.controllers) {
        for (const page of controller.pages) {
          controllerPages.set(page.id, { packageId: pkg.id, resourceId: resource.id, controllerName: controller.name });
        }
      }
    }
  }
  return { resources, displayNodes, controllerPages };
}

async function sourceOwnedResource(resource: UamResource): Promise<unknown> {
  if (resource.kind === 'component') return {
    kind: resource.kind,
    id: resource.id,
    name: resource.name,
    path: resource.path,
    exported: resource.exported,
    branch: resource.branch,
    branchItemIds: resource.branchItemIds,
    component: {
      size: resource.component.size,
      properties: resource.component.properties,
      displayOrder: resource.component.displayList.map(({ id }) => id),
      controllers: resource.component.controllers.map(({ pages, ...controller }) => ({
        ...controller,
        pageIds: pages.map(({ id }) => id),
      })),
      transitions: resource.component.transitions,
    },
  };
  if (resource.kind === 'image') return {
    kind: resource.kind,
    id: resource.id,
    name: resource.name,
    path: resource.path,
    exported: resource.exported,
    branch: resource.branch,
    branchItemIds: resource.branchItemIds,
    fileName: resource.fileName,
    dimensions: resource.dimensions,
    image: resource.image,
    sourceBytes: resource.sourceBytes instanceof Uint8Array
      ? { sha256: await makerImportSha256(resource.sourceBytes), byteLength: resource.sourceBytes.byteLength }
      : resource.sourceBytes,
  };
  const { favorite: _favorite, ...sourceOwned } = resource;
  return sourceOwned;
}

async function fullResource(resource: UamResource): Promise<unknown> {
  if (resource.kind !== 'image' || !(resource.sourceBytes instanceof Uint8Array)) return resource;
  return {
    ...resource,
    sourceBytes: { sha256: await makerImportSha256(resource.sourceBytes), byteLength: resource.sourceBytes.byteLength },
  };
}

function sourceOwnedDisplayNode(node: UamDisplayNode): unknown {
  const {
    locked: _locked,
    touchable: _touchable,
    tooltips: _tooltips,
    customData: _customData,
    ...sourceOwned
  } = node;
  return sourceOwned;
}

function sourceOwnedFields(targets: MakerImportTargetV2[]): string[] {
  return [...new Set(targets.flatMap((target) => {
    if (target.role === 'controller-page') return ['controller-page.name', 'controller-page.remark'];
    if (['resource', 'component', 'override-clone'].includes(target.role)) {
      return ['resource.name', 'resource.path', 'resource.exported', 'resource.content'];
    }
    return ['display-node.name', 'display-node.kind', 'display-node.position', 'display-node.size', 'display-node.appearance', 'display-node.relations', 'display-node.gears'];
  }))].sort(compareText);
}

function userOwnedFields(targets: MakerImportTargetV2[]): string[] {
  return [...new Set(targets.flatMap((target) => (
    ['resource', 'component', 'override-clone'].includes(target.role)
      ? ['resource.favorite', 'component.customData']
      : target.role === 'controller-page'
        ? []
        : ['display-node.locked', 'display-node.touchable', 'display-node.tooltips', 'display-node.customData']
  )))].sort(compareText);
}

function entry(sourceNodeId: string, node: MakerImportSourceNodeV2, reason: ReimportChangeReason): ReimportPlanEntryV1 {
  return { sourceNodeId, name: node.name, kind: node.kind, targets: node.targets, reason };
}

function targetKey(target: MakerImportTargetV2): string {
  return [target.role, target.packageId, target.resourceId, target.displayNodeId, target.controllerName, target.pageId]
    .filter(Boolean).join(':');
}

function targetIdentity(target: MakerImportTargetV2): string {
  return [target.packageId, target.resourceId, target.displayNodeId, target.controllerName, target.pageId]
    .filter(Boolean).join(':');
}

function canonicalValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $uint8: [...value] };
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => compareText(left, right)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
