import type { Diagnostic, ImportDocument, ImportNode } from './model';
import {
  createSemanticOverlay,
  stripSemanticName,
  validateSemanticOverlay,
  type MakerSemanticOverlayV1,
} from './semantic-overlay';

export const FAIRY_BUILD_PLAN_VERSION = 1 as const;

export interface ConversionImageBinding {
  pixelRatio: number;
  trimOffset: { x: number; y: number };
  scale9Grid: { x: number; y: number; width: number; height: number } | null;
  pixelSize: { width: number; height: number };
}

export interface FairyBuildPlanV1 {
  schemaVersion: typeof FAIRY_BUILD_PLAN_VERSION;
  profile: 'legacy-hybrid';
  sourceName: string;
  semanticOverlay?: MakerSemanticOverlayV1;
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

export function planDocument(
  document: ImportDocument,
  options: { rootIds?: string[]; semanticOverlay?: MakerSemanticOverlayV1 } = {},
): FairyBuildPlanV1 {
  const overlay = validateSemanticOverlay(document, options.semanticOverlay ?? createSemanticOverlay(document));
  const roots = document.pages.flatMap((page) => page.roots);
  const rootsById = new Map(roots.map((root) => [root.id, root]));
  const ownerByNodeId = new Map<string, string>();
  const nodesById = new Map<string, ImportNode>();
  for (const root of roots) {
    const visit = (node: ImportNode): void => {
      ownerByNodeId.set(node.id, root.id);
      nodesById.set(node.id, node);
      if (node.kind === 'frame') node.children.forEach(visit);
    };
    visit(root);
  }

  const selectedRootIds = options.rootIds ?? roots.map((root) => root.id);
  const missing = selectedRootIds.find((id) => !rootsById.has(id));
  if (missing) throw new Error(`Build plan root does not exist: ${missing}`);
  const requested = new Set(selectedRootIds.filter((id) => overlay.nodes[id]?.target !== 'ignore'));
  if (requested.size === 0) {
    throw new Error('Build plan must include at least one root frame');
  }

  const included = new Set(requested);
  const pending = [...requested];
  while (pending.length > 0) {
    const root = rootsById.get(pending.shift()!)!;
    const visit = (node: ImportNode): void => {
      if (node.kind === 'instance') {
        for (const componentId of [node.componentId, ...node.overrides.map((override) => override.componentId)]) {
          if (!componentId) continue;
          const ownerId = ownerByNodeId.get(componentId);
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
  const sourceDiagnostics = options.rootIds === undefined
    ? document.diagnostics
    : document.diagnostics.filter((diagnostic) => includedNodeIds.has(diagnostic.nodeId));
  const semanticDiagnostics: Diagnostic[] = Object.entries(overlay.nodes).flatMap(([nodeId, directive]) => {
    const node = nodesById.get(nodeId);
    return includedNodeIds.has(nodeId) && directive.target === 'rasterize' && node?.kind !== 'image'
      ? [{
        code: 'SEMANTIC_RASTERIZE_UNAVAILABLE',
        message: '该结构节点没有可用的合成像素，已保留原有可编辑转换。',
        nodeId,
        severity: 'warning' as const,
      }]
      : [];
  });

  return {
    schemaVersion: FAIRY_BUILD_PLAN_VERSION,
    profile: 'legacy-hybrid',
    sourceName: stripSemanticName(document.name),
    semanticOverlay: {
      ...overlay,
      nodes: Object.fromEntries(Object.entries(overlay.nodes).filter(([nodeId]) => includedNodeIds.has(nodeId))),
    },
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
    diagnostics: [...sourceDiagnostics, ...semanticDiagnostics],
  };
}
