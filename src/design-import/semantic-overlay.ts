import { z } from 'zod';

import type { ImportDocument, ImportNode } from './model';

export const SEMANTIC_OVERLAY_VERSION = 1 as const;
export const SEMANTIC_TARGETS = [
  'auto',
  'component',
  'button',
  'label',
  'list',
  'list-item',
  'progress-bar',
  'slider',
  'text-input',
  'graph',
  'image',
  'ignore',
  'rasterize',
] as const;

export type SemanticTarget = typeof SEMANTIC_TARGETS[number];

export interface SemanticNodeDirective {
  target: SemanticTarget;
  componentKey?: string;
  extensionType?: 'Button' | 'Label' | 'ProgressBar' | 'Slider';
  state?: { controller: string; page: string };
  asset?: { rasterize?: boolean; scale9Grid?: [number, number, number, number] };
  confidence?: number;
  rationale?: string;
}

export interface MakerSemanticOverlayV1 {
  schemaVersion: typeof SEMANTIC_OVERLAY_VERSION;
  profile: {
    fidelity: 'pixel' | 'hybrid' | 'semantic';
    packageStrategy: 'per-page' | 'single' | 'custom';
    componentization: 'conservative' | 'balanced' | 'aggressive';
    unsupportedNode: 'skip' | 'rasterize' | 'fail';
  };
  nodes: Record<string, SemanticNodeDirective>;
}

const scale9GridSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
  z.number().int().positive(),
  z.number().int().positive(),
]);

export const semanticNodeDirectiveSchema = z.object({
  target: z.enum(SEMANTIC_TARGETS),
  componentKey: z.string().trim().min(1).max(128).optional(),
  extensionType: z.enum(['Button', 'Label', 'ProgressBar', 'Slider']).optional(),
  state: z.object({ controller: z.string().trim().min(1).max(128), page: z.string().trim().min(1).max(128) }).strict().optional(),
  asset: z.object({ rasterize: z.boolean().optional(), scale9Grid: scale9GridSchema.optional() }).strict().optional(),
  confidence: z.number().finite().min(0).max(1).optional(),
  rationale: z.string().trim().min(1).max(1_000).optional(),
}).strict().superRefine((directive, context) => {
  const expected = extensionTypeForTarget(directive.target);
  if (directive.extensionType && directive.extensionType !== expected) {
    context.addIssue({ code: 'custom', path: ['extensionType'], message: 'extensionType does not match target' });
  }
});

export const semanticOverlaySchema = z.object({
  schemaVersion: z.literal(SEMANTIC_OVERLAY_VERSION),
  profile: z.object({
    fidelity: z.enum(['pixel', 'hybrid', 'semantic']),
    packageStrategy: z.enum(['per-page', 'single', 'custom']),
    componentization: z.enum(['conservative', 'balanced', 'aggressive']),
    unsupportedNode: z.enum(['skip', 'rasterize', 'fail']),
  }).strict(),
  nodes: z.record(z.string().min(1).max(1_024), semanticNodeDirectiveSchema),
}).strict();

export function createSemanticOverlay(document: ImportDocument): MakerSemanticOverlayV1 {
  const nodes: Record<string, SemanticNodeDirective> = {};
  visitDocument(document, (node) => {
    const directive = directiveFromName(node);
    if (directive) nodes[node.id] = directive;
  });
  return {
    schemaVersion: SEMANTIC_OVERLAY_VERSION,
    profile: {
      fidelity: 'hybrid',
      packageStrategy: 'per-page',
      componentization: 'balanced',
      unsupportedNode: 'rasterize',
    },
    nodes,
  };
}

export function validateSemanticOverlay(document: ImportDocument, input: MakerSemanticOverlayV1): MakerSemanticOverlayV1 {
  const overlay = semanticOverlaySchema.parse(input) as MakerSemanticOverlayV1;
  const nodes = new Map<string, ImportNode>();
  visitDocument(document, (node) => nodes.set(node.id, node));
  for (const [nodeId, directive] of Object.entries(overlay.nodes)) {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`Semantic overlay references missing node ${nodeId}`);
    assertSemanticTarget(node, directive);
  }
  return overlay;
}

export function assertSemanticTarget(node: ImportNode, input: SemanticNodeDirective): SemanticNodeDirective {
  const directive = semanticNodeDirectiveSchema.parse(input) as SemanticNodeDirective;
  const allowed = directive.target === 'auto'
    || directive.target === 'ignore'
    || directive.target === 'rasterize'
    || (node.kind === 'frame' && ['component', 'button', 'label', 'list', 'list-item', 'progress-bar', 'slider'].includes(directive.target))
    || (node.kind === 'instance' && ['component', 'list-item'].includes(directive.target))
    || (node.kind === 'text' && directive.target === 'text-input')
    || (node.kind === 'shape' && directive.target === 'graph')
    || (node.kind === 'image' && directive.target === 'image');
  if (!allowed) throw new Error(`Semantic target ${directive.target} is not valid for ${node.kind} node ${node.id}`);
  if (directive.asset?.scale9Grid && node.kind !== 'image') {
    throw new Error(`Semantic scale9Grid is only valid for image node ${node.id}`);
  }
  return directive;
}

export function stripSemanticName(value: string): string {
  const index = value.toLowerCase().indexOf('@fgui');
  return (index === -1 ? value : value.slice(0, index)).trim() || value.trim();
}

export function extensionTypeForTarget(target: SemanticTarget): SemanticNodeDirective['extensionType'] {
  return {
    button: 'Button' as const,
    label: 'Label' as const,
    'progress-bar': 'ProgressBar' as const,
    slider: 'Slider' as const,
  }[target as 'button' | 'label' | 'progress-bar' | 'slider'];
}

function directiveFromName(node: ImportNode): SemanticNodeDirective | null {
  const annotation = node.name.match(/@fgui\b(.*)$/i)?.[1]?.trim();
  if (annotation !== undefined) {
    const directive: SemanticNodeDirective = { target: 'auto', confidence: 1, rationale: 'Source @fgui annotation' };
    let controller = '';
    let page = '';
    for (const token of annotation.split(/\s+/).filter(Boolean)) {
      const [rawKey, rawValue] = token.split('=', 2);
      const key = rawKey.toLowerCase();
      const value = rawValue?.trim() ?? '';
      if (key === 'role' && value) {
        const role = normalizeRole(value);
        if (!role) throw new Error(`Unsupported @fgui role: ${value}`);
        directive.target = role;
      }
      else if (key === 'component' && directive.target === 'auto') directive.target = 'component';
      else if (key === 'ignore') directive.target = 'ignore';
      else if (key === 'rasterize') directive.target = 'rasterize';
      else if (key === 'componentkey' && value) directive.componentKey = value;
      else if (key === 'controller') controller = value;
      else if (key === 'page') page = value;
      else if (key === '9slice' && value) {
        const grid = value.split(',').map(Number);
        if (grid.length !== 4 || !grid.every(Number.isInteger)) throw new Error(`Invalid @fgui 9slice: ${value}`);
        directive.asset = { scale9Grid: grid as [number, number, number, number] };
      }
    }
    if (controller && page) directive.state = { controller, page };
    directive.extensionType = extensionTypeForTarget(directive.target);
    return assertSemanticTarget(node, directive);
  }

  const target = deterministicNameTarget(node);
  return target ? {
    target,
    ...(extensionTypeForTarget(target) ? { extensionType: extensionTypeForTarget(target) } : {}),
    confidence: 0.75,
    rationale: 'Deterministic name rule',
  } : null;
}

function deterministicNameTarget(node: ImportNode): SemanticTarget | null {
  const words = stripSemanticName(node.name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const tail = words.at(-1) ?? '';
  const suffix = words.slice(-2).join('');
  if (node.kind === 'text' && ['input', 'textinput'].includes(suffix)) return 'text-input';
  if (node.kind !== 'frame') return null;
  if (['button', 'btn'].includes(tail)) return 'button';
  if (tail === 'label') return 'label';
  if (tail === 'progress' || suffix === 'progressbar') return 'progress-bar';
  if (tail === 'slider') return 'slider';
  if (tail === 'list') return 'list';
  if (tail === 'item' || suffix === 'listitem') return 'list-item';
  return null;
}

function normalizeRole(value: string): SemanticTarget | null {
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  return ({
    button: 'button',
    label: 'label',
    list: 'list',
    'list-item': 'list-item',
    listitem: 'list-item',
    'progress-bar': 'progress-bar',
    progressbar: 'progress-bar',
    slider: 'slider',
    'text-input': 'text-input',
    textinput: 'text-input',
    graph: 'graph',
    image: 'image',
    component: 'component',
    ignore: 'ignore',
    rasterize: 'rasterize',
    auto: 'auto',
  } as Record<string, SemanticTarget>)[normalized] ?? null;
}

function visitDocument(document: ImportDocument, visit: (node: ImportNode) => void): void {
  const walk = (node: ImportNode): void => {
    visit(node);
    if (node.kind === 'frame') node.children.forEach(walk);
  };
  document.pages.forEach((page) => page.roots.forEach(walk));
}
