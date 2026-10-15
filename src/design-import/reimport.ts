import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { ProjectWriteTransactionResult } from '@openfairygui/backend';
import { createNodeBackendFileSystem, createNodeBackendRuntime, type BackendFileSystem } from '@openfairygui/backend/node';
import { ProjectReader } from '@openfairygui/core/project-io';
import { assertValidUamProject, liftDocumentToUamProject, validateTransactionSupport, type UamProject, type UamTransactionOperation } from '@openfairygui/core/uam';

import { MAKER_IMPORT_SNAPSHOT_DIRECTORY, type ReimportPlanV1 } from './import-state';
import { digestReimportPath, MAKER_IMPORT_STATE, prepareProjectReimport, writeMakerImportStateV2 } from './node';

export interface ReimportApplyPlanV1 extends ReimportPlanV1 {
  /** Content revision of the whole on-disk project, including Import State and unmodelled files. */
  projectRevision: string;
  /** Actual source file/tree digest; Bundle source.sha256 is only a declaration. */
  sourceDigest: string;
  blockers: string[];
  planDigest: string;
}

export function planProjectReimport(projectPath: string, fileSystem = createNodeBackendFileSystem()): Promise<ReimportApplyPlanV1> {
  return runReimport(projectPath, undefined, fileSystem);
}

export function applyProjectReimport(projectPath: string, planDigest: string, fileSystem = createNodeBackendFileSystem()) {
  if (!/^[a-f0-9]{64}$/.test(planDigest)) throw new Error('--apply requires the planDigest from a fresh --dry-run');
  return runReimport(projectPath, planDigest, fileSystem);
}

function unwrap<T>(result: { ok: true; data: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}

async function runReimport(projectPath: string, approvedDigest: string | undefined, base: BackendFileSystem): Promise<ReimportApplyPlanV1> {
  const stats = await lstat(resolve(projectPath));
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error('Reimport project must be a regular directory');
  const projectDirectory = await base.resolvePath(resolve(projectPath));
  await base.validateProjectRoot?.(projectDirectory);
  const projectRevision = await digestReimportPath(projectDirectory);
  let prepared: Awaited<ReturnType<typeof prepareProjectReimport>>;
  const assertUnchanged = async () => {
    if (await base.resolvePath(resolve(projectPath)) !== projectDirectory
      || await digestReimportPath(projectDirectory) !== projectRevision
      || await digestReimportPath(prepared.state.source.path!) !== prepared.sourceDigest) {
      throw new Error('Reimport inputs changed; run --dry-run again and approve the new planDigest');
    }
  };
  const fileSystem: BackendFileSystem = {
    ...base,
    async runProjectWriteTransaction(root, write) {
      if (!approvedDigest || !base.runProjectWriteTransaction) throw new Error('Reimport requires explicit approval and atomic Backend writes');
      await assertUnchanged();
      const metadata = await stageImportMetadata(base, root);
      let result: ProjectWriteTransactionResult;
      try {
        result = await base.runProjectWriteTransaction(root, async (staged) => {
          await assertUnchanged();
          await write(staged);
          const reader = new ProjectReader({
            ...staged,
            exists: (path) => staged.stat(path).then(() => true, () => false),
          });
          const read = await reader.readDetailed(join(root, prepared.state.project.fairyFile), { hydrateResourceBytes: true });
          if (!read.complete || !read.document || read.diagnostics.some(({ severity }) => severity === 'error')) {
            throw new Error('Reimport staged project could not be reopened completely without errors');
          }
          assertValidUamProject(liftDocumentToUamProject(read.document));
          // The next baseline is the SOURCE-generated project, never the merged user-edited project.
          await writeMakerImportStateV2({
            projectRoot: root, fairyFile: prepared.state.project.fairyFile,
            source: prepared.parsed.source, sourcePath: prepared.state.source.path,
            document: prepared.parsed.document, project: prepared.proposed.project,
            makerVersion: prepared.state.compiler.makerVersion, profile: prepared.profile,
            semanticOverlay: prepared.overlay, conversionIds: prepared.proposed.ids, fileSystem: metadata.fileSystem,
          });
          await assertUnchanged();
          // Last step before the Backend commit, so any commit failure below can still restore it.
          await metadata.install();
        });
      } catch (error) {
        await metadata.rollback(error);
        throw error;
      }
      const retained = await metadata.dispose();
      return retained ? { ...result, retainedBackupPaths: [...result.retainedBackupPaths ?? [], retained] } : result;
    },
  };
  // The native session lock also excludes a running Host with unsaved user edits.
  const runtime = createNodeBackendRuntime({ fileSystem });
  const session = unwrap(await runtime.openSession({ projectPath: projectDirectory }));
  try {
    prepared = await prepareProjectReimport(projectDirectory);
    const merged = mergeReimportProject(prepared.snapshot.project, prepared.currentProject, prepared.proposed.project);
    const blockers = merged.conflicts;
    if (session.uamFidelity !== 'full') blockers.push('Backend cannot save this project without losing unsupported fields');
    if (prepared.state.source.kind === 'psd'
      && (prepared.parsed.source.sha256 !== prepared.state.source.sha256 || !isDeepStrictEqual(prepared.snapshot.project, prepared.proposed.project))
      && (prepared.state.source.psdIdentityUncertain !== false
        || prepared.parsed.document.diagnostics.some(({ code }) => code === 'PSD_LAYER_ID_MISSING'))) {
      blockers.push('PSD identity is ambiguous (missing layer IDs or legacy identity metadata); create a new import instead');
    }
    const batches = packageOperations(prepared.currentProject, merged.project);
    if (!blockers.length) {
      for (const [index, operations] of batches.entries()) blockers.push(...validateTransactionSupport(
        index === 0 ? prepared.currentProject : { ...prepared.currentProject, packages: [] }, operations,
      ).map(({ path, message }) => `${path}: ${message}`));
    }
    const unsigned = { ...prepared.report, projectRevision, sourceDigest: prepared.sourceDigest, blockers };
    const plan: ReimportApplyPlanV1 = {
      ...unsigned,
      planDigest: createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'),
    };
    await assertUnchanged();
    if (!approvedDigest) return plan;
    if (approvedDigest !== plan.planDigest) throw new Error('Reimport plan is stale; run --dry-run again and approve the new planDigest');
    if (plan.conflict.length || blockers.length) throw new Error(`Reimport blocked: ${JSON.stringify({ conflict: plan.conflict, blockers })}`);
    let revision = session.revision;
    for (const operations of batches) {
      revision = unwrap(await runtime.applyTransaction({ sessionId: session.sessionId, expectedRevision: revision, operations })).revision;
    }
    unwrap(await runtime.saveSession({ sessionId: session.sessionId, expectedRevision: revision }));
    return plan;
  } finally {
    await runtime.closeSession({ sessionId: session.sessionId });
  }
}

// Backend 0.7 stages and commits only FairyGUI-owned entries (*.fairy, settings, assets*).
// Import State is staged beside the project and swapped in just before that commit; a failed commit restores the previous one.
async function stageImportMetadata(base: BackendFileSystem, projectRoot: string) {
  // Resolved here: node.ts re-exports this module, so its constants are not ready at module load.
  const metadataEntries = [MAKER_IMPORT_SNAPSHOT_DIRECTORY, MAKER_IMPORT_STATE];
  const root = resolve(projectRoot);
  const work = join(dirname(root), `.${basename(root)}.maker-import-${randomUUID()}`);
  const staged = join(work, 'staged');
  const backup = join(work, 'backup');
  await mkdir(staged, { recursive: true });
  await mkdir(backup);
  const translate = (path: string) => {
    const entry = relative(root, resolve(path));
    if (!metadataEntries.includes(entry.split(sep)[0]!)) throw new Error(`Import State path escapes its staging: ${path}`);
    return join(staged, entry);
  };
  const exists = (path: string) => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  const changes: { name: string; backedUp: boolean; installed: boolean }[] = [];
  return {
    fileSystem: {
      ...base,
      mkdir: (path, options) => base.mkdir(translate(path), options),
      writeFileRaw: (path, bytes) => base.writeFileRaw(translate(path), bytes),
    } satisfies BackendFileSystem,
    async install() {
      for (const name of metadataEntries) {
        const change = { name, backedUp: false, installed: false };
        changes.push(change);
        if (await exists(join(root, name))) {
          await rename(join(root, name), join(backup, name));
          change.backedUp = true;
        }
        if (await exists(join(staged, name))) {
          await rename(join(staged, name), join(root, name));
          change.installed = true;
        }
      }
    },
    async rollback(cause: unknown) {
      try {
        for (const change of changes.reverse()) {
          if (change.installed) await rename(join(root, change.name), join(staged, change.name));
          if (change.backedUp) await rename(join(backup, change.name), join(root, change.name));
        }
      } catch (error) {
        throw new AggregateError([cause, error], `Reimport failed and its Import State could not be restored; the previous Import State is kept in ${backup}`);
      }
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    },
    /** Returns the work directory when the committed reimport could not remove the previous Import State. */
    dispose: () => rm(work, { recursive: true, force: true }).then(() => undefined, () => work),
  };
}

// Package snapshots are already a public Backend transaction operation, including reference validation.
// No second per-property command language is needed for the merged UAM.
function packageOperations(current: UamProject, next: UamProject): UamTransactionOperation[][] {
  if (isDeepStrictEqual(current.packages, next.packages)) return [[]];
  // Backend 0.3.1 rejects removing a referenced package even when the same batch re-adds its ID.
  // Two private IN-MEMORY revisions avoid that restriction. Save only the fully validated final project once.
  return [
    current.packages.map((pkg) => ({ kind: 'removePackage', selector: { packageId: pkg.id } })),
    next.packages.map((pkg, atIndex) => ({ kind: 'addPackage', package: pkg, atIndex })),
  ];
}

/** Field-level three-way merge. Only named UAM collections have identity; other arrays are atomic values. */
export function mergeReimportProject(previous: UamProject, current: UamProject, proposed: UamProject) {
  const conflicts: string[] = [];
  const conflict = (path: string, value: unknown) => { conflicts.push(path); return value; };
  const merge = (before: unknown, user: unknown, source: unknown, path: string, field = ''): unknown => {
    if (isDeepStrictEqual(before, source) || isDeepStrictEqual(user, source)) return user;
    if (before === undefined || user === undefined || source === undefined) {
      return isDeepStrictEqual(before, user) ? source : conflict(path, user);
    }
    if (Array.isArray(before) && Array.isArray(user) && Array.isArray(source)) {
      const key = collectionKey(field);
      if (!key) return isDeepStrictEqual(before, user) ? source : conflict(path, user);
      const oldIds = before.map(key), userIds = user.map(key), sourceIds = source.map(key);
      if ([oldIds, userIds, sourceIds].some((ids) => ids.some((id) => id === undefined) || new Set(ids).size !== ids.length)) return conflict(`${path}: ambiguous identity`, user);
      // ponytail: simultaneous structural edits are a conflict; add an order merge only with an explicit UX contract.
      // Resource/package/folder order is not render order; retain user order and append new source identities.
      const order = ['packages', 'resources', 'folders'].includes(field) ? [...new Set([...userIds, ...sourceIds])]
        : isDeepStrictEqual(oldIds, userIds) ? sourceIds
        : isDeepStrictEqual(oldIds, sourceIds) || isDeepStrictEqual(userIds, sourceIds) ? userIds : undefined;
      if (!order) return conflict(`${path}: both sides changed collection order or membership`, user);
      const oldMap = new Map(before.map((item) => [key(item), item]));
      const userMap = new Map(user.map((item) => [key(item), item]));
      const sourceMap = new Map(source.map((item) => [key(item), item]));
      const values = new Map([...new Set([...oldIds, ...userIds, ...sourceIds])].map((id) => [id,
        merge(oldMap.get(id), userMap.get(id), sourceMap.get(id), `${path}[${JSON.stringify(id)}]`),
      ]));
      return order.flatMap((id) => values.get(id) === undefined ? [] : [values.get(id)]);
    }
    if (before instanceof Uint8Array || user instanceof Uint8Array || source instanceof Uint8Array) {
      return isDeepStrictEqual(before, user) ? source : conflict(path, user);
    }
    if (typeof before === 'object' && before !== null && typeof user === 'object' && user !== null && typeof source === 'object' && source !== null) {
      const oldRecord = before as Record<string, unknown>, userRecord = user as Record<string, unknown>, sourceRecord = source as Record<string, unknown>;
      if (oldRecord.kind !== sourceRecord.kind && !isDeepStrictEqual(before, user)) return conflict(`${path}: source changed the kind of a user-edited target`, user);
      return Object.fromEntries([...new Set([...Object.keys(oldRecord), ...Object.keys(userRecord), ...Object.keys(sourceRecord)])].flatMap((key) => {
        const owned = (key === 'favorite' && /\.resources\[[^\]]+\]$/.test(path))
          || (key === 'customData' && path.endsWith('.component'))
          || (['locked', 'touchable', 'tooltips', 'customData'].includes(key) && /\.displayList\[[^\]]+\]$/.test(path));
        const value = owned ? userRecord[key] : merge(oldRecord[key], userRecord[key], sourceRecord[key], `${path}.${key}`, key);
        return value === undefined ? [] : [[key, value]];
      }));
    }
    return isDeepStrictEqual(before, user) ? source : conflict(path, user);
  };
  // Import owns packages, not the user's project settings or branch configuration.
  const project = { ...current, packages: merge(previous.packages, current.packages, proposed.packages, 'packages', 'packages') as UamProject['packages'] };
  return { project, conflicts };
}

function collectionKey(field: string): ((item: Record<string, unknown>) => string | undefined) | undefined {
  if (['packages', 'resources', 'displayList', 'pages'].includes(field)) return (item) => typeof item?.id === 'string' ? item.id : undefined;
  if (['controllers', 'transitions'].includes(field)) return (item) => typeof item?.name === 'string' ? item.name : undefined;
  if (field === 'folders') return (item) => typeof item?.path === 'string' ? JSON.stringify([item.branch, item.path]) : undefined;
  return undefined;
}
