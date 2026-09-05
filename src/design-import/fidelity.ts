import { Resvg } from '@resvg/resvg-js';
import type { Diagnostic, ImportDocument, ImportImage, ImportNode, ImportShape } from './model';
import type { MakerSemanticOverlayV1, SemanticNodeDirective } from './semantic-overlay';

export interface FontResolution {
  nodeId: string;
  required: string;
  resolved: string;
  status: 'declared-available' | 'substituted' | 'fallback' | 'missing' | 'unverified';
  evidence: 'declared-inventory' | 'generic-family' | 'not-checked';
  sourceStyle?: string;
  sourcePostScriptName?: string;
}

export interface FidelityReport {
  fonts: FontResolution[];
  layouts: Array<{ nodeId: string; outcome: 'layout_semantic_preserved' | 'layout_baked' | 'layout_dropped' }>;
  interactions: Array<{ nodeId: string; count: number; outcome: 'metadata-only' }>;
}

export function resolveImportFont(required: string, fonts?: MakerSemanticOverlayV1['fonts']): Omit<FontResolution, 'nodeId'> {
  const requested = fonts?.substitutions?.[required] ?? required;
  const generic = /^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i;
  const available = (family: string) => generic.test(family)
    || fonts?.availableFamilies?.some((item) => item.toLowerCase() === family.toLowerCase());
  const resolved = available(requested) ? requested : fonts?.fallbackFamilies?.find(available) ?? requested;
  const verified = available(resolved);
  return {
    required, resolved,
    status: !verified ? fonts?.availableFamilies ? 'missing' : 'unverified'
      : resolved !== requested ? 'fallback' : requested !== required ? 'substituted' : 'declared-available',
    evidence: generic.test(resolved) ? 'generic-family' : verified ? 'declared-inventory' : 'not-checked',
  };
}

export function requestedRaster(directive?: SemanticNodeDirective): boolean {
  return directive?.target === 'rasterize' || directive?.asset?.rasterize === true;
}

export function supportsRasterization(node: ImportNode): boolean {
  return node.kind === 'image' && node.format === 'png' || canRasterizeShape(node);
}

// ponytail: only self-contained flat shapes; complex composites need adapter-supplied final pixels.
export function canRasterizeShape(node: ImportNode): node is ImportShape {
  return node.kind === 'shape' && node.width > 0 && node.height > 0 && node.width <= 8_192 && node.height <= 8_192
    && Math.ceil(node.width) * Math.ceil(node.height) <= 16_000_000
    && node.shadows.length === 0 && node.strokeWidth === 0 && /^#[a-f\d]{6}(?:[a-f\d]{2})?$/i.test(node.fillColor)
    && (!node.cornerRadius || node.cornerRadius.every((value) => Number.isFinite(value) && value >= 0 && value === node.cornerRadius![0]))
    && (node.shape !== 'polygon' || !!node.points && node.points.length >= 6 && node.points.length <= 20_000
      && node.points.length % 2 === 0 && node.points.every(Number.isFinite));
}

export function rasterizeShape(node: ImportNode): ImportImage {
  if (!canRasterizeShape(node)) throw new Error(`SEMANTIC_RASTERIZE_UNAVAILABLE: ${node.id}`);
  const { width, height } = node;
  const geometry = node.shape === 'ellipse'
    ? `<ellipse cx="${width / 2}" cy="${height / 2}" rx="${width / 2}" ry="${height / 2}"/>`
    : node.shape === 'polygon' ? `<polygon points="${node.points!.join(' ')}"/>`
      : `<rect width="${width}" height="${height}" rx="${node.cornerRadius?.[0] ?? 0}"/>`;
  // ImportDocument uses FairyGUI #AARRGGBB; SVG uses #RRGGBBAA.
  const fill = node.fillColor.length === 9 ? `#${node.fillColor.slice(3)}${node.fillColor.slice(1, 3)}` : node.fillColor;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(width)}" height="${Math.ceil(height)}" viewBox="0 0 ${width} ${height}"><g fill="${fill}">${geometry}</g></svg>`;
  const renderer = new Resvg(svg, { font: { loadSystemFonts: false } });
  return { ...node, kind: 'image', format: 'png', bytes: renderer.render().asPng() };
}

export function analyzeImportFidelity(document: ImportDocument, overlay: MakerSemanticOverlayV1): { report: FidelityReport; diagnostics: Diagnostic[] } {
  const report: FidelityReport = { fonts: [], layouts: [], interactions: [] };
  const diagnostics: Diagnostic[] = [];
  const warn = (code: string, nodeId: string, message: string, severity: Diagnostic['severity'] = 'warning') => diagnostics.push({ code, nodeId, message, severity });
  const visit = (node: ImportNode, parent?: ImportNode): void => {
    const directive = overlay.nodes[node.id];
    if (directive?.target === 'ignore') return;
    if (node.kind === 'text' || node.kind === 'instance') {
      const families = node.kind === 'text' ? [node.fontFamily, ...node.runs.map((run) => run.fontFamily)]
        : node.overrides.flatMap((override) => override.fontFamily === null ? [] : [override.fontFamily]);
      for (const required of new Set(families)) {
        const resolution = { nodeId: node.id, ...resolveImportFont(required, overlay.fonts),
          ...(node.kind === 'text' && required === node.fontFamily ? { sourceStyle: node.fontStyle, sourcePostScriptName: node.fontPostScriptName } : {}) };
        report.fonts.push(resolution);
        if (resolution.status !== 'declared-available') warn(`FONT_${resolution.status.toUpperCase().replaceAll('-', '_')}`, node.id,
          `${required} → ${resolution.resolved} (${resolution.status}; ${resolution.evidence}). 字体库存为声明值；字形覆盖和排版度量需在目标 Runtime 验证。`);
      }
    }
    if (node.interactions?.length) {
      report.interactions.push({ nodeId: node.id, count: node.interactions.length, outcome: 'metadata-only' });
      warn('INTERACTION_INTENT_UNSUPPORTED', node.id, 'Interaction Intent 已保留到源 IR / 工程 customData；未生成可执行事件。');
    }
    if (directive?.state && (!parent || parent.kind === 'frame' && (parent.sourceType === 'componentSet' || overlay.nodes[parent.id]?.target === 'list'))) {
      warn('SEMANTIC_STATE_UNAVAILABLE', node.id, 'state 只能绑定普通父组件内的显示节点；根节点、Variant 与 List item 不支持此状态映射。', 'error');
    }
    if (directive?.layout === 'bake' && directive.target === 'list') warn('SEMANTIC_LAYOUT_UNAVAILABLE', node.id, '原生 List 自行排版，不能同时要求烘焙坐标；请改为 component 或保留 List 布局。', 'error');
    if (requestedRaster(directive) && !supportsRasterization(node)) warn(
      'SEMANTIC_RASTERIZE_UNAVAILABLE', node.id, `当前仅支持已有 PNG 与无描边/阴影的平面形状栅格化；未获得合成像素，${overlay.profile.unsupportedNode === 'skip' ? '按策略跳过' : '保留原节点'}。`,
      overlay.profile.unsupportedNode === 'fail' ? 'error' : 'warning');
    if (overlay.profile.unsupportedNode === 'skip' && requestedRaster(directive) && !supportsRasterization(node)) return;
    if (directive?.componentKey && !overlay.componentLibrary?.[directive.componentKey] && node.kind === 'instance') {
      warn('SEMANTIC_COMPONENT_KEY_UNRESOLVED', node.id, `组件库没有键 ${directive.componentKey}；保留原始组件引用。`);
    }
    if (node.kind === 'frame') {
      if (node.layout || node.sourceLayout) report.layouts.push({ nodeId: node.id,
        outcome: node.layout ? directive?.layout === 'bake' ? 'layout_baked' : 'layout_semantic_preserved'
          : node.sourceLayout === 'dropped' ? 'layout_dropped' : 'layout_baked' });
      if (directive?.layout === 'bake' && node.layout) warn('LAYOUT_BAKED', node.id, '按计划保留当前坐标，未生成动态 Auto Layout Group。');
      if (directive?.layout === 'preserve' && !node.layout) warn('LAYOUT_PRESERVE_UNAVAILABLE', node.id, '源布局没有可保留的简单语义；继续使用源坐标。');
      node.children.forEach((child) => visit(child, node));
    }
  };
  document.pages.forEach((page) => page.roots.forEach((root) => visit(root)));
  if (overlay.profile.fidelity !== 'hybrid' || overlay.profile.packageStrategy !== 'per-page' || overlay.profile.componentization !== 'balanced') {
    warn('SEMANTIC_PROFILE_UNSUPPORTED', '', '当前编译器使用 hybrid / per-page / balanced；其他全局 profile 不改变输出，请使用明确的逐节点映射。', 'error');
  }
  return { report, diagnostics };
}
