import assert from 'node:assert/strict';
import test from 'node:test';
import { Resvg } from '@resvg/resvg-js';
import { ProjectReader, ProjectWriter } from '@openfairygui/core/project-io';
import { readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';
import { MemoryFileSystem, type FidelityReport, type FontResolution, type ImportInteractionIntent } from '../../src/design-import';
import { compilePlanToUam } from '../../src/design-import/convert';
import { planDocument } from '../../src/design-import/plan';
import { parseImportFixture, serializeImportFixture } from '../../src/design-import/fixture';
import { rasterizeShape, resolveImportFont } from '../../src/design-import/fidelity';
import { fidelityFrame, fidelityShape, fidelityText, semanticFidelityFixture } from '../fixtures/design-import/semantic-fidelity';

test('fidelity plan changes fonts, native button states, layout, rasters and source component references, surviving editable round-trip', async () => {
  const { document, overlay } = semanticFidelityFixture();
  const root = document.pages[0].roots[0];
  const layout = { ...fidelityFrame('layout', [fidelityText('layout-text', 'Keep editing')]), layout: { mode: 'horizontal' as const, gap: 8 } };
  root.children.push(layout);
  const original = { ...fidelityFrame('original'), sourceType: 'component' as const };
  const library = { ...fidelityFrame('library', [fidelityText('library-title', 'Library replacement')]), sourceType: 'component' as const };
  document.pages.push({ id: 'components', name: 'Components', roots: [original, library] });
  root.children.push({ ...fidelityShape('instance', '#ffffff'), kind: 'instance', componentId: 'original', overrides: [] });
  root.interactions = [{ trigger: 'ON_CLICK', action: 'NAVIGATE', source: '{"destinationId":"checkout"}' } satisfies ImportInteractionIntent];
  overlay.nodes.instance = { target: 'component', componentKey: 'Primary', rationale: 'User mapping' };
  overlay.componentLibrary = { Primary: 'library' };
  overlay.nodes.layout = { target: 'auto', layout: 'bake', rationale: 'User mapping' };
  const roundTrippedSource = parseImportFixture(serializeImportFixture(document));
  const plan = planDocument(roundTrippedSource, { rootIds: ['screen'], semanticOverlay: overlay });
  assert.deepEqual(plan.packages[1].components.map((item) => item.sourceNodeId), ['library']);
  const result = compilePlanToUam(roundTrippedSource, plan);
  const fidelity: FidelityReport = result.report.fidelity!;
  const font: FontResolution = fidelity.fonts[0];
  assert.ok(font.required);
  const all = result.project.packages.flatMap((pkg) => pkg.resources);
  const component = (id: string) => {
    const resource = all.find((item) => item.id === result.ids[`${id}:resource`]);
    assert.ok(resource?.kind === 'component'); return resource.component;
  };
  assert.equal(component('button').properties.extensionType, 'Button');
  assert.deepEqual(component('button').controllers[0].pages.map((item) => item.name), ['up', 'over', 'down', 'disabled']);
  assert.equal(new Set(component('button').controllers[0].pages.map((item) => item.id)).size, 4);
  assert.equal(component('button').displayList.filter((item) => item.gears?.length).length, 4);
  assert.ok(component('button').displayList.some((item) => item.kind === 'text' && item.font === 'Maker Golden Geist'));
  assert.equal(component('layout').displayList.some((item) => item.kind === 'group'), false);
  assert.equal(component('screen').displayList.find((item) => item.name === 'instance')?.kind, 'component');
  const instance = component('screen').displayList.find((item) => item.name === 'instance');
  assert.ok(instance?.kind === 'component');
  assert.equal(instance.resource.resourceId, result.ids['library:resource']);
  assert.equal(instance.resource.packageId, result.project.packages[1].id);
  assert.equal(JSON.parse(component('screen').customData).maker.executable, false);
  assert.ok(component('screen').displayList.some((item) => item.kind === 'graph' && item.name === '__background' && item.fillColor === '#0f172a'));
  assert.equal(component('screen').properties.bgColorEnabled, false);
  const image = all.find((item) => item.id === result.ids['raster:resource']);
  assert.ok(image?.kind === 'image' && image.sourceBytes instanceof Uint8Array);
  assert.equal(Buffer.from(image.sourceBytes).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(result.report.editableShapes, 6, 'rasterized shapes are not counted as editable graphs');
  assert.equal(result.report.imageBytes, image.sourceBytes.byteLength);
  assert.ok(result.report.fidelity?.layouts.some((item) => item.nodeId === 'layout' && item.outcome === 'layout_baked'));
  assert.ok(result.diagnostics.some((item) => item.code === 'INTERACTION_INTENT_UNSUPPORTED'));
  const memory = new MemoryFileSystem();
  const io = { writeProject: (...args: Parameters<ProjectWriter['write']>) => new ProjectWriter(memory).write(...args),
    readProject: (...args: Parameters<ProjectReader['read']>) => new ProjectReader(memory).read(...args) };
  await writeProjectFromUam(io, result.project, '/Fidelity.fairy');
  const reloaded = await readProjectAsUam(io, '/Fidelity.fairy', { hydrateResourceBytes: true });
  const screen = reloaded.packages.flatMap((pkg) => pkg.resources).find((item) => item.id === result.ids['screen:resource']);
  assert.ok(screen?.kind === 'component');
  assert.equal(JSON.parse(screen.component.customData).maker.interactionIntents[0].action, 'NAVIGATE');
  const button = reloaded.packages.flatMap((pkg) => pkg.resources).find((item) => item.id === result.ids['button:resource']);
  assert.ok(button?.kind === 'component');
  assert.equal(button.component.controllers[0].pages.length, 4);
  const heading = screen.component.displayList.find((item) => item.kind === 'text');
  assert.ok(heading?.kind === 'text'); heading.text = 'Still editable';
  await writeProjectFromUam(io, reloaded, '/Fidelity.fairy');
  assert.match(JSON.stringify(await readProjectAsUam(io, '/Fidelity.fairy')), /Still editable/);
  overlay.nodes.layout.layout = 'preserve';
  const preserved = compilePlanToUam(document, planDocument(document, { semanticOverlay: overlay }));
  assert.ok(preserved.project.packages[0].resources.some((item) => item.kind === 'component' && item.component.displayList.some((node) => node.kind === 'group')));
  library.children.push({ ...fidelityShape('recursive', '#ffffff'), kind: 'instance', componentId: 'original', overrides: [] });
  overlay.nodes.recursive = { target: 'component', componentKey: 'Primary' };
  const cyclic = planDocument(document, { semanticOverlay: overlay });
  assert.throws(() => compilePlanToUam(document, { ...cyclic, diagnostics: [] }), /SEMANTIC_COMPONENT_CYCLE/);
});

test('font evidence never invents installed fonts and unsupported raster/profile policies fail or skip explicitly', () => {
  assert.equal(resolveImportFont('Missing').status, 'unverified');
  assert.equal(resolveImportFont('Missing', { availableFamilies: [] }).status, 'missing');
  assert.deepEqual(resolveImportFont('Missing', { availableFamilies: [], fallbackFamilies: ['sans-serif'] }), {
    required: 'Missing', resolved: 'sans-serif', status: 'fallback', evidence: 'generic-family',
  });
  const { document, overlay } = semanticFidelityFixture();
  document.pages[0].roots[0].children.push(fidelityFrame('complex', [fidelityText('skipped-text', 'Not generated')]));
  overlay.nodes.complex = { target: 'rasterize' };
  overlay.profile.unsupportedNode = 'fail';
  const plan = planDocument(document, { semanticOverlay: overlay });
  assert.throws(() => compilePlanToUam(document, { ...plan, diagnostics: [] }), /SEMANTIC_RASTERIZE_UNAVAILABLE/);
  overlay.profile.unsupportedNode = 'skip';
  const skipped = compilePlanToUam(document, planDocument(document, { semanticOverlay: overlay }));
  assert.equal(skipped.ids['complex:node'], undefined);
  assert.equal(skipped.report.editableText, 5);
  document.pages[0].roots[0].children.push({ ...fidelityShape('svg', '#ffffff'), kind: 'image', format: 'svg',
    bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>') });
  overlay.nodes.svg = { target: 'rasterize' };
  overlay.profile.unsupportedNode = 'fail';
  delete overlay.nodes.complex;
  assert.throws(() => compilePlanToUam(document, planDocument(document, { semanticOverlay: overlay })), /SEMANTIC_RASTERIZE_UNAVAILABLE/);
  overlay.profile.unsupportedNode = 'skip';
  overlay.profile.packageStrategy = 'single';
  assert.throws(() => compilePlanToUam(document, planDocument(document, { semanticOverlay: overlay })), /SEMANTIC_PROFILE_UNSUPPORTED/);
  overlay.profile.packageStrategy = 'per-page';
  overlay.nodes.screen = { target: 'auto', state: { controller: 'button', page: 'up' } };
  assert.throws(() => compilePlanToUam(document, planDocument(document, { semanticOverlay: overlay })), /SEMANTIC_STATE_UNAVAILABLE/);
  delete overlay.nodes.screen;
  overlay.nodes.list = { target: 'list', layout: 'bake' };
  assert.throws(() => compilePlanToUam(document, planDocument(document, { semanticOverlay: overlay })), /SEMANTIC_LAYOUT_UNAVAILABLE/);
  delete overlay.nodes.list;
  overlay.componentLibrary = { Missing: 'https://invalid.example/component' };
  assert.throws(() => planDocument(document, { semanticOverlay: overlay }), /missing Component/);
});

test('font policy covers rich runs and instance overrides; image deduplication preserves per-node nine-slice policy', () => {
  const translucent = rasterizeShape({ ...fidelityShape('alpha', '#80ff0000'), width: 2, height: 2, cornerRadius: null });
  const expected = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="#ff000080"/></svg>',
    { font: { loadSystemFonts: false } }).render().asPng();
  assert.deepEqual(translucent.bytes, expected, 'FairyGUI ARGB must convert to SVG RGBA without changing alpha');
  const { document, overlay } = semanticFidelityFixture();
  const root = document.pages[0].roots[0];
  const text = fidelityText('mixed', 'AB');
  text.runs = [{ start: 1, end: 2, fontFamily: 'Run Serif', fontSize: 18, color: '#e2e8f0',
    bold: false, italic: false, underline: false, strikethrough: false }];
  overlay.fonts!.substitutions!['Run Serif'] = 'serif';
  overlay.fonts!.substitutions!['Override Sans'] = 'sans-serif';
  root.children.push(text);
  document.pages[0].roots.push({ ...fidelityFrame('source', [fidelityText('source-text', 'Default')]), sourceType: 'component' });
  root.children.push({ ...fidelityShape('overridden', '#ffffff'), kind: 'instance', componentId: 'source', overrides: [{
    targetId: 'source-text', targetPath: ['source-text'], componentId: null, name: null, text: null, visible: null,
    opacity: null, width: null, height: null, fillColor: null, strokeColor: null, strokeWidth: null, cornerRadius: null,
    fontFamily: 'Override Sans', fontSize: null, bold: null, italic: null, underline: null, strikethrough: null,
  }] });
  const image = rasterizeShape({ ...fidelityShape('slice-a', '#ffffff'), width: 20, height: 20 });
  root.children.push(image, { ...image, id: 'slice-b' });
  overlay.nodes['slice-a'] = { target: 'image', asset: { scale9Grid: [2, 2, 16, 16] } };
  overlay.nodes['slice-b'] = { target: 'image', asset: { scale9Grid: [4, 4, 12, 12] } };
  const result = compilePlanToUam(document, planDocument(document, { semanticOverlay: overlay }));
  const resources = result.project.packages[0].resources;
  const nodes = resources.flatMap((item) => item.kind === 'component' ? item.component.displayList : []);
  const rich = nodes.find((item) => item.id === result.ids['mixed:node']);
  assert.ok(rich?.kind === 'richText');
  assert.equal(rich.font, 'Maker Golden Geist');
  assert.match(rich.text, /\[font=serif\]B\[\/font\]/);
  assert.ok(nodes.some((item) => item.kind === 'text' && item.font === 'sans-serif'));
  assert.ok(result.report.fidelity?.fonts.some((item) => item.required === 'Run Serif' && item.resolved === 'serif'));
  assert.ok(result.report.fidelity?.fonts.some((item) => item.required === 'Override Sans' && item.resolved === 'sans-serif'));
  assert.notEqual(result.ids['slice-a:resource'], result.ids['slice-b:resource']);
  const slices = resources.filter((item) => item.kind === 'image' && item.image.scale9Grid);
  assert.equal(slices.length, 2);
});
