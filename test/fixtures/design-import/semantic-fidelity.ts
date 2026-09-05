import type { ImportDocument, ImportFrame, ImportNode, ImportShape, ImportText } from '../../../src/design-import/model';
import { createSemanticOverlay } from '../../../src/design-import/semantic-overlay';

const base = (id: string, name = id) => ({ id, name, x: 0, y: 0, width: 180, height: 44, visible: true, opacity: 1,
  rotation: 0, scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true });
export const fidelityText = (id: string, text: string): ImportText => ({ kind: 'text', ...base(id, 'title'),
  text, fontFamily: 'Design Sans', fontSize: 18, color: '#e2e8f0', align: 'left', verticalAlign: 'middle',
  lineHeight: null, letterSpacing: 0, autoSize: 'none', singleLine: true, bold: false, italic: false, underline: false,
  strikethrough: false, runs: [], shadow: null });
export const fidelityShape = (id: string, fillColor: string): ImportShape => ({ kind: 'shape', ...base(id),
  shape: 'rectangle', fillColor, strokeColor: null, strokeWidth: 0, cornerRadius: [6, 6, 6, 6], points: null, shadows: [] });
export const fidelityFrame = (id: string, children: ImportNode[] = []): ImportFrame => ({ kind: 'frame', ...base(id),
  sourceType: 'frame', variantProperties: {}, layout: null, clipContent: false, backgroundColor: null, children });

export function semanticFidelityFixture() {
  const button = { ...fidelityFrame('button', [
    ...[['up', '#2563eb'], ['over', '#3b82f6'], ['down', '#1e40af'], ['disabled', '#475569']].map(([page, color]) => ({
      ...fidelityShape(`button-${page}`, color), name: `background @fgui controller=button page=${page}`,
    })),
    { ...fidelityText('button-title', 'Confirm order'), align: 'center' as const },
  ]), name: 'ConfirmButton', x: 28, y: 108 };
  const list = { ...fidelityFrame('list', ['Precision typography', 'Editable components'].map((value, index) => ({
    ...fidelityFrame(`item-${index}`, [
      { ...fidelityShape(`row-${index}`, index === 0 ? '#1e293b' : '#243247'), width: 300, height: 38 },
      { ...fidelityText(`row-title-${index}`, value), x: 12, width: 280, height: 38, fontSize: 16 },
    ]), name: `Item ${index} @fgui role=list-item`, width: 300, height: 38, y: index * 44,
  }))), name: 'OrderList', x: 28, y: 174, width: 300, height: 84, layout: { mode: 'vertical' as const, gap: 6 } };
  const root = { ...fidelityFrame('screen', [
    { ...fidelityText('heading', 'Order #2048'), name: 'heading', x: 28, y: 22, width: 340, fontSize: 26, bold: true },
    { ...fidelityText('description', 'Total: $128.00'), name: 'description', x: 28, y: 63, width: 340, fontSize: 16 },
    button, list,
    { ...fidelityShape('raster', '#22c55e'), name: 'Ready indicator @fgui rasterize', x: 352, y: 118, width: 20, height: 20 },
  ]), name: 'OrderScreen', width: 400, height: 290, backgroundColor: '#0f172a' };
  const document: ImportDocument = { name: 'Semantic Fidelity', diagnostics: [], pages: [{ id: 'page', name: 'Fidelity', roots: [root] }] };
  const overlay = createSemanticOverlay(document);
  overlay.fonts = { availableFamilies: ['Maker Golden Geist'], substitutions: { 'Design Sans': 'Maker Golden Geist' }, fallbackFamilies: ['sans-serif'] };
  return { document, overlay };
}
