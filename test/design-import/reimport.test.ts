import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createNodeBackendFileSystem, createNodeBackendRuntime, type BackendFileSystem } from '@openfairygui/backend/node';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam, writeProjectFromUam, type UamProject } from '@openfairygui/core/uam';
import { Resvg } from '@resvg/resvg-js';
import { writePsdUint8Array } from 'ag-psd';
import { serializeMakerImportBundleV1 } from '../../src/design-import/bundle';
import type { ImportDocument, ImportNode } from '../../src/design-import/model';
import { applyProjectReimport, digestReimportPath, importDesignSource, MAKER_IMPORT_STATE, planProjectReimport } from '../../src/design-import/node';
import { createHostBackendFileSystem } from '../../src/server/backend-files';

const common = {
  x: 0, y: 0, width: 100, height: 30, visible: true, opacity: 1, rotation: 0,
  scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true,
};
const text = (id: string, value = id): ImportNode => ({
  ...common, id, name: id, kind: 'text', text: value, fontFamily: 'Arial', fontSize: 16, color: '#FFFFFF',
  align: 'left', verticalAlign: 'top', lineHeight: null, letterSpacing: 0, autoSize: 'none', singleLine: true,
  bold: false, italic: false, underline: false, strikethrough: false, runs: [], shadow: null,
});
const picture = (id: string, color: string): ImportNode => ({
  ...common, id, name: id, kind: 'image', format: 'png',
  bytes: new Uint8Array(new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="${color}"/></svg>`).render().asPng()),
});
const document = (children: ImportNode[]): ImportDocument => ({
  name: 'Reimport', diagnostics: [], pages: [{ id: 'page', name: 'Page', roots: [{
    ...common, id: 'root', name: 'Root', kind: 'frame', sourceType: 'frame', variantProperties: {},
    layout: null, clipContent: false, backgroundColor: null, children,
  }] }],
});
const component = (project: UamProject) => {
  const resource = project.packages[0].resources.find((item) => item.kind === 'component' && item.name === 'Root');
  assert.ok(resource?.kind === 'component');
  return resource;
};

async function setup(t: TestContext, children = [text('keep'), text('change'), text('remove')]) {
  const parent = await mkdtemp(join(tmpdir(), 'maker-reimport-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = join(parent, 'bundle'), output = join(parent, 'project');
  const writeSource = async (nodes: ImportNode[], bindings = {}) => {
    await rm(source, { recursive: true, force: true }); // Only this test's freshly allocated Bundle directory.
    // Deliberately keep the declared source SHA constant: approval must bind actual Bundle bytes.
    const files = await serializeMakerImportBundleV1({ source: { kind: 'raster', name: 'source', sha256: 'a'.repeat(64) }, document: document(nodes), assetBindings: bindings });
    for (const [name, bytes] of Object.entries(files)) {
      const target = join(source, ...name.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, bytes);
    }
  };
  await writeSource(children);
  const imported = await importDesignSource({ sourcePath: source, outputPath: output });
  const read = () => readProjectAsUam(new NodeIO(), imported.fairyPath, { hydrateResourceBytes: true });
  const write = (project: UamProject) => writeProjectFromUam(new NodeIO(), project, imported.fairyPath);
  return { parent, source, output, imported, read, write, writeSource };
}

test('reimport applies source add/change/remove and preserves user-owned fields across two reopen cycles', async (t) => {
  const env = await setup(t, [text('keep'), text('change'), text('remove'), picture('icon', '#f00'), picture('deleted-image', '#00f')]);
  const user = await env.read();
  const root = component(user);
  root.favorite = true;
  root.component.customData = 'user component data';
  const changed = root.component.displayList.find(({ name }) => name === 'change')!;
  Object.assign(changed, { locked: true, touchable: false, tooltips: 'user tooltip', customData: 'user node data' });
  changed.position.x = 17;
  const manual = structuredClone(root);
  manual.id = 'user0001'; manual.name = 'UserOnly'; manual.component.displayList = [];
  user.packages[0].resources.push(manual);
  user.branches.push('user-branch');
  await env.write(user);
  await writeFile(join(env.output, 'notes.txt'), 'unmodelled user file');
  const oldImage = user.packages[0].resources.find((item) => item.kind === 'image' && item.name.startsWith('deleted'));
  assert.ok(oldImage?.kind === 'image');
  const removedPath = join(env.output, 'assets', user.packages[0].name, oldImage.sourcePath!);
  await readFile(removedPath);

  await env.writeSource([text('keep'), text('change', 'new source text'), text('added'), picture('icon', '#0f0')]);
  const before = await digestReimportPath(env.output);
  const plan = await planProjectReimport(env.output);
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.conflict, []);
  assert.ok(plan.added.some(({ sourceNodeId }) => sourceNodeId === 'added'));
  assert.ok(plan.removed.some(({ sourceNodeId }) => sourceNodeId === 'deleted-image'));
  assert.equal(await digestReimportPath(env.output), before, 'dry-run never changes project files');
  await applyProjectReimport(env.output, plan.planDigest);
  const saved = await env.read();
  const savedRoot = component(saved);
  assert.equal(savedRoot.favorite, true);
  assert.equal(savedRoot.component.customData, 'user component data');
  const savedNode = savedRoot.component.displayList.find(({ name }) => name === 'change');
  assert.ok(savedNode?.kind === 'text');
  assert.equal(savedNode.id, changed.id);
  assert.equal(savedNode.text, 'new source text');
  assert.equal(savedNode.position.x, 17);
  assert.equal(savedNode.locked, true);
  assert.equal(savedNode.touchable, false);
  assert.equal(savedNode.tooltips, 'user tooltip');
  assert.equal(savedNode.customData, 'user node data');
  assert.ok(savedRoot.component.displayList.some(({ name }) => name === 'added'));
  assert.ok(!savedRoot.component.displayList.some(({ name }) => name === 'remove'));
  assert.deepEqual(saved.packages[0].resources.find(({ id }) => id === manual.id), manual);
  assert.deepEqual(saved.branches, ['user-branch']);
  assert.equal(await readFile(join(env.output, 'notes.txt'), 'utf8'), 'unmodelled user file');
  await assert.rejects(readFile(removedPath), { code: 'ENOENT' });
  const stable = await planProjectReimport(env.output);
  assert.deepEqual([stable.added, stable.changed, stable.removed, stable.conflict, stable.blockers], [[], [], [], [], []]);
  assert.ok(stable.preserved.some(({ sourceNodeId, reason }) => sourceNodeId === 'change' && reason === 'user-change-preserved'));

  // Source baseline must NOT absorb the user's x=17 during the first save.
  const sourceEdit = text('change', 'new source text'); sourceEdit.x = 8;
  await env.writeSource([text('keep'), sourceEdit, text('added'), picture('icon', '#0f0')]);
  const conflicted = await planProjectReimport(env.output);
  assert.ok(conflicted.conflict.some(({ sourceNodeId }) => sourceNodeId === 'change'));
  const digest = await digestReimportPath(env.output);
  await assert.rejects(applyProjectReimport(env.output, conflicted.planDigest), /Reimport blocked/);
  assert.equal(await digestReimportPath(env.output), digest);
});

test('reimport applies binding-only changes and rejects stale source, project, state and project-path approvals', async (t) => {
  const icon = picture('icon', '#f00');
  const env = await setup(t, [icon]);
  const initial = await planProjectReimport(env.output);
  await env.writeSource([icon], { icon: { pixelRatio: 2, trimOffset: { x: 3, y: 4 }, scale9Grid: null } });
  await assert.rejects(applyProjectReimport(env.output, initial.planDigest), /plan is stale/);
  const bindingPlan = await planProjectReimport(env.output);
  assert.ok(bindingPlan.changed.some(({ sourceNodeId }) => sourceNodeId === 'icon'));
  assert.deepEqual(bindingPlan.blockers, []);
  await applyProjectReimport(env.output, bindingPlan.planDigest);
  assert.deepEqual(component(await env.read()).component.displayList[0].position, { x: 3, y: 4 });
  const stale = await planProjectReimport(env.output);
  await writeFile(join(env.output, 'notes.txt'), 'new file');
  await assert.rejects(applyProjectReimport(env.output, stale.planDigest), /plan is stale/);
  const statePlan = await planProjectReimport(env.output);
  await writeFile(env.imported.statePath, (await readFile(env.imported.statePath, 'utf8')) + '\n');
  await assert.rejects(applyProjectReimport(env.output, statePlan.planDigest), /plan is stale/);
  const userPlan = await planProjectReimport(env.output);
  const user = await env.read(); component(user).favorite = true; await env.write(user);
  await assert.rejects(applyProjectReimport(env.output, userPlan.planDigest), /plan is stale/);
  const other = await setup(t, [icon]);
  await assert.rejects(applyProjectReimport(other.output, (await planProjectReimport(env.output)).planDigest), /plan is stale/);
  assert.throws(() => applyProjectReimport(env.output, ''), /requires the planDigest/);
});

test('reimport rolls back project and Import State together on staged writes or late source/project changes', async (t) => {
  const env = await setup(t);
  await env.writeSource([text('keep'), text('change', 'updated'), text('remove')]);
  const plan = await planProjectReimport(env.output);
  const before = await digestReimportPath(env.output);
  const base = createNodeBackendFileSystem();
  for (const target of ['generated-snapshot.json', MAKER_IMPORT_STATE]) {
    const failing: BackendFileSystem = { ...base, runProjectWriteTransaction: (root, write) => base.runProjectWriteTransaction!(root, (staged) => write({
      ...staged, async writeFileRaw(path, bytes) {
        if (basename(path) === target) throw new Error(`injected ${target} failure`);
        await staged.writeFileRaw(path, bytes);
      },
    })) };
    await assert.rejects(applyProjectReimport(env.output, plan.planDigest, failing), /injected/);
    assert.equal(await digestReimportPath(env.output), before);
    assert.equal((await planProjectReimport(env.output)).planDigest, plan.planDigest, 'failure leaves a reusable unchanged baseline');
    assert.ok(!(await readdir(env.parent)).some((name) => name.includes('.save-') || name.endsWith('.lock')));
  }
  const rename = fs.rename;
  let swapFailed = false;
  fs.rename = async (from, to) => {
    if (to === env.output && String(from).startsWith(join(env.parent, '.project.save-')) && !String(from).includes('.save-backup-')) {
      swapFailed = true;
      throw new Error('injected final swap failure');
    }
    await rename(from, to);
  };
  try { await assert.rejects(applyProjectReimport(env.output, plan.planDigest), /injected final swap failure/); }
  finally { fs.rename = rename; }
  assert.equal(swapFailed, true);
  assert.equal(await digestReimportPath(env.output), before, 'native directory-swap rollback restores project and metadata together');
  const sourceRace: BackendFileSystem = { ...base, runProjectWriteTransaction: (root, write) => base.runProjectWriteTransaction!(root, async (staged) => {
    await env.writeSource([text('keep'), text('change', 'changed during stage'), text('remove')]);
    await write(staged);
  }) };
  await assert.rejects(applyProjectReimport(env.output, plan.planDigest, sourceRace), /inputs changed/);
  assert.equal(await digestReimportPath(env.output), before);

  const fresh = await planProjectReimport(env.output);
  const projectRace: BackendFileSystem = { ...base, runProjectWriteTransaction: (root, write) => base.runProjectWriteTransaction!(root, async (staged) => {
    await writeFile(join(env.output, 'notes.txt'), 'external edit during stage');
    await write(staged);
  }) };
  await assert.rejects(applyProjectReimport(env.output, fresh.planDigest, projectRace), /inputs changed/);
  assert.equal(await readFile(join(env.output, 'notes.txt'), 'utf8'), 'external edit during stage');
  const recovered = await planProjectReimport(env.output);
  await applyProjectReimport(env.output, recovered.planDigest);
  assert.deepEqual((await planProjectReimport(env.output)).blockers, []);
});

test('reimport preserves cross-package user references and refuses deleting their source resource', async (t) => {
  const nested = document([text('label')]).pages[0].roots[0];
  nested.id = 'nested'; nested.name = 'Nested'; nested.sourceType = 'component';
  const env = await setup(t, [nested]);
  const project = await env.read();
  const otherPackage = structuredClone(project.packages[0]);
  otherPackage.id = 'userpkg1'; otherPackage.name = 'UserPackage';
  const otherComponent = component({ ...project, packages: [otherPackage] });
  otherComponent.id = 'user0003';
  otherPackage.resources = [otherComponent];
  const image = otherComponent.component.displayList[0];
  assert.ok(image.kind === 'component');
  image.resource.packageId = project.packages[0].id;
  project.packages.push(otherPackage);
  await env.write(project);
  nested.children = [text('label', 'updated')];
  await env.writeSource([nested]);
  const plan = await planProjectReimport(env.output);
  assert.deepEqual(plan.blockers, []);
  await applyProjectReimport(env.output, plan.planDigest);
  const saved = await env.read();
  assert.deepEqual(saved.packages.find(({ id }) => id === otherPackage.id), otherPackage);
  await env.writeSource([]);
  const removed = await planProjectReimport(env.output);
  assert.ok(removed.blockers.length, 'final Backend reference validation must reject a dangling user reference');
  const before = await digestReimportPath(env.output);
  await assert.rejects(applyProjectReimport(env.output, removed.planDigest), /Reimport blocked/);
  assert.equal(await digestReimportPath(env.output), before);
});

test('reimport refuses incomplete project reads instead of saving a partially loaded project', async (t) => {
  const env = await setup(t);
  const project = await env.read();
  const componentPath = join(env.output, 'assets', project.packages[0].name, 'Root.xml');
  await rm(componentPath);
  await assert.rejects(planProjectReimport(env.output), /could not be read completely/);
});

test('reimport obeys Backend locks and private/symlink boundaries, and refuses ambiguous structural merges', async (t) => {
  const env = await setup(t);
  const plan = await planProjectReimport(env.output);
  const runtime = createNodeBackendRuntime();
  const opened = await runtime.openSession({ projectPath: env.output });
  assert.ok(opened.ok);
  try { await assert.rejects(applyProjectReimport(env.output, plan.planDigest), /lock_conflict/); }
  finally { await runtime.closeSession({ sessionId: opened.data.sessionId }); }
  await assert.rejects(planProjectReimport(env.output, await createHostBackendFileSystem(env.output)), /Maker private data/);
  const outside = join(env.parent, 'outside'); await mkdir(outside);
  const link = join(env.output, 'linked');
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(planProjectReimport(env.output), /links/i);
  await rm(link);
  const user = await env.read();
  const root = component(user);
  const added = structuredClone(root.component.displayList[0]); added.id = 'user0002'; added.name = 'user-node';
  root.component.displayList.push(added);
  await env.write(user);
  await env.writeSource([text('keep'), text('change'), text('remove'), text('source-node')]);
  const ambiguous = await planProjectReimport(env.output);
  assert.ok(ambiguous.blockers.some((message) => message.includes('collection order or membership')));
  const before = await digestReimportPath(env.output);
  await assert.rejects(applyProjectReimport(env.output, ambiguous.planDigest), /Reimport blocked/);
  assert.equal(await digestReimportPath(env.output), before);
});

test('changed PSD reimport requires unique stable layer IDs, with legacy identity failing closed', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'maker-reimport-psd-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const psd = (id: number | undefined, value: string) => writePsdUint8Array({ width: 100, height: 50, children: [{
    id, name: 'Layer', left: 0, top: 0, right: 100, bottom: 20,
    text: { text: value, style: { font: { name: 'Arial' }, fontSize: 16 } },
  }] });
  for (const id of [12, undefined]) {
    const source = join(parent, `${id}.psd`), output = join(parent, `${id}-project`);
    await writeFile(source, psd(id, 'before'));
    const imported = await importDesignSource({ sourcePath: source, outputPath: output });
    await writeFile(source, psd(id, 'after'));
    const plan = await planProjectReimport(output);
    if (id === undefined) {
      assert.ok(plan.blockers.some((message) => message.includes('PSD identity is ambiguous')));
      await assert.rejects(applyProjectReimport(output, plan.planDigest), /Reimport blocked/);
    } else {
      assert.deepEqual(plan.blockers, []);
      await applyProjectReimport(output, plan.planDigest);
      const stable = await planProjectReimport(output);
      assert.deepEqual([stable.added, stable.changed, stable.removed, stable.conflict, stable.blockers], [[], [], [], [], []]);
      const state = JSON.parse(await readFile(imported.statePath, 'utf8')); delete state.source.psdIdentityUncertain;
      await writeFile(imported.statePath, JSON.stringify(state));
      await writeFile(source, psd(id, 'third edit'));
      assert.ok((await planProjectReimport(output)).blockers.some((message) => message.includes('legacy identity')));
    }
  }
});
