import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { NodeIO } from '@openfairygui/core/node';
import type { BrowserContext } from 'playwright';
import { serializeMakerImportBundleV1 } from '../src/design-import/bundle';
import { compilePlanToUam } from '../src/design-import/convert';
import { semanticFidelityFixture } from '../test/fixtures/design-import/semantic-fidelity';
import { createBrowserEvidence, saveVisualGolden } from './browser-evidence';

export async function semanticFidelitySmoke(context: BrowserContext, origin: string, publishDir: string,
  evidence: Awaited<ReturnType<typeof createBrowserEvidence>>, goldens: Awaited<ReturnType<typeof saveVisualGolden>>[],
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>) {
  const { document: sourceDocument, overlay } = semanticFidelityFixture();
  const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
  const bundle = await serializeMakerImportBundleV1({ document: sourceDocument, source: { kind: 'figma-rest', name: 'semantic-fixture.json', sha256: sha256(JSON.stringify(sourceDocument)) } });
  const post = async (route: string, data?: unknown) => {
    const response = await context.request.post(`${origin}${route}`, { data });
    assert.ok(response.ok(), await response.text()); return response.json();
  };
  let { draft } = await post('/api/import-drafts', { kind: 'bundle', name: 'Semantic Fidelity', files: Object.entries(bundle).map(([path, bytes]) => ({ path, size: bytes.byteLength })) });
  const route = `/api/import-drafts/${draft.draftId}`;
  for (const [name, bytes] of Object.entries(bundle)) {
    const response = await context.request.put(`${origin}${route}/source?path=${encodeURIComponent(name)}`, { data: Buffer.from(bytes) });
    assert.ok(response.ok(), await response.text());
  }
  ({ draft } = await post(`${route}/source/complete`, { expectedRevision: draft.revision }));
  ({ draft } = await post(`${route}/parse`, { expectedRevision: draft.revision }));
  const planned = await post(`${route}/plan`, { expectedRevision: draft.revision, semanticOverlay: overlay });
  const replanned = await post(`${route}/plan`, { expectedRevision: planned.draft.revision });
  assert.deepEqual(replanned.buildPlan, planned.buildPlan, 'replanning retains the explicit font/library policy');
  ({ draft } = await post(`${route}/compile`, { expectedRevision: replanned.draft.revision }));
  const converted = compilePlanToUam(sourceDocument, planned.buildPlan);
  const detail = await (await context.request.get(`${origin}${route}`)).json();
  const projectId = detail.preview.projectId;
  const packageId = converted.project.packages[0].id;
  const componentId = converted.ids['screen:resource'];
  const font = await readFile(path.join(process.cwd(), 'node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2'));
  const page = await context.newPage();
  await page.addInitScript((bytes) => {
    if (!/\/(viewer|player)-runtime\.html$/.test(location.pathname)) return;
    const face = new FontFace('Maker Golden Geist', Uint8Array.from(bytes).buffer, { weight: '100 900' });
    document.fonts.add(face);
    void face.load();
  }, [...font]);
  const captures: Record<string, string> = {};
  const visualErrors: Error[] = [];
  try {
    await page.goto(`${origin}/imports/${draft.draftId}`);
    await page.getByText('AGENT READY', { exact: true }).waitFor();
    const installFont = async (mode: 'viewer' | 'player') => {
      const frame = page.frames().find((item) => item.url().includes(`/${mode}-runtime.html`));
      assert.ok(frame);
      await frame.evaluate(async () => {
        await document.fonts.ready;
        if (![...document.fonts].some((face) => face.family === 'Maker Golden Geist' && face.status === 'loaded')) throw new Error('Golden font failed to preload');
      });
    };
    const captureStates = async (mode: 'viewer' | 'player', sourceId: string, rendered: any) => {
      let state = rendered.value;
      const renderSessionId = state.renderSessionId;
      const viewed = await callTool('set_render_view', { renderSessionId, requestId: randomUUID(),
        expectedViewStateVersion: state.viewStateVersion, view: { width: 460, height: 350, zoom: 1, background: '#202226' } });
      state = { ...state, viewStateVersion: viewed.value.viewStateVersion };
      const buttonPath = `/${packageId}/${componentId}/${converted.ids['button:node']}`;
      for (const buttonState of ['up', 'over', 'down', 'disabled']) {
        const observed = await callTool('get_render_observation', { renderSessionId, requestId: randomUUID(), afterStateVersion: state.semanticStateVersion, afterViewStateVersion: state.viewStateVersion });
        const controllers = observed.value.value.observation.controllers;
        const controller = controllers.find((item: any) => item.targetId === buttonPath && item.name === 'button');
        assert.ok(controller, `${mode} exposes the imported button controller`);
        const pageId = controller.pages.find((item: any) => item.name === buttonState)?.id;
        assert.ok(pageId);
        const applied = await callTool('update_render_session', { renderSessionId, requestId: randomUUID(),
          expectedStateVersion: state.semanticStateVersion,
          operations: [{ op: 'set-controller-page', targetId: buttonPath, controllerName: 'button', pageId }] });
        state = applied.value;
        const captured = await callTool('capture_render_screenshot', { renderSessionId, requestId: randomUUID(),
          afterStateVersion: state.semanticStateVersion, afterViewStateVersion: state.viewStateVersion });
        const image = captured.body.result.content.find((item: any) => item.type === 'image');
        const png = Buffer.from(image.data, 'base64');
        const name = `semantic-${mode}-${buttonState}`;
        try {
          goldens.push(await saveVisualGolden(page, evidence.directory, name, png, captured.value,
            { mode, sourceId, sourceRevision: captured.value.sourceRevision, packageId, componentId },
            path.join(process.cwd(), `test/fixtures/design-import/${name}.png`),
            path.join(process.cwd(), 'test/fixtures/design-import/semantic-fidelity-baseline.json')));
        } catch (error) {
          // Retain all eight diffs for review; a pixel mismatch still fails the entire gate.
          if (!(error instanceof assert.AssertionError) || !error.message.startsWith('Visual baseline changed:')) throw error;
          visualErrors.push(new Error(`${name}: ${error.message}`));
        }
        const objectTree = captured.value.value.observation.objectTree;
        const flatten = (node: any): any[] => [node, ...(node.children ?? []).flatMap(flatten)];
        const objects = flatten(objectTree);
        assert.equal(objects.find((item) => item.id === buttonPath).children.filter((item: any) => item.name === 'background' && item.visible).length, 1,
          `${mode}: only the selected button page is visible`);
        for (const title of ['Order #2048', 'Confirm order', 'Precision typography', 'Editable components']) {
          const text = objects.find((item: any) => item.text === title && item.font);
          assert.ok(text, `${mode}: missing real text ${title}`);
          assert.equal(text.font.availability, 'loaded-face');
          assert.equal(text.font.singleLineOverflow, false);
        }
        assert.ok(objects.some((item) => item.controlKind === 'list' && item.children?.length === 2));
        if (buttonState === 'up') {
          const frame = page.frames().find((item) => item.url().includes(`/${mode}-runtime.html`))!;
          const stroke = await frame.evaluate(() => {
            const pending = [(globalThis as any).fgui.GRoot.inst];
            for (let index = 0; index < pending.length; index++) {
              const item = pending[index];
              if (typeof item.font === 'string' && item.text === 'Confirm order') return item.stroke;
              for (let child = 0; child < (item.numChildren ?? 0); child++) pending.push(item.getChildAt(child));
            }
            return null;
          });
          assert.equal(stroke, 0, `${mode}: a null outline color must not enable the default stroke size`);
        }
        captures[`${mode}-${buttonState}`] = sha256(png);
      }
      assert.equal(new Set(Object.entries(captures).filter(([key]) => key.startsWith(mode)).map(([, value]) => value)).size, 4, 'Button pages must produce four different images');
    };
    await installFont('viewer');
    await captureStates('viewer', projectId, await callTool('render_component_preview', { projectId, packageId, componentId, requestId: randomUUID(), capture: false }));
    const materialized = await post(`${route}/materialize`, { expectedRevision: draft.revision, targetPath: path.join(publishDir, 'semantic-project') });
    const io = new NodeIO();
    const native = await io.readProject(materialized.result.fairyPath, { hydrateResourceBytes: true });
    const pkg = native.getRoot().listPackages()[0];
    const raster = converted.project.packages[0].resources.find((item) => item.kind === 'image');
    assert.ok(raster?.kind === 'image' && raster.sourceBytes instanceof Uint8Array);
    const png = Buffer.from(raster.sourceBytes);
    // Fixture has exactly one raster: publish it as one native atlas, no test-only renderer substitutes.
    const atlas = native.createAtlas().setIndex(0).setFile('atlas0.png').setWidth(20).setHeight(20);
    pkg.addAtlas(atlas);
    atlas.addSprite(native.createSprite().setItemId(raster.id).setAtlas(atlas).setRectWidth(20).setRectHeight(20).setOriginalWidth(20).setOriginalHeight(20));
    const binaryPath = path.join(publishDir, 'Fidelity.fui');
    await io.writeBinary(native, binaryPath, { compressed: true });
    const files = new Map([['Fidelity.fui', await readFile(binaryPath)], ['Fidelity_atlas0.png', png]]);
    const created = await post('/api/artifact-imports', { name: 'Semantic Fidelity', files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha256(bytes) })) });
    for (const [path, bytes] of files) assert.ok((await context.request.put(`${origin}/api/artifact-imports/${created.importId}/files?path=${path}`, { data: bytes })).ok());
    const { artifact } = await post(`/api/artifact-imports/${created.importId}/complete`);
    await page.goto(`${origin}/artifacts/${artifact.artifactId}/player`);
    await page.getByText('AGENT READY', { exact: true }).waitFor();
    await installFont('player');
    await captureStates('player', artifact.artifactId, await callTool('render_artifact_component', { artifactId: artifact.artifactId, packageId, componentId, requestId: randomUUID(), capture: false }));
    if (visualErrors.length) throw new AggregateError(visualErrors, visualErrors.map((error) => error.message).join('\n'));
    return { goldens: 8, buttonStates: 4, editableSourceRoundTrip: true, pinnedFontSha256: sha256(font), captures };
  } finally { await page.close(); }
}
