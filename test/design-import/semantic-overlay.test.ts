import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NodeIO } from '@openfairygui/core/node';
import { readProjectAsUam, writeProjectFromUam } from '@openfairygui/core/uam';

import type { ImportDocument, ImportFrame, ImportNode } from '../../src/design-import/model';
import { compilePlanToUam } from '../../src/design-import/convert';
import { planDocument } from '../../src/design-import/plan';
import { createSemanticOverlay } from '../../src/design-import/semantic-overlay';

const base = (id: string, name: string) => ({
  id, name, x: 0, y: 0, width: 120, height: 40, visible: true, opacity: 1,
  rotation: 0, scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: false,
});

const text = (id: string, name: string, value: string): ImportNode => ({
  kind: 'text', ...base(id, name), text: value, fontFamily: 'Arial', fontSize: 16,
  color: '#ffffff', align: 'left', verticalAlign: 'top', lineHeight: null, letterSpacing: 0,
  autoSize: 'none', singleLine: true, bold: false, italic: false, underline: false,
  strikethrough: false, runs: [], shadow: null,
});

const frame = (id: string, name: string, children: ImportNode[] = [], sourceType: ImportFrame['sourceType'] = 'component'): ImportFrame => ({
  kind: 'frame', ...base(id, name), sourceType, flattenable: false, variantProperties: {},
  layout: null, clipContent: false, backgroundColor: null, children,
});

test('semantic overlay rules compile native FairyGUI roles and strip source annotations', async () => {
  const document: ImportDocument = {
    name: 'Semantic Demo',
    diagnostics: [],
    pages: [{
      id: 'page',
      name: 'Main',
      roots: [
        frame('screen', 'Screen', [
          frame('button', 'PrimaryButton', [text('button-title', 'title', 'Play')]),
          frame('label', 'StatusLabel', [text('label-title', 'title', 'Ready')]),
          frame('progress', 'HealthProgressBar'),
          frame('slider', 'VolumeSlider'),
          text('input', 'Username @fgui role=text-input', ''),
          frame('list', 'Items @fgui role=list', [
            frame('item', 'Item @fgui role=list-item', [text('item-title', 'title', 'One')]),
          ], 'frame'),
          { kind: 'shape', ...base('debug', 'Debug @fgui ignore'), shape: 'rectangle', fillColor: '#ff0000', strokeColor: null, strokeWidth: 0, cornerRadius: null, points: null, shadows: [] },
          { kind: 'shape', ...base('effect', 'Effect @fgui rasterize'), shape: 'rectangle', fillColor: '#00ff00', strokeColor: null, strokeWidth: 0, cornerRadius: null, points: null, shadows: [] },
          { kind: 'image', ...base('image', 'Panel @fgui role=image 9slice=1,1,2,2'), format: 'png', bytes: new Uint8Array([1, 2, 3, 4]) },
          { kind: 'image', ...base('glow', 'Glow @fgui rasterize'), format: 'png', bytes: new Uint8Array([5, 6, 7, 8]) },
        ], 'frame'),
        frame('root-list', 'RootList @fgui role=list', [
          frame('root-item', 'RootItem @fgui role=list-item', [text('root-item-title', 'title', 'Root One')]),
        ], 'frame'),
      ],
    }],
  };

  const overlay = createSemanticOverlay(document);
  assert.equal(overlay.nodes.button.target, 'button');
  assert.equal(overlay.nodes.input.target, 'text-input');
  assert.equal(overlay.nodes.debug.target, 'ignore');
  assert.equal(overlay.nodes.glow.target, 'rasterize');
  const plan = planDocument(document, { semanticOverlay: overlay });
  assert.ok(plan.diagnostics.some(({ code, nodeId }) => code === 'SEMANTIC_RASTERIZE_UNAVAILABLE' && nodeId === 'effect'));
  const result = compilePlanToUam(document, plan);
  const resources = result.project.packages[0].resources;
  const extension = (name: string) => {
    const resource = resources.find((candidate) => candidate.kind === 'component' && candidate.name === name);
    return resource?.kind === 'component' ? resource.component.properties.extensionType : undefined;
  };
  assert.equal(extension('PrimaryButton'), 'Button');
  assert.equal(extension('StatusLabel'), 'Label');
  assert.equal(extension('HealthProgressBar'), 'ProgressBar');
  assert.equal(extension('VolumeSlider'), 'Slider');

  const screen = resources.find((resource) => resource.kind === 'component' && resource.name === 'Screen');
  assert.ok(screen?.kind === 'component');
  assert.ok(screen.component.displayList.some((node) => node.kind === 'textInput' && node.name === 'Username'));
  assert.equal(screen.component.displayList.some((node) => node.name.startsWith('Debug')), false);
  const list = screen.component.displayList.find((node) => node.kind === 'list');
  assert.ok(list?.kind === 'list');
  assert.equal(list.listItems[0]?.title, 'One');
  assert.match(list.defaultItem, /^ui:\/\//);
  const image = resources.find((resource) => resource.kind === 'image' && resource.name === 'Panel');
  assert.deepEqual(image?.kind === 'image' ? image.image.scale9Grid : null, [1, 1, 2, 2]);
  assert.ok(resources.some((resource) => resource.kind === 'image' && resource.name === 'Glow'));
  const rootList = resources.find((resource) => resource.kind === 'component' && resource.name === 'RootList');
  assert.ok(rootList?.kind === 'component' && rootList.component.displayList.some((node) => node.kind === 'list'));

  const directory = await mkdtemp(path.join(tmpdir(), 'fairygui-maker-semantic-'));
  try {
    const fairyPath = path.join(directory, 'Semantic.fairy');
    const io = new NodeIO();
    await writeProjectFromUam(io, result.project, fairyPath);
    const reloaded = await readProjectAsUam(io, fairyPath, { hydrateResourceBytes: true });
    const button = reloaded.packages[0].resources.find((resource) => resource.kind === 'component' && resource.name === 'PrimaryButton');
    assert.equal(button?.kind === 'component' ? button.component.properties.extensionType : null, 'Button');
    const reloadedScreen = reloaded.packages[0].resources.find((resource) => resource.kind === 'component' && resource.name === 'Screen');
    assert.ok(reloadedScreen?.kind === 'component' && reloadedScreen.component.displayList.some((node) => node.kind === 'list'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
