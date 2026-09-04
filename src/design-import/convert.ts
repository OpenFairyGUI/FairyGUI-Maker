import {
  AlignType,
  AutoSizeType,
  generateId,
  GraphType,
  GroupLayoutType,
  ListLayoutType,
  ListSelectionMode,
  OverflowType,
  RelationType,
  VertAlignType,
} from '@openfairygui/core';
import {
  assertValidUamProject,
  createDefaultUamComponentProperties,
  createDefaultUamImageResourceProperties,
  createDefaultUamPlainTextProperties,
  createDefaultUamTextProperties,
  normalizeUamProject,
  type UamDisplayNode,
  type UamProject,
  type UamResource,
} from '@openfairygui/core/uam';
import type {
  Diagnostic,
  ImportDocument,
  ImportFrame,
  ImportInstanceOverride,
  ImportNode,
} from './model';
import {
  planDocument,
  type ConversionImageBinding,
  type FairyBuildPlanV1,
} from './plan';
import {
  createSemanticOverlay,
  extensionTypeForTarget,
  stripSemanticName,
  type SemanticNodeDirective,
} from './semantic-overlay';

export type { ConversionImageBinding } from './plan';

function constraintRelations(node: ImportNode) {
  if (!node.constraints) return [];
  const relation = (type: RelationType, usePercent = false) => ({ targetNodeId: '', type, usePercent });
  const horizontal = {
    min: [relation(RelationType.Left_Left)],
    center: [relation(RelationType.Center_Center)],
    max: [relation(RelationType.Right_Right)],
    stretch: [relation(RelationType.Left_Left), relation(RelationType.Right_Right)],
    scale: [relation(RelationType.Left_Left, true), relation(RelationType.Width, true)],
  }[node.constraints.horizontal];
  const vertical = {
    min: [relation(RelationType.Top_Top)],
    center: [relation(RelationType.Middle_Middle)],
    max: [relation(RelationType.Bottom_Bottom)],
    stretch: [relation(RelationType.Top_Top), relation(RelationType.Bottom_Bottom)],
    scale: [relation(RelationType.Top_Top, true), relation(RelationType.Height, true)],
  }[node.constraints.vertical];
  return [...horizontal, ...vertical];
}

function richText(node: Extract<ImportNode, { kind: 'text' }>): string {
  return node.runs.map((run) => {
    const tags: string[] = [];
    if (run.fontFamily !== node.fontFamily) tags.push(`font=${run.fontFamily.replace(/[\[\]]/g, '')}`);
    if (Math.round(run.fontSize) !== Math.round(node.fontSize)) tags.push(`size=${Math.max(1, Math.round(run.fontSize))}`);
    if (run.color !== node.color) tags.push(`color=${run.color}`);
    if (run.bold) tags.push('b');
    if (run.italic) tags.push('i');
    if (run.underline) tags.push('u');
    if (run.strikethrough) tags.push('s');
    const value = node.text.slice(run.start, run.end);
    return `${tags.map((tag) => `[${tag}]`).join('')}${value}${[...tags].reverse()
      .map((tag) => `[/${tag.split('=')[0]}]`).join('')}`;
  }).join('');
}

export interface ConversionResult {
  project: UamProject;
  ids: Record<string, string>;
  diagnostics: Diagnostic[];
  report: ConversionReport;
}

export interface ConversionReport {
  sourceName: string;
  pages: number;
  roots: number;
  nodes: number;
  frames: number;
  editableText: number;
  editableShapes: number;
  editableInstances: number;
  variantSets: number;
  rasterizedNodes: number;
  imageBytes: number;
  diagnostics: Record<string, number>;
  diagnosticGroups: Array<{
    pageName: string;
    rootName: string;
    code: string;
    severity: Diagnostic['severity'];
    count: number;
    nodeTypes: Record<string, number>;
  }>;
  diagnosticDetails: Diagnostic[];
  ids: {
    reused: number;
    added: number;
    changed: number;
    removed: number;
  };
}

const FAIRY_ID = /^[a-z0-9]{8}$/;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function imageContentKey(format: string, bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193);
  return `${format}:${bytes.byteLength}:${hash >>> 0}`;
}

export function createConversionReport(
  document: ImportDocument,
  previousIds: Record<string, string> = {},
  ids: Record<string, string> = {},
): ConversionReport {
  let nodes = 0;
  let frames = 0;
  let editableText = 0;
  let editableShapes = 0;
  let editableInstances = 0;
  let variantSets = 0;
  let imageBytes = 0;
  const contexts = new Map<string, Pick<Diagnostic, 'nodeName' | 'nodeType' | 'pageId' | 'pageName' | 'rootId' | 'rootName'>>();
  const visit = (node: ImportNode, page: ImportDocument['pages'][number], root: ImportFrame): void => {
    nodes += 1;
    contexts.set(node.id, {
      nodeName: node.name,
      nodeType: node.kind === 'frame' ? node.sourceType : node.kind,
      pageId: page.id,
      pageName: page.name,
      rootId: root.id,
      rootName: root.name,
    });
    if (node.kind === 'frame') {
      frames += 1;
      if (node.sourceType === 'componentSet') variantSets += 1;
      node.children.forEach((child) => visit(child, page, root));
    } else if (node.kind === 'instance') {
      editableInstances += 1;
    } else if (node.kind === 'text') {
      editableText += 1;
    } else if (node.kind === 'shape') {
      editableShapes += 1;
    } else {
      imageBytes += node.bytes.byteLength;
    }
  };
  document.pages.forEach((page) => page.roots.forEach((root) => visit(root, page, root)));

  const diagnostics = Object.fromEntries([...document.diagnostics.reduce((counts, item) => {
    counts.set(item.code, (counts.get(item.code) ?? 0) + 1);
    return counts;
  }, new Map<string, number>())].sort(([left], [right]) => left.localeCompare(right)));
  const currentKeys = Object.keys(ids);
  const previousKeys = Object.keys(previousIds);
  const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
  const diagnosticDetails = document.diagnostics.map((item) => ({ ...contexts.get(item.nodeId), ...item }))
    .sort((left, right) => compareText(left.pageName ?? '', right.pageName ?? '')
      || compareText(left.rootName ?? '', right.rootName ?? '')
      || compareText(left.code, right.code)
      || compareText(left.nodeId, right.nodeId));
  const grouped = diagnosticDetails.reduce((result, item) => {
    const key = `${item.pageName ?? ''}\0${item.rootName ?? ''}\0${item.code}`;
    const group = result.get(key) ?? {
      pageName: item.pageName ?? '',
      rootName: item.rootName ?? '',
      code: item.code,
      severity: item.severity,
      count: 0,
      nodeTypes: {} as Record<string, number>,
    };
    group.count += 1;
    if (item.severity === 'error') group.severity = 'error';
    const type = item.nodeType ?? 'unknown';
    group.nodeTypes[type] = (group.nodeTypes[type] ?? 0) + 1;
    result.set(key, group);
    return result;
  }, new Map<string, ConversionReport['diagnosticGroups'][number]>());
  const diagnosticGroups = [...grouped.values()].sort((left, right) => right.count - left.count
    || compareText(left.pageName, right.pageName)
    || compareText(left.rootName, right.rootName)
    || compareText(left.code, right.code));

  return {
    sourceName: document.name,
    pages: document.pages.length,
    roots: document.pages.reduce((count, page) => count + page.roots.length, 0),
    nodes,
    frames,
    editableText,
    editableShapes,
    editableInstances,
    variantSets,
    rasterizedNodes: diagnostics.RASTERIZED_NODE ?? 0,
    imageBytes,
    diagnostics,
    diagnosticGroups,
    diagnosticDetails,
    ids: {
      reused: currentKeys.filter((key) => previousIds[key] === ids[key]).length,
      added: currentKeys.filter((key) => previousIds[key] === undefined).length,
      changed: currentKeys.filter((key) => previousIds[key] !== undefined && previousIds[key] !== ids[key]).length,
      removed: previousKeys.filter((key) => ids[key] === undefined).length,
    },
  };
}

export function safeName(value: string, fallback = 'Untitled'): string {
  const cleaned = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80);
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

function canFlattenGroup(frame: ImportFrame): boolean {
  const defaultConstraints = (node: ImportNode) => !node.constraints
    || (node.constraints.horizontal === 'min' && node.constraints.vertical === 'min');
  return frame.sourceType === 'group'
    && frame.flattenable === true
    && frame.layout === null
    && !frame.clipContent
    && frame.backgroundColor === null
    && frame.opacity === 1
    && frame.rotation === 0
    && frame.scaleX === 1
    && frame.scaleY === 1
    && !frame.mask
    && defaultConstraints(frame)
    && frame.children.every((child) => !child.mask && defaultConstraints(child));
}

export function convertDocument(
  document: ImportDocument,
  previousIds: Record<string, string> = {},
  imageBindings: Record<string, ConversionImageBinding> = {},
): ConversionResult {
  return compilePlanToUam(document, planDocument(document), previousIds, imageBindings);
}

function firstText(node: ImportNode): string | null {
  if (node.kind === 'text') return node.text;
  if (node.kind !== 'frame') return null;
  for (const child of node.children) {
    const text = firstText(child);
    if (text) return text;
  }
  return null;
}

export function compilePlanToUam(
  sourceDocument: ImportDocument,
  plan: FairyBuildPlanV1,
  previousIds: Record<string, string> = {},
  imageBindings: Record<string, ConversionImageBinding> = {},
): ConversionResult {
  if (plan.schemaVersion !== 1 || plan.profile !== 'legacy-hybrid' || plan.packages.length === 0) {
    throw new Error('Invalid FairyBuildPlan v1');
  }
  const sourcePages = new Map(sourceDocument.pages.map((page) => [page.id, page]));
  const semanticOverlay = plan.semanticOverlay ?? createSemanticOverlay(sourceDocument);
  const directiveFor = (node: ImportNode): SemanticNodeDirective | undefined => semanticOverlay.nodes[node.id];
  const packageKeys = new Map(plan.packages.map((pkg) => [pkg.sourcePageId, pkg.key]));
  const rootPlans = new Map(plan.packages.flatMap((pkg) => pkg.components.map((component) => [
    component.sourceNodeId,
    component,
  ])));
  if (sourcePages.size !== sourceDocument.pages.length
    || packageKeys.size !== plan.packages.length
    || rootPlans.size !== plan.packages.reduce((count, pkg) => count + pkg.components.length, 0)
    || new Set(plan.packages.map((pkg) => pkg.key)).size !== plan.packages.length
    || new Set([...rootPlans.values()].map((root) => root.key)).size !== rootPlans.size) {
    throw new Error('FairyBuildPlan v1 contains duplicate source IDs or keys');
  }
  const document: ImportDocument = {
    ...sourceDocument,
    name: plan.sourceName,
    diagnostics: plan.diagnostics,
    pages: plan.packages.map((pkg) => {
      const page = sourcePages.get(pkg.sourcePageId);
      if (!page) throw new Error(`FairyBuildPlan v1 references missing page ${pkg.sourcePageId}`);
      const roots = new Map(page.roots.map((root) => [root.id, root]));
      return {
        ...page,
        name: pkg.name,
        roots: pkg.components.map((component) => {
          const root = roots.get(component.sourceNodeId);
          if (!root) throw new Error(`FairyBuildPlan v1 references missing root ${component.sourceNodeId}`);
          return { ...root, name: component.name };
        }),
      };
    }),
  };
  const ids: Record<string, string> = {};
  const usedIds = new Set<string>();
  const diagnostics = [...document.diagnostics];

  const idFor = (key: string): string => {
    if (FAIRY_ID.test(ids[key] ?? '')) return ids[key];
    const previous = previousIds[key];
    if (FAIRY_ID.test(previous ?? '') && !usedIds.has(previous)) {
      ids[key] = previous;
      usedIds.add(previous);
      return previous;
    }
    let id = generateId();
    while (usedIds.has(id)) id = generateId();
    usedIds.add(id);
    ids[key] = id;
    return id;
  };
  const packageIds = new Map(document.pages.map((page) => [
    page.id,
    idFor(packageKeys.get(page.id)!),
  ]));
  const componentPackages = new Map<string, string>();
  const pendingOverrides: Array<{
    instance: Extract<ImportNode, { kind: 'instance' }>;
    packageId: string;
    resourceId: string;
  }> = [];
  const indexComponents = (node: ImportNode, packageId: string): void => {
    if (node.kind !== 'frame') return;
    if (node.sourceType === 'component') componentPackages.set(node.id, packageId);
    node.children.forEach((child) => indexComponents(child, packageId));
  };
  for (const page of document.pages) {
    const packageId = packageIds.get(page.id)!;
    page.roots.forEach((root) => indexComponents(root, packageId));
  }

  const packageNames = new Set<string>();
  const resourceNames = new Map<string, Set<string>>();
  const resourceName = (packageId: string, value: string, fallback: string, extension = ''): string => {
    const used = resourceNames.get(packageId) ?? new Set<string>();
    resourceNames.set(packageId, used);
    const ext = extension ? `.${extension}` : '';
    const base = safeName(value, fallback);
    for (let suffix = 1; ; suffix += 1) {
      const marker = suffix === 1 ? '' : `_${suffix}`;
      const stem = base.slice(0, Math.max(1, 80 - ext.length - marker.length)).replace(/[. ]+$/g, '') || fallback;
      const candidate = `${stem}${marker}`;
      const key = candidate.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      return candidate;
    }
  };
  const packages = document.pages.map((page, pageIndex) => {
    const packageId = packageIds.get(page.id)!;
    const resources: UamResource[] = [];
    const componentResources = new Map<string, Extract<UamResource, { kind: 'component' }>>();
    const imageResources = new Map<string, Array<Extract<UamResource, { kind: 'image' }>>>();
    const resourceRef = (componentId: string) => {
      const targetPackage = componentPackages.get(componentId);
      return {
        resourceId: idFor(`${componentId}:resource`),
        ...(targetPackage && targetPackage !== packageId ? { packageId: targetPackage } : {}),
      };
    };
    const nodeBase = (node: ImportNode) => ({
      id: idFor(`${node.id}:node`),
      name: stripSemanticName(node.name),
      position: { x: node.x, y: node.y },
      size: { width: node.width, height: node.height },
      locked: false,
      aspect: false,
      minSize: { width: 0, height: 0 },
      maxSize: { width: 0, height: 0 },
      pivot: { x: 0, y: 0 },
      pivotAsAnchor: false,
      scale: { x: node.scaleX, y: node.scaleY },
      skew: { x: 0, y: 0 },
      visible: node.visible,
      touchable: true,
      grayed: false,
      alpha: node.opacity,
      rotation: node.rotation,
      tooltips: '',
      blendMode: 'normal' as const,
      filter: '',
      filterData: '',
      group: '',
      customData: '',
      relations: constraintRelations(node),
      gears: [],
    });

    const groupNode = (
      frame: ImportFrame,
      id: string,
      name: string,
      position: { x: number; y: number },
      layout: ImportFrame['layout'],
      memberGroup = '',
      source = false,
    ): Extract<UamDisplayNode, { kind: 'group' }> => ({
      kind: 'group',
      ...nodeBase(frame),
      id,
      name,
      position,
      size: { width: frame.width, height: frame.height },
      visible: source ? frame.visible : true,
      touchable: false,
      alpha: source ? frame.opacity : 1,
      rotation: source ? frame.rotation : 0,
      group: memberGroup,
      relations: source ? constraintRelations(frame) : [],
      locked: !source,
      layout: layout
        ? layout.mode === 'horizontal' ? GroupLayoutType.Horizontal : GroupLayoutType.Vertical
        : GroupLayoutType.None,
      lineGap: layout?.mode === 'vertical' ? layout.gap : 0,
      columnGap: layout?.mode === 'horizontal' ? layout.gap : 0,
      advanced: false,
      excludeInvisibles: true,
      autoSizeDisabled: false,
      mainGridIndex: -1,
    });

    const convertNode = (node: ImportNode, exported = false, resourcePath?: string): UamDisplayNode => {
      const directive = directiveFor(node);
      if (node.kind === 'text') {
        const mixed = node.runs.length > 0;
        const properties = {
          text: mixed ? richText(node) : node.text,
          font: node.fontFamily,
          fontSize: Math.max(1, Math.round(node.fontSize)),
          color: node.color,
          align: { left: AlignType.Left, center: AlignType.Center, right: AlignType.Right }[node.align],
          vAlign: { top: VertAlignType.Top, middle: VertAlignType.Middle, bottom: VertAlignType.Bottom }[node.verticalAlign],
          leading: node.lineHeight === null ? 3 : Math.round(node.lineHeight - node.fontSize),
          letterSpacing: Math.round(node.letterSpacing),
          autoSize: {
            none: AutoSizeType.None,
            both: AutoSizeType.Both,
            height: AutoSizeType.Height,
            ellipsis: AutoSizeType.Ellipsis,
          }[node.autoSize],
          singleLine: node.singleLine,
          bold: mixed ? false : node.bold,
          italic: mixed ? false : node.italic,
          underline: mixed ? false : node.underline,
          strikethrough: mixed ? false : node.strikethrough,
          ubbEnabled: mixed,
          shadowColor: node.shadow?.color ?? null,
          shadowOffset: node.shadow
            ? { x: node.shadow.offsetX, y: node.shadow.offsetY }
            : { x: 0, y: 0 },
        };
        if (directive?.target === 'text-input') {
          return {
            kind: 'textInput',
            ...nodeBase(node),
            ...createDefaultUamPlainTextProperties(),
            ...properties,
            text: node.text,
            ubbEnabled: false,
            promptText: '',
            maxLength: 0,
            restrict: '',
            password: false,
            keyboardType: 0,
          };
        }
        return mixed
          ? { kind: 'richText', ...nodeBase(node), ...createDefaultUamTextProperties(), ...properties }
          : { kind: 'text', ...nodeBase(node), ...createDefaultUamPlainTextProperties(), ...properties };
      }
      if (node.kind === 'shape') {
        return {
          kind: 'graph',
          ...nodeBase(node),
          graphType: {
            rectangle: GraphType.Rect,
            ellipse: GraphType.Ellipse,
            polygon: GraphType.Polygon,
          }[node.shape],
          lineSize: node.strokeWidth,
          lineColor: node.strokeColor ?? '#000000',
          fillColor: node.fillColor,
          cornerRadius: node.shape === 'rectangle' ? node.cornerRadius : null,
          points: node.shape === 'polygon' ? node.points : null,
          sides: 0,
          startAngle: 0,
          distances: null,
        };
      }
      if (node.kind === 'instance') {
        if (node.overrides.length > 0) {
          const resourceId = idFor(`${node.id}:overridden-resource`);
          const targetPackageId = componentPackages.get(node.componentId) ?? packageId;
          pendingOverrides.push({ instance: node, packageId: targetPackageId, resourceId });
          return {
            kind: 'component',
            ...nodeBase(node),
            resource: {
              resourceId,
              ...(targetPackageId !== packageId ? { packageId: targetPackageId } : {}),
            },
          };
        }
        return { kind: 'component', ...nodeBase(node), resource: resourceRef(node.componentId) };
      }
      if (node.kind === 'frame' && directive?.target === 'list') {
        const explicitItems = node.children.filter((child) => directiveFor(child)?.target === 'list-item');
        const items = (explicitItems.length ? explicitItems : node.children)
          .filter((child): child is ImportFrame | Extract<ImportNode, { kind: 'instance' }> => child.kind === 'frame' || child.kind === 'instance');
        const listItems = items.map((item) => {
          const resource = item.kind === 'frame'
            ? { resourceId: convertFrame(item, false, '/_internal/list-items/') }
            : resourceRef(item.componentId);
          const url = `ui://${resource.packageId ?? packageId}${resource.resourceId}`;
          return {
            title: firstText(item),
            icon: null,
            url,
            name: stripSemanticName(item.name),
            selectedTitle: null,
            selectedIcon: null,
            level: 0,
            isFolder: null,
          };
        });
        if (listItems.length === 0) diagnostics.push({
          code: 'SEMANTIC_LIST_ITEM_MISSING',
          message: 'List 没有可转换的 Frame 或 Instance item，已生成空列表。',
          nodeId: node.id,
          severity: 'warning',
        });
        return {
          kind: 'list',
          ...nodeBase(node),
          layout: node.layout?.mode === 'horizontal' ? ListLayoutType.SingleRow : ListLayoutType.SingleColumn,
          align: 0,
          vAlign: 0,
          lineGap: node.layout?.mode === 'vertical' ? node.layout.gap : 0,
          columnGap: node.layout?.mode === 'horizontal' ? node.layout.gap : 0,
          lineCount: 0,
          columnCount: 0,
          selectionMode: ListSelectionMode.Single,
          defaultItem: listItems[0]?.url ?? '',
          autoResizeItem: true,
          childrenRenderOrder: 0,
          apexIndex: 0,
          src: '',
          overflow: node.clipContent ? OverflowType.Scroll : OverflowType.Visible,
          scrollType: 1,
          scrollBarDisplay: 0,
          scrollBarFlags: 0,
          scrollBarMargin: { top: 0, bottom: 0, left: 0, right: 0 },
          vtScrollBarRes: '',
          hzScrollBarRes: '',
          headerRes: '',
          footerRes: '',
          margin: { top: 0, bottom: 0, left: 0, right: 0 },
          clipSoftness: { x: 0, y: 0 },
          scrollItemToViewOnClick: true,
          foldInvisibleItems: false,
          autoClearItems: false,
          listItems,
          pageController: '',
          controllerOverrides: '',
          selectionController: '',
        };
      }
      if (node.kind === 'image') {
        const binding = imageBindings[node.id];
        const base = nodeBase(node);
        const image = createDefaultUamImageResourceProperties();
        if (binding) {
          base.position = {
            x: base.position.x + binding.trimOffset.x,
            y: base.position.y + binding.trimOffset.y,
          };
          base.size = {
            width: binding.pixelSize.width / binding.pixelRatio,
            height: binding.pixelSize.height / binding.pixelRatio,
          };
          if (binding.scale9Grid) {
            const grid: [number, number, number, number] = [
              (binding.scale9Grid.x - binding.trimOffset.x) * binding.pixelRatio,
              (binding.scale9Grid.y - binding.trimOffset.y) * binding.pixelRatio,
              binding.scale9Grid.width * binding.pixelRatio,
              binding.scale9Grid.height * binding.pixelRatio,
            ];
            if (!grid.every(Number.isInteger) || grid[0] < 0 || grid[1] < 0
              || grid[0] + grid[2] > binding.pixelSize.width
              || grid[1] + grid[3] > binding.pixelSize.height) {
              throw new Error(`Image binding scale9Grid for ${node.id} is outside its trimmed asset`);
            }
            image.scaleOption = 1;
            image.scale9Grid = grid;
          }
        }
        if (directive?.asset?.scale9Grid) {
          const grid = directive.asset.scale9Grid;
          if (grid[0] + grid[2] > (binding?.pixelSize.width ?? node.width)
            || grid[1] + grid[3] > (binding?.pixelSize.height ?? node.height)) {
            throw new Error(`Semantic scale9Grid for ${node.id} is outside its asset`);
          }
          image.scaleOption = 1;
          image.scale9Grid = [...grid];
        }
        const resourceKey = `${node.id}:resource`;
        const dimensions = binding?.pixelSize ?? { width: node.width, height: node.height };
        const contentKey = `${imageContentKey(node.format, node.bytes)}${binding
          ? `:${dimensions.width}x${dimensions.height}:${image.scale9Grid?.join(',') ?? ''}`
          : ''}`;
        const existing = imageResources.get(contentKey)?.find((resource) =>
          resource.sourceBytes instanceof Uint8Array && sameBytes(resource.sourceBytes, node.bytes));
        if (existing) {
          ids[resourceKey] = existing.id;
          return {
            kind: 'image',
            ...base,
            color: '#FFFFFF',
            flip: 0,
            fillMethod: 0,
            fillOrigin: 0,
            fillClockwise: true,
            fillAmount: 100,
            resource: { resourceId: existing.id },
          };
        }
        const resourceId = idFor(resourceKey);
        const name = resourceName(packageId, stripSemanticName(node.name), 'image', node.format);
        const fileName = `${name}.${node.format}`;
        const resource: Extract<UamResource, { kind: 'image' }> = {
          kind: 'image',
          id: resourceId,
          name,
          path: exported ? '/' : '/_internal/assets/',
          exported,
          favorite: false,
          branch: '',
          branchItemIds: [],
          fileName,
          dimensions,
          image,
          sourceBytes: node.bytes,
        };
        resources.push(resource);
        imageResources.set(contentKey, [...(imageResources.get(contentKey) ?? []), resource]);
        return {
          kind: 'image',
          ...base,
          color: '#FFFFFF',
          flip: 0,
          fillMethod: 0,
          fillOrigin: 0,
          fillClockwise: true,
          fillAmount: 100,
          resource: { resourceId },
        };
      }

      const resourceId = convertFrame(node, exported, resourcePath);
      return { kind: 'component', ...nodeBase(node), resource: { resourceId } };
    };

    const convertDisplayNode = (
      node: ImportNode,
      offsetX = 0,
      offsetY = 0,
      memberGroup = '',
    ): UamDisplayNode[] => {
      const target = directiveFor(node)?.target;
      if (target === 'ignore') return [];
      if (node.kind === 'frame' && canFlattenGroup(node) && (!target || target === 'auto')) {
        const id = idFor(`${node.id}:node`);
        const children = node.children.flatMap((child) =>
          convertDisplayNode(child, offsetX + node.x, offsetY + node.y, id));
        children.push(groupNode(
          node,
          id,
          node.name,
          { x: offsetX + node.x, y: offsetY + node.y },
          null,
          memberGroup,
          true,
        ));
        return children;
      }

      const converted = convertNode(node);
      converted.position = {
        x: converted.position.x + offsetX,
        y: converted.position.y + offsetY,
      };
      if ('group' in converted) converted.group = memberGroup;
      if (node.kind !== 'shape' || node.shadows.length === 0 || converted.kind !== 'graph') return [converted];
      return [
        ...node.shadows.map((shadow, index) => ({
          ...converted,
          id: idFor(`${node.id}:shadow:${index}`),
          name: `${node.name} shadow`,
          position: {
            x: converted.position.x + shadow.offsetX,
            y: converted.position.y + shadow.offsetY,
          },
          touchable: false,
          lineSize: 0,
          lineColor: '#000000',
          fillColor: shadow.color,
        })),
        converted,
      ];
    };

    const convertFrame = (frame: ImportFrame, exported: boolean, resourcePath?: string, key?: string): string => {
      const resourceId = idFor(key ?? `${frame.id}:resource`);
      const existing = componentResources.get(resourceId);
      if (existing) {
        if (exported) existing.exported = true;
        return resourceId;
      }
      const directive = directiveFor(frame);
      const name = resourceName(packageId, directive?.componentKey ?? stripSemanticName(frame.name), 'Component', 'xml');
      if (frame.sourceType === 'componentSet' && frame.children.filter((child) => child.kind === 'frame').length >= 2) {
        const variants = frame.children.filter((child): child is ImportFrame => child.kind === 'frame');
        const variantPath = `/_variants/${safeName(stripSemanticName(frame.name), 'VariantSet')}/`;
        const controllerPages = variants.map((variant) => ({
          id: idFor(`${frame.id}:variant:${variant.id}:page`),
          remark: '',
          name: Object.entries(variant.variantProperties)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`)
            .join(' · ')
            .replaceAll(',', '，') || stripSemanticName(variant.name).replaceAll(',', '，'),
        }));
        const displayList = variants.map((variant, index) => ({
          ...convertNode(variant, false, variantPath),
          position: { x: 0, y: 0 },
          gears: [{
            kind: 'display' as const,
            name: '',
            controllerName: 'Variant',
            visibleOnPageIds: [controllerPages[index].id],
          }],
        }));
        const properties = createDefaultUamComponentProperties();
        properties.extensionType = extensionTypeForTarget(directive?.target ?? 'auto') ?? '';
        const resource: Extract<UamResource, { kind: 'component' }> = {
          kind: 'component',
          id: resourceId,
          name,
          path: resourcePath ?? (exported ? '/' : '/_internal/'),
          exported,
          favorite: false,
          branch: '',
          branchItemIds: [],
          component: {
            size: {
              width: Math.max(...variants.map((variant) => variant.width)),
              height: Math.max(...variants.map((variant) => variant.height)),
            },
            properties,
            customData: '',
            displayList,
            controllers: [{
              name: 'Variant',
              selectedIndex: 0,
              autoRadioGroupDepth: false,
              alias: '',
              exported: false,
              homePageType: 'default',
              homePage: '',
              pages: controllerPages,
              actions: [],
            }],
            transitions: [],
          },
        };
        componentResources.set(resourceId, resource);
        resources.push(resource);
        return resourceId;
      }

      const layoutGroupId = frame.layout && directive?.target !== 'list' ? idFor(`${frame.id}:layout`) : '';
      const displayList = directive?.target === 'list'
        ? [{ ...convertNode(frame), position: { x: 0, y: 0 } }]
        : frame.children.flatMap((child) => convertDisplayNode(child, 0, 0, child.layoutChild ? layoutGroupId : ''));
      if (frame.layout && directive?.target !== 'list') displayList.push(groupNode(
        frame,
        layoutGroupId,
        'Auto Layout',
        { x: 0, y: 0 },
        frame.layout,
      ));
      const properties = createDefaultUamComponentProperties();
      properties.extensionType = extensionTypeForTarget(directive?.target ?? 'auto') ?? '';
      properties.overflow = frame.clipContent ? OverflowType.Hidden : OverflowType.Visible;
      if (frame.backgroundColor) {
        properties.bgColor = frame.backgroundColor;
        properties.bgColorEnabled = true;
      }
      const mask = frame.children.find((child) => child.mask);
      if (mask) properties.mask = idFor(`${mask.id}:node`);
      const resource: Extract<UamResource, { kind: 'component' }> = {
        kind: 'component',
        id: resourceId,
        name,
        path: resourcePath ?? (exported ? '/' : '/_internal/'),
        exported,
        favorite: false,
        branch: '',
        branchItemIds: [],
        component: {
          size: { width: frame.width, height: frame.height },
          properties,
          customData: '',
          displayList,
          controllers: [],
          transitions: [],
        },
      };
      componentResources.set(resourceId, resource);
      resources.push(resource);
      return resourceId;
    };

    page.roots.forEach((root) => {
      const rootPlan = rootPlans.get(root.id)!;
      convertFrame(root, rootPlan.exported, undefined, rootPlan.key);
    });
    const baseName = safeName(page.name, pageIndex === 0 ? 'Main' : `Page${pageIndex + 1}`);
    let name = baseName;
    for (let suffix = 2; packageNames.has(name); suffix += 1) name = `${baseName}_${suffix}`;
    packageNames.add(name);
    return {
      id: packageId,
      name,
      compressPNG: null,
      jpegQuality: null,
      publish: null,
      branchNames: [],
      folders: [],
      resources,
    };
  });

  const componentIndex = new Map(packages.flatMap((pkg) => pkg.resources
    .filter((resource): resource is Extract<UamResource, { kind: 'component' }> => resource.kind === 'component')
    .map((resource) => [resource.id, { pkg, resource }] as const)));
  type ComponentEntry = NonNullable<ReturnType<typeof componentIndex.get>>;

  const findTargetRoute = (
    source: ComponentEntry,
    targetId: string,
    visited = new Set<string>(),
  ): string[] | undefined => {
    if (source.resource.component.displayList.some((node) => node.id === targetId)) return [];
    if (visited.has(source.resource.id)) return undefined;
    const nextVisited = new Set(visited).add(source.resource.id);
    for (const node of source.resource.component.displayList) {
      if (node.kind !== 'component') continue;
      const child = componentIndex.get(node.resource.resourceId);
      if (!child) continue;
      const nested = findTargetRoute(child, targetId, nextVisited);
      if (nested) return [node.id, ...nested];
    }
    return undefined;
  };

  const explicitTargetRoute = (
    source: ComponentEntry,
    override: ImportInstanceOverride,
    targetId: string,
  ): string[] | undefined => {
    let current = source;
    const route: string[] = [];
    for (const sourceId of override.targetPath) {
      const nodeId = ids[`${sourceId}:node`];
      if (!nodeId) continue;
      const node = current.resource.component.displayList.find((item) => item.id === nodeId);
      if (!node) continue;
      if (node.id === targetId) return route;
      if (node.kind !== 'component') continue;
      const child = componentIndex.get(node.resource.resourceId);
      if (!child) return undefined;
      route.push(node.id);
      current = child;
    }
    return current.resource.component.displayList.some((node) => node.id === targetId) ? route : undefined;
  };

  const applyOverride = (
    target: UamDisplayNode,
    override: ImportInstanceOverride,
    ownerPackageId: string,
  ): void => {
    if (override.componentId !== null && target.kind === 'component') {
      const resourceId = ids[`${override.componentId}:resource`];
      const packageId = componentPackages.get(override.componentId);
      if (resourceId) target.resource = {
        resourceId,
        ...(packageId && packageId !== ownerPackageId ? { packageId } : {}),
      };
    }
    if (override.name !== null) target.name = override.name;
    if (override.visible !== null) target.visible = override.visible;
    if (override.opacity !== null) target.alpha = override.opacity;
    if (override.width !== null) target.size.width = override.width;
    if (override.height !== null) target.size.height = override.height;
    if (override.text !== null && (target.kind === 'text' || target.kind === 'richText')) {
      target.text = override.text;
      target.ubbEnabled = false;
    }
    if (override.fillColor !== null) {
      if (target.kind === 'graph') target.fillColor = override.fillColor;
      if (target.kind === 'text' || target.kind === 'richText') target.color = override.fillColor;
    }
    if (target.kind === 'graph') {
      if (override.strokeColor !== null) target.lineColor = override.strokeColor;
      if (override.strokeWidth !== null) target.lineSize = override.strokeWidth;
      if (override.cornerRadius !== null && target.graphType === GraphType.Rect) {
        target.cornerRadius = override.cornerRadius;
      }
    }
    if (target.kind === 'text' || target.kind === 'richText') {
      if (override.fontFamily !== null) target.font = override.fontFamily;
      if (override.fontSize !== null) target.fontSize = Math.max(1, Math.round(override.fontSize));
      if (override.bold !== null) target.bold = override.bold;
      if (override.italic !== null) target.italic = override.italic;
      if (override.underline !== null) target.underline = override.underline;
      if (override.strikethrough !== null) target.strikethrough = override.strikethrough;
    }
  };

  for (const pending of pendingOverrides) {
    const sourceId = ids[`${pending.instance.componentId}:resource`];
    const source = sourceId && componentIndex.get(sourceId);
    const targetPackage = packages.find((pkg) => pkg.id === pending.packageId);
    if (!source || !targetPackage) continue;
    const cloned = structuredClone(source.resource);
    cloned.id = pending.resourceId;
    cloned.name = resourceName(pending.packageId, stripSemanticName(pending.instance.name), 'Instance', 'xml');
    cloned.path = '/_internal/overrides/';
    cloned.exported = false;
    targetPackage.resources.push(cloned);
    const clonedRoot = { pkg: targetPackage, resource: cloned };
    componentIndex.set(cloned.id, clonedRoot);
    const clonedEdges = new Map<string, ComponentEntry>();
    for (const override of pending.instance.overrides) {
      const targetId = ids[`${override.targetId}:node`];
      if (!targetId) continue;
      const route = explicitTargetRoute(source, override, targetId) ?? findTargetRoute(source, targetId);
      if (!route) {
        diagnostics.push({
          code: 'INSTANCE_OVERRIDE_TARGET_MISSING',
          message: 'Instance override 的目标节点未进入可达组件资源，已保留默认值。',
          nodeId: pending.instance.id,
          severity: 'warning',
        });
        continue;
      }
      let current = clonedRoot;
      for (const componentNodeId of route) {
        const componentNode = current.resource.component.displayList.find((node) => node.id === componentNodeId);
        if (componentNode?.kind !== 'component') break;
        const edgeKey = `${current.resource.id}:${componentNode.id}`;
        let childClone = clonedEdges.get(edgeKey);
        if (!childClone) {
          const childSource = componentIndex.get(componentNode.resource.resourceId);
          if (!childSource) break;
          const childResource = structuredClone(childSource.resource);
          childResource.id = idFor(`${pending.instance.id}:override-resource:${edgeKey}`);
          childResource.name = resourceName(
            childSource.pkg.id,
            `${pending.instance.name} ${childSource.resource.name}`,
            'Instance',
            'xml',
          );
          childResource.exported = false;
          childResource.path = '/_internal/overrides/';
          childSource.pkg.resources.push(childResource);
          childClone = { pkg: childSource.pkg, resource: childResource };
          componentIndex.set(childResource.id, childClone);
          clonedEdges.set(edgeKey, childClone);
          componentNode.resource = {
            resourceId: childResource.id,
            ...(childSource.pkg.id !== current.pkg.id ? { packageId: childSource.pkg.id } : {}),
          };
        }
        current = childClone;
      }
      const target = current.resource.component.displayList.find((node) => node.id === targetId);
      if (!target) continue;
      applyOverride(target, override, current.pkg.id);
    }
  }

  const project = normalizeUamProject({
    projectId: idFor('$project'),
    projectType: 0,
    version: '3.0',
    branches: [],
    settings: {
      publish: {
        binaryFormat: true,
        fileExtension: 'bytes',
        compressDesc: false,
      },
      common: {},
      adaptation: {},
    },
    packages,
  });
  assertValidUamProject(project);
  const convertedDocument = { ...document, diagnostics };
  return {
    project,
    ids,
    diagnostics,
    report: createConversionReport(convertedDocument, previousIds, ids),
  };
}
