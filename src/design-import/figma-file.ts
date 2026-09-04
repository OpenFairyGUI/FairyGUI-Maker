import {
  extractRenderableGradientFill,
  nodeId,
  parseFig,
  resolveGradientGeometry,
  resolveVectorNodePaths,
  type FigDocument,
  type FigNode,
  type FigPaint,
  type ResolvedGeometryPath,
} from 'openfig-core';
import { Resvg } from '@resvg/resvg-js';
import type {
  Diagnostic,
  ImportConstraint,
  ImportConstraints,
  ImportDocument,
  ImportFrame,
  ImportImage,
  ImportInstance,
  ImportInstanceOverride,
  ImportLayout,
  ImportNode,
  ImportPage,
  ImportShadow,
  ImportShape,
  ImportText,
  ImportTextRun,
} from './model';

const CONTAINERS = new Set(['FRAME', 'GROUP', 'SYMBOL', 'COMPONENT_SET']);
const ROOTS = new Set(['FRAME', 'SYMBOL', 'COMPONENT_SET']);
export type FigmaVectorFallback = 'skip' | 'svg' | 'png';

function id(node: FigNode): string {
  const value = nodeId(node);
  if (!value) throw new Error('Figma .fig node is missing a GUID');
  return value;
}

function guidId(value: unknown): string | undefined {
  const guid = value as { sessionID?: unknown; localID?: unknown } | undefined;
  return Number.isInteger(guid?.sessionID) && Number.isInteger(guid?.localID)
    ? `${guid!.sessionID}:${guid!.localID}`
    : undefined;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function compareFigmaPositions(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nodeSize(node: FigNode): { width: number; height: number } | undefined {
  const width = finite(node.size?.x, Number.NaN);
  const height = finite(node.size?.y, Number.NaN);
  return Number.isFinite(width) && Number.isFinite(height) && width >= 0 && height >= 0
    ? { width, height }
    : undefined;
}

function children(document: FigDocument, node: FigNode): FigNode[] {
  return [...(document.childrenMap.get(id(node)) ?? [])]
    .filter((child) => child.phase !== 'REMOVED')
    .sort((left, right) => compareFigmaPositions(
      left.parentIndex?.position ?? '',
      right.parentIndex?.position ?? '',
    ));
}

export function collectFigmaPageRoots(
  document: FigDocument,
  node: FigNode,
  diagnostics: Diagnostic[],
): FigNode[] {
  if (ROOTS.has(node.type)) return [node];
  if (node.type === 'SECTION') {
    return children(document, node).flatMap((child) => collectFigmaPageRoots(document, child, diagnostics));
  }
  diagnostics.push({
    code: 'ROOT_NODE_IGNORED',
    message: `${node.type} 不能作为 FairyGUI component 根节点，已忽略。`,
    nodeId: id(node),
    severity: 'warning',
  });
  return [];
}

export function inferResizeToFitSize(
  document: FigDocument,
  node: FigNode,
): { width: number; height: number } | undefined {
  if (node.resizeToFit !== true || !CONTAINERS.has(node.type)) return undefined;
  const items = children(document, node);
  if (items.length === 0) return undefined;
  let width = 0;
  let height = 0;
  for (const child of items) {
    const size = nodeSize(child) ?? inferResizeToFitSize(document, child);
    const x = finite(child.transform?.m02, Number.NaN);
    const y = finite(child.transform?.m12, Number.NaN);
    if (!size || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) return undefined;
    width = Math.max(width, x + size.width);
    height = Math.max(height, y + size.height);
  }
  return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : undefined;
}

function isLegacyComponentSet(document: FigDocument, node: FigNode): boolean {
  return node.type === 'FRAME'
    && Array.isArray(node.stateGroupPropertyValueOrders)
    && node.stateGroupPropertyValueOrders.length > 0
    && children(document, node).filter((child) => child.type === 'SYMBOL').length >= 2;
}

function componentRoots(document: FigDocument, node: FigNode): FigNode[] {
  if (node.type === 'SYMBOL' || node.type === 'COMPONENT_SET' || isLegacyComponentSet(document, node)) return [node];
  return children(document, node).flatMap((child) => componentRoots(document, child));
}

function collectComponentIds(document: FigDocument, node: FigNode, result: Set<string>): void {
  if (node.type === 'SYMBOL') result.add(id(node));
  children(document, node).forEach((child) => collectComponentIds(document, child, result));
}

function variantProperties(document: FigDocument, node: FigNode): Record<string, string> {
  if (node.variantProperties && typeof node.variantProperties === 'object') {
    return Object.fromEntries(Object.entries(node.variantProperties)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  }
  if (node.type !== 'SYMBOL' || !Array.isArray(node.variantPropSpecs)) return {};
  const parentId = guidId(node.parentIndex?.guid);
  const parent = parentId ? document.nodeMap.get(parentId) : undefined;
  const names = new Map<string, string>();
  for (const definition of parent?.componentPropDefs ?? []) {
    const definitionId = guidId(definition.id);
    if (definitionId && typeof definition.name === 'string') names.set(definitionId, definition.name);
  }
  return Object.fromEntries(node.variantPropSpecs
    .map((spec: { propDefId?: unknown; value?: unknown }) => [names.get(guidId(spec.propDefId) ?? ''), spec.value])
    .filter((entry): entry is [string, string] => !!entry[0] && typeof entry[1] === 'string'));
}

function constraint(value: unknown): ImportConstraint {
  return ({ CENTER: 'center', MAX: 'max', STRETCH: 'stretch', SCALE: 'scale' } as const)[String(value)] ?? 'min';
}

function nodeConstraints(node: FigNode): ImportConstraints {
  return {
    horizontal: constraint(node.horizontalConstraint),
    vertical: constraint(node.verticalConstraint),
  };
}

function base(node: FigNode, root = false, inferredSize?: { width: number; height: number }) {
  const size = nodeSize(node) ?? inferredSize;
  if (!size) {
    throw new Error(`Figma .fig node ${id(node)} has invalid bounds`);
  }
  const m00 = finite(node.transform?.m00, 1);
  const m01 = finite(node.transform?.m01, 0);
  const m10 = finite(node.transform?.m10, 0);
  const m11 = finite(node.transform?.m11, 1);
  const scaleX = Math.hypot(m00, m10);
  const determinant = m00 * m11 - m01 * m10;
  return {
    id: id(node),
    name: node.name || node.type,
    x: root ? 0 : finite(node.transform?.m02, 0),
    y: root ? 0 : finite(node.transform?.m12, 0),
    width: size.width,
    height: size.height,
    visible: node.visible !== false,
    opacity: Math.min(1, Math.max(0, finite(node.opacity, 1))),
    rotation: Math.atan2(m10, m00) * 180 / Math.PI,
    scaleX: scaleX > 1e-8 ? scaleX : 1,
    scaleY: scaleX > 1e-8 ? determinant / scaleX : Math.hypot(m01, m11),
    mask: isFigmaMask(node),
    constraints: nodeConstraints(node),
    layoutChild: node.stackPositioning !== 'ABSOLUTE',
  };
}

export function isFigmaMask(node: FigNode): boolean {
  return node.mask === true || node.isMask === true;
}

function isFigmaGroup(node: FigNode): boolean {
  return node.type === 'GROUP' || (node.type === 'FRAME' && node.resizeToFit === true);
}

function defaultConstraints(node: ImportNode): boolean {
  return !node.constraints
    || (node.constraints.horizontal === 'min' && node.constraints.vertical === 'min');
}

function flattenableGroup(node: FigNode, sourceChildren: FigNode[], convertedChildren: ImportNode[]): boolean {
  const transform = node.transform;
  const identityTransform = !transform || (
    Math.abs(finite(transform.m00, 1) - 1) < 1e-6
    && Math.abs(finite(transform.m01, 0)) < 1e-6
    && Math.abs(finite(transform.m10, 0)) < 1e-6
    && Math.abs(finite(transform.m11, 1) - 1) < 1e-6
  );
  return isFigmaGroup(node)
    && sourceChildren.length > 0
    && sourceChildren.length === convertedChildren.length
    && identityTransform
    && finite(node.opacity, 1) === 1
    && !isFigmaMask(node)
    && !(Array.isArray(node.prototypeInteractions) && node.prototypeInteractions.length > 0)
    && [undefined, 'NONE'].includes(node.stackMode)
    && [undefined, 'PASS_THROUGH'].includes(node.blendMode)
    && paints(node.fillPaints).length === 0
    && paints(node.strokePaints).length === 0
    && !(node.effects ?? []).some((effect) => effect.visible !== false)
    && sourceChildren.every((child) => !isFigmaMask(child))
    && convertedChildren.every(defaultConstraints);
}

function paints(value: FigPaint[] | undefined): FigPaint[] {
  return (value ?? []).filter((paint) => paint.visible !== false);
}

function onlyPaint(value: FigPaint[] | undefined, type: string): FigPaint | undefined {
  const visible = paints(value);
  return visible.length === 1 && visible[0].type === type ? visible[0] : undefined;
}

type Point = { x: number; y: number };
const PATH_EPSILON = 1e-7;

function samePoint(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) <= PATH_EPSILON && Math.abs(left.y - right.y) <= PATH_EPSILON;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: Point, b: Point, point: Point): boolean {
  return Math.abs(cross(a, b, point)) <= PATH_EPSILON
    && point.x >= Math.min(a.x, b.x) - PATH_EPSILON
    && point.x <= Math.max(a.x, b.x) + PATH_EPSILON
    && point.y >= Math.min(a.y, b.y) - PATH_EPSILON
    && point.y <= Math.max(a.y, b.y) + PATH_EPSILON;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const abc = cross(a, b, c);
  const abd = cross(a, b, d);
  const cda = cross(c, d, a);
  const cdb = cross(c, d, b);
  if (Math.abs(abc) <= PATH_EPSILON && onSegment(a, b, c)) return true;
  if (Math.abs(abd) <= PATH_EPSILON && onSegment(a, b, d)) return true;
  if (Math.abs(cda) <= PATH_EPSILON && onSegment(c, d, a)) return true;
  if (Math.abs(cdb) <= PATH_EPSILON && onSegment(c, d, b)) return true;
  return (abc > 0) !== (abd > 0) && (cda > 0) !== (cdb > 0);
}

function polygonPoints(commands: Uint8Array): number[] | undefined {
  const view = new DataView(commands.buffer, commands.byteOffset, commands.byteLength);
  const points: Point[] = [];
  let offset = 0;
  while (offset < commands.byteLength) {
    const command = commands[offset++];
    if (command === 0) {
      if (offset !== commands.byteLength) return undefined;
      break;
    }
    if (command !== (points.length === 0 ? 1 : 2) || offset + 8 > commands.byteLength) return undefined;
    points.push({ x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true) });
    offset += 8;
  }
  if (commands.at(-1) !== 0) return undefined;
  if (points.length > 1 && samePoint(points[0], points.at(-1)!)) points.pop();
  if (points.length < 3 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return undefined;
  }
  if (points.some((point, index) => samePoint(point, points[(index + 1) % points.length]))) return undefined;
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) <= PATH_EPSILON) return undefined;
  for (let left = 0; left < points.length; left += 1) {
    for (let right = left + 1; right < points.length; right += 1) {
      if (right === left + 1 || (left === 0 && right === points.length - 1)) continue;
      if (segmentsIntersect(
        points[left],
        points[(left + 1) % points.length],
        points[right],
        points[(right + 1) % points.length],
      )) return undefined;
    }
  }
  return points.flatMap((point) => [point.x, point.y]);
}

function color(paint: FigPaint): string | undefined {
  if (!paint.color) return undefined;
  const rgb = [paint.color.r, paint.color.g, paint.color.b]
    .map((channel) => Math.round(Math.min(1, Math.max(0, finite(channel, 0))) * 255).toString(16).padStart(2, '0'))
    .join('');
  const alpha = Math.round(
    Math.min(1, Math.max(0, finite(paint.opacity, 1) * finite(paint.color.a, 1))) * 255,
  );
  return alpha === 255 ? `#${rgb}` : `#${alpha.toString(16).padStart(2, '0')}${rgb}`;
}

function shadows(node: FigNode): ImportShadow[] | undefined {
  const effects = (node.effects ?? []).filter((effect) => effect.visible !== false);
  const result: ImportShadow[] = [];
  for (const effect of effects) {
    if (effect.type !== 'DROP_SHADOW'
      || finite(effect.radius, 0) !== 0
      || finite(effect.spread, 0) !== 0
      || ![undefined, 'NORMAL'].includes(effect.blendMode)) return undefined;
    const shadowColor = effect.color && color({ type: 'SOLID', color: effect.color, opacity: effect.opacity });
    if (!shadowColor) return undefined;
    result.push({
      color: shadowColor,
      offsetX: finite(effect.offset?.x, 0),
      offsetY: finite(effect.offset?.y, 0),
    });
  }
  return result;
}

export function figImageKey(paint: FigPaint): string | undefined {
  const image = paint.image as { hash?: Uint8Array | string; name?: string } | undefined;
  if (typeof image?.hash === 'string') return image.hash;
  const hash = image?.hash
    ? [...image.hash].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    : undefined;
  return hash || image?.name || undefined;
}

function imageNode(
  document: FigDocument,
  node: FigNode,
  diagnostics: Diagnostic[],
): ImportImage | undefined {
  const paint = onlyPaint(node.fillPaints, 'IMAGE');
  const key = paint && figImageKey(paint);
  const bytes = key ? document.images.get(key) : undefined;
  if (!bytes) return undefined;
  if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) {
    diagnostics.push({
      code: 'FIG_IMAGE_FORMAT_UNSUPPORTED',
      message: '本地 .fig 内嵌图片不是 PNG，当前输出格式无法安全保留该资源。',
      nodeId: id(node),
      severity: 'warning',
    });
    return undefined;
  }
  diagnostics.push({
    code: 'FIG_IMAGE_FILL_APPROXIMATED',
    message: '本地 .fig PNG 填充已保留原图；裁剪、缩放模式和圆角尚未烘焙。',
    nodeId: id(node),
    severity: 'warning',
  });
  return { kind: 'image', ...base(node), format: 'png', bytes };
}

function shapeNode(node: FigNode, diagnostics: Diagnostic[]): ImportShape | undefined {
  if (!['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE'].includes(node.type)) return undefined;
  const fills = paints(node.fillPaints);
  const strokes = paints(node.strokePaints);
  if (fills.length > 1 || strokes.length > 1) return undefined;
  if (fills[0] && fills[0].type !== 'SOLID') return undefined;
  if (strokes[0] && strokes[0].type !== 'SOLID') return undefined;
  const fillColor = fills[0] ? color(fills[0]) : '#00ffffff';
  const strokeColor = strokes[0] ? color(strokes[0]) ?? null : null;
  if (!fillColor || (strokes[0] && !strokeColor)) return undefined;
  const radius = Math.max(0, finite(node.cornerRadius, 0));
  const mappedShadows = shadows(node);
  if (mappedShadows === undefined) {
    diagnostics.push({
      code: 'FIG_EFFECTS_IGNORED',
      message: '本地 .fig 基础图形包含 FairyGUI Graph 无法表达的模糊、内阴影或混合效果。',
      nodeId: id(node),
      severity: 'warning',
    });
  }
  return {
    kind: 'shape',
    ...base(node),
    shape: node.type === 'ELLIPSE' ? 'ellipse' : 'rectangle',
    fillColor,
    strokeColor: strokeColor ?? null,
    strokeWidth: strokeColor ? Math.max(0, finite(node.strokeWeight, 1)) : 0,
    cornerRadius: node.type === 'ELLIPSE' || radius === 0 ? null : [radius, radius, radius, radius],
    points: null,
    shadows: mappedShadows ?? [],
  };
}

function vectorNode(document: FigDocument, node: FigNode): ImportShape | undefined {
  if (node.type !== 'VECTOR' || (node.effects ?? []).some((effect) => effect.visible !== false)) return undefined;
  if (node.blendMode !== undefined && node.blendMode !== 'NORMAL') return undefined;
  let paths;
  try {
    paths = resolveVectorNodePaths(document, node);
  } catch {
    return undefined;
  }
  if (paths.fill.length !== 1) return undefined;
  const points = polygonPoints(paths.fill[0].commandsBlob);
  if (!points) return undefined;
  const fills = paints(paths.fill[0].paints ?? node.fillPaints);
  const strokes = paints(node.strokePaints);
  if (fills.length > 1 || strokes.length > 1) return undefined;
  if (fills[0] && (fills[0].type !== 'SOLID' || ![undefined, 'NORMAL'].includes(fills[0].blendMode))) {
    return undefined;
  }
  if (strokes[0] && (strokes[0].type !== 'SOLID' || ![undefined, 'NORMAL'].includes(strokes[0].blendMode))) {
    return undefined;
  }
  const strokeWidth = strokes[0] ? finite(node.strokeWeight, Number.NaN) : 0;
  if (!Number.isFinite(strokeWidth) || strokeWidth < 0) return undefined;
  if (strokeWidth > 0 && (
    ![undefined, 'CENTER'].includes(node.strokeAlign)
    || ![undefined, 'MITER'].includes(node.strokeJoin)
    || ![undefined, 'NONE'].includes(node.strokeCap)
    || (Array.isArray(node.dashPattern) && node.dashPattern.length > 0)
  )) return undefined;
  const fillColor = fills[0] ? color(fills[0]) : '#00ffffff';
  const strokeColor = strokeWidth > 0 && strokes[0] ? color(strokes[0]) : null;
  if (!fillColor || (strokeWidth > 0 && !strokeColor) || (fills.length === 0 && !strokeColor)) return undefined;
  return {
    kind: 'shape',
    ...base(node),
    shape: 'polygon',
    fillColor,
    strokeColor: strokeColor ?? null,
    strokeWidth: strokeColor ? strokeWidth : 0,
    cornerRadius: null,
    points,
    shadows: [],
  };
}

interface SvgContext {
  definitions: string[];
  nextId: number;
  leaves: number;
}

function svgColor(color: { r?: number; g?: number; b?: number }): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(Math.min(1, Math.max(0, finite(channel, 0))) * 255)
      .toString(16).padStart(2, '0'))
    .join('')}`;
}

function svgPaint(
  paint: FigPaint,
  size: { width: number; height: number },
  context: SvgContext,
): { value: string; opacity: number } | undefined {
  if (![undefined, 'NORMAL'].includes(paint.blendMode)) return undefined;
  if (paint.type === 'SOLID' && paint.color) return {
    value: svgColor(paint.color),
    opacity: Math.min(1, Math.max(0, finite(paint.opacity, 1) * finite(paint.color.a, 1))),
  };
  const gradient = extractRenderableGradientFill([paint]);
  const geometry = gradient && resolveGradientGeometry(gradient, size.width, size.height);
  if (!gradient || !geometry) return undefined;
  const gradientId = `gradient${context.nextId++}`;
  const stops = gradient.stops.map((stop) => {
    const opacity = Math.min(1, Math.max(0, gradient.opacity * finite(stop.color.a, 1)));
    return `<stop offset="${Math.min(1, Math.max(0, stop.position))}" stop-color="${svgColor(stop.color)}" stop-opacity="${opacity}"/>`;
  }).join('');
  if (geometry.type === 'linear') {
    context.definitions.push(`<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${geometry.start.x}" y1="${geometry.start.y}" x2="${geometry.end.x}" y2="${geometry.end.y}">${stops}</linearGradient>`);
  } else {
    const angle = geometry.angle * 180 / Math.PI;
    context.definitions.push(`<radialGradient id="${gradientId}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${geometry.center.x} ${geometry.center.y}) rotate(${angle}) scale(${geometry.radiusX} ${geometry.radiusY})">${stops}</radialGradient>`);
  }
  return { value: `url(#${gradientId})`, opacity: 1 };
}

function svgPathElements(
  paths: ResolvedGeometryPath[],
  fallbackPaints: FigPaint[] | undefined,
  size: { width: number; height: number },
  context: SvgContext,
): string[] | undefined {
  const result: string[] = [];
  for (const path of paths) {
    const pathPaints = paints(path.paints ?? fallbackPaints);
    const styles = pathPaints.map((paint) => svgPaint(paint, size, context));
    if (styles.some((style) => !style)) return undefined;
    const d = path.svgPath.trim().replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    if (!d) continue;
    const fillRule = path.windingRule?.toLowerCase().includes('even') ? 'evenodd' : 'nonzero';
    for (const style of styles) {
      result.push(`<path d="${d}" fill="${style!.value}" fill-opacity="${style!.opacity}" fill-rule="${fillRule}"/>`);
    }
  }
  return result;
}

function svgBytes(
  svg: string,
  format: Exclude<FigmaVectorFallback, 'skip'>,
  loadSystemFonts = false,
): Uint8Array | undefined {
  if (format === 'svg') return new TextEncoder().encode(svg);
  try {
    return new Uint8Array(new Resvg(svg, { font: { loadSystemFonts } }).render().asPng());
  } catch {
    return undefined;
  }
}

function vectorFallbackNode(
  document: FigDocument,
  node: FigNode,
  diagnostics: Diagnostic[],
  format: Exclude<FigmaVectorFallback, 'skip'>,
): ImportImage | undefined {
  if (!['VECTOR', 'BOOLEAN_OPERATION'].includes(node.type)
    || (node.effects ?? []).some((effect) => effect.visible !== false)
    || ![undefined, 'NORMAL'].includes(node.blendMode)) return undefined;
  const size = nodeSize(node);
  if (!size || size.width <= 0 || size.height <= 0) return undefined;
  let paths;
  try {
    paths = resolveVectorNodePaths(document, node);
  } catch {
    return undefined;
  }
  const context: SvgContext = { definitions: [], nextId: 1, leaves: 1 };
  const fill = svgPathElements(paths.fill, node.fillPaints, size, context);
  const stroke = svgPathElements(paths.stroke, node.strokePaints, size, context);
  if (!fill || !stroke || fill.length + stroke.length === 0) return undefined;
  const definitions = context.definitions.length > 0 ? `<defs>${context.definitions.join('')}</defs>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${definitions}${fill.join('')}${stroke.join('')}</svg>`;
  const bytes = svgBytes(svg, format);
  if (!bytes) return undefined;
  diagnostics.push({
    code: format === 'png' ? 'RASTERIZED_NODE' : 'FIG_VECTOR_SVG_FALLBACK',
    message: `${node.type} 曲线或复合几何已回退为 ${format.toUpperCase()} 图片。`,
    nodeId: id(node),
    severity: 'warning',
  });
  return { kind: 'image', ...base(node), format, bytes };
}

function roundedRectPath(width: number, height: number, radii: [number, number, number, number]): string {
  const [topLeft, topRight, bottomRight, bottomLeft] = radii.map((value) =>
    Math.min(Math.max(0, value), width / 2, height / 2)) as typeof radii;
  return `M${topLeft} 0H${width - topRight}A${topRight} ${topRight} 0 0 1 ${width} ${topRight}V${height - bottomRight}A${bottomRight} ${bottomRight} 0 0 1 ${width - bottomRight} ${height}H${bottomLeft}A${bottomLeft} ${bottomLeft} 0 0 1 0 ${height - bottomLeft}V${topLeft}A${topLeft} ${topLeft} 0 0 1 ${topLeft} 0Z`;
}

function svgShapeElements(node: FigNode, context: SvgContext, ignoreEffects = false): string[] | undefined {
  if (!['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE'].includes(node.type)
    || !ignoreEffects && (node.effects ?? []).some((effect) => effect.visible !== false)
    || ![undefined, 'NORMAL'].includes(node.blendMode)) return undefined;
  const size = nodeSize(node);
  if (!size || size.width <= 0 || size.height <= 0) return undefined;
  const radii = frameCornerRadius(node) ?? [0, 0, 0, 0];
  const geometry = node.type === 'ELLIPSE'
    ? `<ellipse cx="${size.width / 2}" cy="${size.height / 2}" rx="${size.width / 2}" ry="${size.height / 2}"`
    : `<path d="${roundedRectPath(size.width, size.height, radii)}"`;
  const result: string[] = [];
  for (const paint of paints(node.fillPaints)) {
    const style = svgPaint(paint, size, context);
    if (!style) return undefined;
    result.push(`${geometry} fill="${style.value}" fill-opacity="${style.opacity}"/>`);
  }
  const strokeWidth = Math.max(0, finite(node.strokeWeight, 1));
  for (const paint of paints(node.strokePaints)) {
    const style = svgPaint(paint, size, context);
    if (!style || ![undefined, 'CENTER'].includes(node.strokeAlign)) return undefined;
    result.push(`${geometry} fill="none" stroke="${style.value}" stroke-opacity="${style.opacity}" stroke-width="${strokeWidth}"/>`);
  }
  context.leaves += 1;
  return result;
}

function svgEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!);
}

function svgTextElements(node: FigNode, context: SvgContext): string[] | undefined {
  const text = node.textData?.characters;
  const size = nodeSize(node);
  const fontSize = finite(node.fontSize, Number.NaN);
  const fontFamily = node.fontName?.family;
  const styleIds = (node.textData as { characterStyleIDs?: unknown[] } | undefined)?.characterStyleIDs;
  if (node.type !== 'TEXT' || typeof text !== 'string' || /[\r\n]/.test(text)
    || !size || size.width <= 0 || size.height <= 0
    || !Number.isFinite(fontSize) || fontSize <= 0 || !fontFamily
    || Array.isArray(styleIds) && styleIds.some((value) => value !== 0)
    || paints(node.strokePaints).length > 0
    || (node.effects ?? []).some((effect) => effect.visible !== false)
    || ![undefined, 'NORMAL'].includes(node.blendMode)) return undefined;
  const styles = paints(node.fillPaints).map((paint) => svgPaint(paint, size, context));
  if (styles.length === 0 || styles.some((style) => !style)) return undefined;
  const align = String(node.textAlignHorizontal);
  const x = align === 'CENTER' ? size.width / 2 : align === 'RIGHT' ? size.width : 0;
  const anchor = align === 'CENTER' ? 'middle' : align === 'RIGHT' ? 'end' : 'start';
  const vertical = String(node.textAlignVertical);
  const y = vertical === 'BOTTOM' ? size.height : vertical === 'CENTER' ? (size.height + fontSize) / 2 : fontSize;
  const fontStyle = `${node.fontName?.style ?? ''} ${node.fontName?.postScriptName ?? ''} ${(node.fontName as { postscript?: string }).postscript ?? ''}`;
  const letterSpacing = metric(node.letterSpacing, fontSize) ?? finite(node.textTracking, 0) * fontSize;
  const fittedWidth = node.textAutoResize === 'WIDTH_AND_HEIGHT'
    ? ` textLength="${size.width}" lengthAdjust="spacingAndGlyphs"`
    : '';
  const attributes = `x="${x}" y="${y}" text-anchor="${anchor}" font-family="${svgEscape(fontFamily)}, sans-serif" font-size="${fontSize}" font-weight="${/bold|black|heavy/i.test(fontStyle) ? 700 : 400}" font-style="${/italic|oblique/i.test(fontStyle) ? 'italic' : 'normal'}" letter-spacing="${letterSpacing}" xml:space="preserve"${fittedWidth}`;
  context.leaves += 1;
  return styles.map((style) => `<text ${attributes} fill="${style!.value}" fill-opacity="${style!.opacity}">${svgEscape(text)}</text>`);
}

function svgVectorElements(document: FigDocument, node: FigNode, context: SvgContext): string[] | undefined {
  if (!['VECTOR', 'BOOLEAN_OPERATION'].includes(node.type)
    || (node.effects ?? []).some((effect) => effect.visible !== false)
    || ![undefined, 'NORMAL'].includes(node.blendMode)) return undefined;
  const size = nodeSize(node);
  if (!size || size.width <= 0 || size.height <= 0) return undefined;
  try {
    const paths = resolveVectorNodePaths(document, node);
    const fill = svgPathElements(paths.fill, node.fillPaints, size, context);
    const stroke = svgPathElements(paths.stroke, node.strokePaints, size, context);
    if (!fill || !stroke || fill.length + stroke.length === 0) return undefined;
    context.leaves += 1;
    return [...fill, ...stroke];
  } catch {
    return undefined;
  }
}

function svgTransform(node: FigNode): string {
  const transform = node.transform;
  return `matrix(${finite(transform?.m00, 1)} ${finite(transform?.m10, 0)} ${finite(transform?.m01, 0)} ${finite(transform?.m11, 1)} ${finite(transform?.m02, 0)} ${finite(transform?.m12, 0)})`;
}

function svgNodeElements(document: FigDocument, node: FigNode, context: SvgContext): string[] | undefined {
  if (node.visible === false) return [];
  const vector = svgVectorElements(document, node, context);
  if (vector) return vector;
  const shape = svgShapeElements(node, context);
  if (shape) return shape;
  if (!isFigmaGroup(node)
    || isFigmaMask(node)
    || Array.isArray(node.prototypeInteractions) && node.prototypeInteractions.length > 0
    || (node.effects ?? []).some((effect) => effect.visible !== false)
    || ![undefined, 'NONE'].includes(node.stackMode)
    || ![undefined, 'PASS_THROUGH', 'NORMAL'].includes(node.blendMode)
    || paints(node.fillPaints).length > 0
    || paints(node.strokePaints).length > 0) return undefined;
  const result: string[] = [];
  for (const child of children(document, node)) {
    const elements = svgNodeElements(document, child, context);
    if (!elements) return undefined;
    if (elements.length === 0) continue;
    result.push(`<g transform="${svgTransform(child)}" opacity="${Math.min(1, Math.max(0, finite(child.opacity, 1)))}">${elements.join('')}</g>`);
  }
  return result;
}

function svgImageNode(
  document: FigDocument,
  node: FigNode,
  diagnostics: Diagnostic[],
  format: Exclude<FigmaVectorFallback, 'skip'>,
  composite: boolean,
): ImportImage | undefined {
  const size = nodeSize(node);
  if (!size || size.width <= 0 || size.height <= 0) return undefined;
  const context: SvgContext = { definitions: [], nextId: 1, leaves: 0 };
  const directShape = !composite ? svgShapeElements(node, context, true) : undefined;
  const directText = !composite && !directShape ? svgTextElements(node, context) : undefined;
  const elements = directShape ?? directText ?? svgNodeElements(document, node, context);
  if (!elements || elements.length === 0 || (composite && context.leaves < 8)) return undefined;
  const definitions = context.definitions.length > 0 ? `<defs>${context.definitions.join('')}</defs>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">${definitions}${elements.join('')}</svg>`;
  const bytes = svgBytes(svg, format, node.type === 'TEXT');
  if (!bytes) return undefined;
  if (directShape && (node.effects ?? []).some((effect) => effect.visible !== false)
    && !diagnostics.some((item) => item.code === 'FIG_EFFECTS_IGNORED' && item.nodeId === id(node))) diagnostics.push({
    code: 'FIG_EFFECTS_IGNORED',
    message: `本地 .fig ${node.type} 已保留为 ${format.toUpperCase()}，其阴影、模糊或混合效果仍被忽略。`,
    nodeId: id(node),
    severity: 'warning',
  });
  diagnostics.push({
    code: format === 'png' ? 'RASTERIZED_NODE'
      : node.type === 'TEXT' ? 'FIG_TEXT_SVG_FALLBACK'
        : composite ? 'FIG_COMPOSITE_SVG_FALLBACK' : 'FIG_SHAPE_SVG_FALLBACK',
    message: composite
      ? `矢量密集 Group 已合并回退为单个 ${format.toUpperCase()}，避免部分缺失和碎片资源。`
      : node.type === 'TEXT'
        ? `TEXT 已回退为 ${format.toUpperCase()}，保留单行渐变文字。`
        : `${node.type} 已回退为 ${format.toUpperCase()}，保留渐变或非正圆几何。`,
    nodeId: id(node),
    severity: 'warning',
  });
  return { kind: 'image', ...base(node), format, bytes };
}

function frameCornerRadius(node: FigNode): [number, number, number, number] | null {
  const uniform = Math.max(0, finite(node.cornerRadius, 0));
  const radii = node.rectangleCornerRadiiIndependent === true
    ? [
      finite(node.rectangleTopLeftCornerRadius, uniform),
      finite(node.rectangleTopRightCornerRadius, uniform),
      finite(node.rectangleBottomRightCornerRadius, uniform),
      finite(node.rectangleBottomLeftCornerRadius, uniform),
    ] as [number, number, number, number]
    : [uniform, uniform, uniform, uniform] as [number, number, number, number];
  return radii.some((radius) => radius > 0) ? radii.map((radius) => Math.max(0, radius)) as typeof radii : null;
}

function frameDecoration(
  node: FigNode,
  diagnostics: Diagnostic[],
  inferredSize?: { width: number; height: number },
): ImportShape | undefined {
  const fills = paints(node.fillPaints);
  const strokes = paints(node.strokePaints);
  const radius = frameCornerRadius(node);
  const visibleEffects = (node.effects ?? []).some((effect) => effect.visible !== false);
  if (strokes.length === 0 && !radius && !visibleEffects) return undefined;
  if (fills.length > 1 || strokes.length > 1
    || (fills[0] && fills[0].type !== 'SOLID') || (strokes[0] && strokes[0].type !== 'SOLID')
    || finite(node.cornerSmoothing, 0) !== 0) {
    diagnostics.push({
      code: 'FRAME_STYLE_DROPPED',
      message: 'Frame 的多重/非纯色背景、边框或圆角平滑无法映射为 FairyGUI Graph。',
      nodeId: id(node),
      severity: 'warning',
    });
    return undefined;
  }
  const fillColor = fills[0] ? color(fills[0]) : '#00ffffff';
  const strokeColor = strokes[0] ? color(strokes[0]) : null;
  if (!fillColor || (strokes[0] && !strokeColor)) return undefined;
  const mappedShadows = shadows(node);
  if (mappedShadows === undefined) diagnostics.push({
    code: 'FIG_EFFECTS_IGNORED',
    message: 'Frame 包含 FairyGUI Graph 无法表达的模糊、内阴影或混合效果。',
    nodeId: id(node),
    severity: 'warning',
  });
  if (strokes.length > 0 && node.strokeAlign !== 'CENTER') diagnostics.push({
    code: 'FRAME_STROKE_ALIGNMENT_APPROXIMATED',
    message: `Frame 的 ${node.strokeAlign ?? 'INSIDE'} 边框已映射为 FairyGUI Graph 居中边框。`,
    nodeId: id(node),
    severity: 'warning',
  });
  return {
    kind: 'shape',
    ...base(node, false, inferredSize),
    id: `${id(node)}:background`,
    name: `${node.name || node.type} background`,
    x: 0,
    y: 0,
    rotation: 0,
    opacity: 1,
    mask: false,
    constraints: { horizontal: 'stretch', vertical: 'stretch' },
    layoutChild: false,
    shape: 'rectangle',
    fillColor,
    strokeColor: strokeColor ?? null,
    strokeWidth: strokeColor ? Math.max(0, finite(node.strokeWeight, 1)) : 0,
    cornerRadius: radius,
    points: null,
    shadows: mappedShadows ?? [],
  };
}

function metric(value: unknown, fontSize: number): number | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as { units?: unknown; value?: unknown };
  const amount = finite(item.value, Number.NaN);
  if (!Number.isFinite(amount)) return null;
  if (item.units === 'PERCENT') return fontSize * amount / 100;
  if (item.units === 'RAW' && Math.abs(amount) <= 10) return fontSize * amount;
  return amount;
}

interface TextStyle {
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

function resolvedTextStyle(document: FigDocument, node: FigNode, override?: Record<string, unknown>): TextStyle | undefined {
  const guid = (override?.styleIdForText as { guid?: { sessionID?: unknown; localID?: unknown } } | undefined)?.guid;
  const referenced = Number.isInteger(guid?.sessionID) && Number.isInteger(guid?.localID)
    ? document.nodeMap.get(`${guid!.sessionID}:${guid!.localID}`)
    : undefined;
  const style = { ...node, ...referenced, ...override } as FigNode;
  style.fillPaints = (override?.fillPaints as FigPaint[] | undefined) ?? referenced?.fillPaints ?? node.fillPaints;
  style.fontName = (override?.fontName as FigNode['fontName'] | undefined) ?? referenced?.fontName ?? node.fontName;
  const fill = onlyPaint(style.fillPaints, 'SOLID');
  const fillColor = fill && color(fill);
  const fontSize = finite(style.fontSize, Number.NaN);
  if (!fillColor || !Number.isFinite(fontSize) || !style.fontName?.family) return undefined;
  const fontStyle = `${style.fontName.style ?? ''} ${style.fontName.postScriptName ?? ''} ${(style.fontName as { postscript?: string }).postscript ?? ''}`;
  return {
    fontFamily: style.fontName.family,
    fontSize,
    color: fillColor,
    bold: /bold|black|heavy/i.test(fontStyle),
    italic: /italic|oblique/i.test(fontStyle),
    underline: style.textDecoration === 'UNDERLINE',
    strikethrough: style.textDecoration === 'STRIKETHROUGH',
  };
}

function textRuns(
  document: FigDocument,
  node: FigNode,
  baseStyle: TextStyle,
  diagnostics: Diagnostic[],
): ImportTextRun[] {
  const data = node.textData as {
    characters: string;
    characterStyleIDs?: unknown[];
    styleOverrideTable?: Array<Record<string, unknown> & { styleID?: unknown }>;
  };
  const text = data.characters;
  const styleIds = data.characterStyleIDs;
  if (!Array.isArray(styleIds) || !styleIds.some((value) => value !== 0)) return [];
  if (/[\[\]]/.test(text)) {
    diagnostics.push({
      code: 'FIG_TEXT_RUNS_PARTIAL',
      message: '分段文本包含 UBB 控制字符，已保留为普通文本以避免改变内容。',
      nodeId: id(node),
      severity: 'warning',
    });
    return [];
  }
  const table = new Map<number, Record<string, unknown>>((data.styleOverrideTable ?? [])
    .filter((entry): entry is Record<string, unknown> & { styleID: number } =>
      !!entry && typeof entry === 'object' && typeof entry.styleID === 'number')
    .map((entry): [number, Record<string, unknown>] => [entry.styleID, entry]));
  const styles = new Map<number, TextStyle>([[0, baseStyle]]);
  let partial = false;
  for (const styleId of new Set(styleIds.filter((value): value is number => typeof value === 'number' && value !== 0))) {
    const override = table.get(styleId);
    const resolved = override && resolvedTextStyle(document, node, override);
    if (!override || !resolved) {
      partial = true;
      styles.set(styleId, baseStyle);
      continue;
    }
    styles.set(styleId, resolved);
    const supported = new Set(['styleID', 'styleIdForText', 'fontSize', 'fontName', 'fillPaints', 'textDecoration']);
    if (Object.keys(override).some((key) => !supported.has(key))) partial = true;
  }
  const runs: ImportTextRun[] = [];
  const styleIdAt = (index: number): number => {
    const value = styleIds[index];
    return typeof value === 'number' ? value : 0;
  };
  for (let start = 0; start < text.length;) {
    const styleId = styleIdAt(start);
    let end = start + 1;
    while (end < text.length && styleIdAt(end) === styleId) end += 1;
    runs.push({ start, end, ...(styles.get(styleId) ?? baseStyle) });
    start = end;
  }
  if (partial) diagnostics.push({
    code: 'FIG_TEXT_RUNS_PARTIAL',
    message: '分段文本已映射字体、字号、颜色和基础装饰；字距、行距、OpenType 或链接差异仍使用基础样式。',
    nodeId: id(node),
    severity: 'warning',
  });
  return runs.some((run) =>
    run.fontFamily !== baseStyle.fontFamily
    || run.fontSize !== baseStyle.fontSize
    || run.color !== baseStyle.color
    || run.bold !== baseStyle.bold
    || run.italic !== baseStyle.italic
    || run.underline !== baseStyle.underline
    || run.strikethrough !== baseStyle.strikethrough) ? runs : [];
}

function textNode(document: FigDocument, node: FigNode, diagnostics: Diagnostic[]): ImportText | undefined {
  if (node.type !== 'TEXT' || typeof node.textData?.characters !== 'string') return undefined;
  const style = resolvedTextStyle(document, node);
  if (!style) return undefined;
  const autoSize = {
    WIDTH_AND_HEIGHT: 'both',
    HEIGHT: 'height',
    TRUNCATE: 'ellipsis',
  }[String(node.textAutoResize)] ?? 'none';
  return {
    kind: 'text',
    ...base(node),
    text: node.textData.characters,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    color: style.color,
    align: ({ CENTER: 'center', RIGHT: 'right' } as const)[String(node.textAlignHorizontal) as 'CENTER' | 'RIGHT'] ?? 'left',
    verticalAlign: ({ CENTER: 'middle', BOTTOM: 'bottom' } as const)[String(node.textAlignVertical) as 'CENTER' | 'BOTTOM'] ?? 'top',
    lineHeight: metric(node.lineHeight, style.fontSize),
    letterSpacing: metric(node.letterSpacing, style.fontSize) ?? finite(node.textTracking, 0) * style.fontSize,
    autoSize: autoSize as ImportText['autoSize'],
    singleLine: !/[\r\n]/.test(node.textData.characters) && (
      node.textData.lines?.length === 1
      || node.derivedTextData?.lines?.length === 1
      || node.textAutoResize === 'WIDTH_AND_HEIGHT'
    ),
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikethrough: style.strikethrough,
    runs: textRuns(document, node, style, diagnostics),
    shadow: (() => {
      const mapped = shadows(node);
      if (mapped === undefined || mapped.length > 1) {
        if ((node.effects ?? []).some((effect) => effect.visible !== false)) diagnostics.push({
          code: 'FIG_EFFECTS_IGNORED',
          message: '文本包含 FairyGUI RichText 无法表达的多重、模糊、内阴影或混合效果。',
          nodeId: id(node),
          severity: 'warning',
        });
        return null;
      }
      return mapped[0] ?? null;
    })(),
  };
}

function componentId(node: FigNode): string | undefined {
  return guidId((node.symbolData as { symbolID?: unknown } | undefined)?.symbolID);
}

interface ComponentPropertyTarget {
  targetPath: string[];
  field: string;
}

function componentPropertyTargets(document: FigDocument, component: string): Map<string, ComponentPropertyTarget[]> {
  const result = new Map<string, ComponentPropertyTarget[]>();
  const root = document.nodeMap.get(component);
  if (!root) return result;
  const visit = (parent: FigNode, path: string[]): void => {
    for (const child of children(document, parent)) {
      const targetPath = [...path, id(child)];
      for (const reference of child.componentPropRefs ?? []) {
        const definition = guidId(reference.defID);
        if (!definition || typeof reference.componentPropNodeField !== 'string') continue;
        const targets = result.get(definition) ?? [];
        targets.push({ targetPath, field: reference.componentPropNodeField });
        result.set(definition, targets);
      }
      visit(child, targetPath);
    }
  };
  visit(root, []);
  return result;
}

function emptyOverride(targetPath: string[]): ImportInstanceOverride {
  return {
    targetId: targetPath.at(-1)!,
    targetPath,
    componentId: null,
    name: null,
    text: null,
    visible: null,
    opacity: null,
    width: null,
    height: null,
    fillColor: null,
    strokeColor: null,
    strokeWidth: null,
    cornerRadius: null,
    fontFamily: null,
    fontSize: null,
    bold: null,
    italic: null,
    underline: null,
    strikethrough: null,
  };
}

const OVERRIDE_VALUE_KEYS = [
  'componentId', 'name', 'text', 'visible', 'opacity', 'width', 'height', 'fillColor', 'strokeColor',
  'strokeWidth', 'cornerRadius', 'fontFamily', 'fontSize', 'bold', 'italic', 'underline', 'strikethrough',
] as const;

function hasOverrideValue(override: ImportInstanceOverride): boolean {
  return OVERRIDE_VALUE_KEYS.some((key) => override[key] !== null);
}

function instanceOverrides(document: FigDocument, node: FigNode, diagnostics: Diagnostic[]): ImportInstanceOverride[] {
  const values = (node.symbolData as { symbolOverrides?: Array<Record<string, unknown>> } | undefined)?.symbolOverrides ?? [];
  const result = new Map<string, ImportInstanceOverride>();
  const merge = (override: ImportInstanceOverride): void => {
    const key = override.targetPath.join('/');
    const existing = result.get(key) ?? emptyOverride(override.targetPath);
    for (const property of OVERRIDE_VALUE_KEYS) {
      if (override[property] !== null) {
        (existing as unknown as Record<string, unknown>)[property] = override[property];
      }
    }
    result.set(key, existing);
  };
  let partial = false;
  for (const value of values) {
    const guids = (value.guidPath as { guids?: Array<{ sessionID?: unknown; localID?: unknown }> } | undefined)?.guids;
    const targetPath = guids?.map(guidId);
    if (!targetPath?.length || targetPath.some((item) => !item)) {
      partial = true;
      continue;
    }
    const normalizedPath = targetPath as string[];
    const targetId = normalizedPath.at(-1)!;
    const target = document.nodeMap.get(targetId);
    const text = (value.textData as { characters?: unknown } | undefined)?.characters;
    const size = value.size as { x?: unknown; y?: unknown } | undefined;
    const fillPaints = Array.isArray(value.fillPaints) ? paints(value.fillPaints as FigPaint[]) : undefined;
    const strokePaints = Array.isArray(value.strokePaints) ? paints(value.strokePaints as FigPaint[]) : undefined;
    const overrideFill = fillPaints?.length === 0
      ? '#00ffffff'
      : fillPaints?.length === 1 && fillPaints[0].type === 'SOLID' ? color(fillPaints[0]) ?? null : null;
    const overrideStroke = strokePaints?.length === 1 && strokePaints[0].type === 'SOLID'
      ? color(strokePaints[0]) ?? null
      : null;
    if ((fillPaints && fillPaints.length > 0 && overrideFill === null)
      || (strokePaints && strokePaints.length > 0 && overrideStroke === null)) partial = true;
    const fontName = value.fontName as { family?: unknown; style?: unknown; postscript?: unknown; postScriptName?: unknown } | undefined;
    const fontStyle = `${fontName?.style ?? ''} ${fontName?.postscript ?? ''} ${fontName?.postScriptName ?? ''}`;
    const uniformRadius = typeof value.cornerRadius === 'number' && Number.isFinite(value.cornerRadius)
      ? value.cornerRadius
      : null;
    const hasIndependentRadii = ['rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius',
      'rectangleBottomRightCornerRadius', 'rectangleBottomLeftCornerRadius']
      .some((key) => typeof value[key] === 'number');
    const override: ImportInstanceOverride = {
      ...emptyOverride(normalizedPath),
      targetId,
      componentId: null,
      name: typeof value.name === 'string' ? value.name : null,
      text: target?.type === 'TEXT' && typeof text === 'string' ? text : null,
      visible: typeof value.visible === 'boolean' ? value.visible : null,
      opacity: typeof value.opacity === 'number' && Number.isFinite(value.opacity) ? value.opacity : null,
      width: typeof size?.x === 'number' && Number.isFinite(size.x) ? size.x : null,
      height: typeof size?.y === 'number' && Number.isFinite(size.y) ? size.y : null,
      fillColor: overrideFill,
      strokeColor: overrideStroke,
      strokeWidth: typeof value.strokeWeight === 'number' && Number.isFinite(value.strokeWeight)
        ? Math.max(0, value.strokeWeight)
        : strokePaints?.length === 0 ? 0 : null,
      cornerRadius: uniformRadius !== null || hasIndependentRadii ? [
        finite(value.rectangleTopLeftCornerRadius, uniformRadius ?? 0),
        finite(value.rectangleTopRightCornerRadius, uniformRadius ?? 0),
        finite(value.rectangleBottomRightCornerRadius, uniformRadius ?? 0),
        finite(value.rectangleBottomLeftCornerRadius, uniformRadius ?? 0),
      ] : null,
      fontFamily: typeof fontName?.family === 'string' ? fontName.family : null,
      fontSize: typeof value.fontSize === 'number' && Number.isFinite(value.fontSize) ? value.fontSize : null,
      bold: fontName ? /bold|black|heavy/i.test(fontStyle) : null,
      italic: fontName ? /italic|oblique/i.test(fontStyle) : null,
      underline: typeof value.textDecoration === 'string' ? value.textDecoration === 'UNDERLINE' : null,
      strikethrough: typeof value.textDecoration === 'string' ? value.textDecoration === 'STRIKETHROUGH' : null,
    };
    if (!hasOverrideValue(override)) {
      partial = true;
      continue;
    }
    const supported = new Set([
      'guidPath', 'name', 'textData', 'visible', 'opacity', 'size', 'fillPaints', 'strokePaints',
      'strokeWeight', 'cornerRadius', 'rectangleTopLeftCornerRadius', 'rectangleTopRightCornerRadius',
      'rectangleBottomRightCornerRadius', 'rectangleBottomLeftCornerRadius', 'fontName', 'fontSize',
      'textDecoration', 'styleIdForFill', 'styleIdForStrokeFill', 'styleIdForText',
    ]);
    if (Object.keys(value).some((key) => !supported.has(key))) partial = true;
    merge(override);
  }

  const sourceComponent = componentId(node);
  const propertyTargets = sourceComponent ? componentPropertyTargets(document, sourceComponent) : new Map();
  for (const assignment of node.componentPropAssignments ?? []) {
    const definition = guidId(assignment.defID);
    const targets = definition ? propertyTargets.get(definition) : undefined;
    const value = assignment.value ?? assignment.varValue?.value ?? {};
    if (!targets?.length) {
      partial = true;
      continue;
    }
    let applied = false;
    for (const target of targets) {
      const override = emptyOverride(target.targetPath);
      if (target.field === 'VISIBLE' && typeof value.boolValue === 'boolean') {
        override.visible = value.boolValue;
      } else if (target.field === 'TEXT_DATA') {
        const text = value.textValue?.characters ?? value.textDataValue?.characters;
        if (typeof text === 'string') override.text = text;
      } else if (target.field === 'OVERRIDDEN_SYMBOL_ID') {
        override.componentId = guidId(value.guidValue ?? value.symbolIdValue?.guid) ?? null;
      }
      if (!hasOverrideValue(override)) continue;
      merge(override);
      applied = true;
    }
    if (!applied) partial = true;
  }
  const overrides = [...result.values()];
  if ((values.length > 0 || (node.componentPropAssignments?.length ?? 0) > 0) && overrides.length === 0) diagnostics.push({
    code: 'INSTANCE_OVERRIDES_IGNORED',
    message: 'Instance override 或 Component Property 没有可安全映射的字段，仍引用默认组件。',
    nodeId: id(node),
    severity: 'warning',
  });
  else if (partial) diagnostics.push({
    code: 'INSTANCE_OVERRIDES_PARTIAL',
    message: 'Instance 已应用可定位的嵌套覆盖与 Component Property；无法定位或无法表达的字段仍使用默认值。',
    nodeId: id(node),
    severity: 'warning',
  });
  return overrides;
}

function readNode(
  document: FigDocument,
  node: FigNode,
  diagnostics: Diagnostic[],
  componentIds: Set<string>,
  vectorFallback: FigmaVectorFallback,
): ImportNode | undefined {
  if (CONTAINERS.has(node.type)) {
    if (vectorFallback !== 'skip' && isFigmaGroup(node)) {
      const composite = svgImageNode(document, node, diagnostics, vectorFallback, true);
      if (composite) return composite;
    }
    return readFrame(document, node, diagnostics, componentIds, false, vectorFallback);
  }
  if (Array.isArray(node.prototypeInteractions) && node.prototypeInteractions.length > 0) diagnostics.push({
    code: 'INTERACTION_DROPPED',
    message: 'Prototype interaction 没有通用 FairyGUI 事件等价物，当前未写入工程。',
    nodeId: id(node),
    severity: 'warning',
  });
  if (node.type === 'INSTANCE') {
    const target = componentId(node);
    if (target && componentIds.has(target)) {
      const instance: ImportInstance = {
        kind: 'instance',
        ...base(node),
        componentId: target,
        overrides: instanceOverrides(document, node, diagnostics),
      };
      return instance;
    }
  }
  const text = textNode(document, node, diagnostics);
  if (text) return text;
  const image = imageNode(document, node, diagnostics);
  if (image) return image;
  const vector = vectorNode(document, node);
  if (vector) return vector;
  if (vectorFallback !== 'skip') {
    const fallback = vectorFallbackNode(document, node, diagnostics, vectorFallback);
    if (fallback) return fallback;
  }
  const shape = shapeNode(node, diagnostics);
  if (shape) {
    if (vectorFallback !== 'skip' && shape.shape === 'ellipse' && Math.abs(shape.width - shape.height) > 1e-6) {
      const fallback = svgImageNode(document, node, diagnostics, vectorFallback, false);
      if (fallback) return fallback;
    }
    return shape;
  }
  if (vectorFallback !== 'skip' && ['TEXT', 'RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE'].includes(node.type)) {
    const fallback = svgImageNode(document, node, diagnostics, vectorFallback, false);
    if (fallback) return fallback;
  }
  diagnostics.push({
    code: 'FIG_FILE_NODE_SKIPPED',
    message: `${node.type} 无法从本地 .fig 文件无损映射，当前已跳过。`,
    nodeId: id(node),
    severity: 'warning',
  });
  return undefined;
}

function simpleAutoLayout(
  node: FigNode,
  sourceChildren: FigNode[],
  convertedChildren: ImportNode[],
): ImportLayout | null {
  if (node.stackMode !== 'HORIZONTAL' && node.stackMode !== 'VERTICAL') return null;
  const gap = finite(node.stackSpacing, 0);
  if (!Number.isInteger(gap) || gap < -32_768 || gap > 32_767
    || node.stackWrap !== undefined
    || ![undefined, 'FIXED'].includes(node.stackPrimarySizing)
    || ![undefined, 'FIXED'].includes(node.stackCounterSizing)
    || ![undefined, 'MIN'].includes(node.stackPrimaryAlignItems)
    || ![undefined, 'MIN'].includes(node.stackCounterAlignItems)
    || finite(node.stackHorizontalPadding, 0) !== 0
    || finite(node.stackVerticalPadding, 0) !== 0
    || finite(node.stackPaddingRight, 0) !== 0
    || finite(node.stackPaddingBottom, 0) !== 0
    || node.stackReverseZIndex === true
    || sourceChildren.length !== convertedChildren.length
    || sourceChildren.some((child) =>
      child.stackPositioning === 'ABSOLUTE'
      || finite(child.stackChildPrimaryGrow, 0) !== 0
      || ![undefined, 'INHERIT', 'MIN'].includes(child.stackChildAlignSelf)
      || ![undefined, 'MIN'].includes(child.horizontalConstraint)
      || ![undefined, 'MIN'].includes(child.verticalConstraint))) return null;
  return { mode: node.stackMode === 'HORIZONTAL' ? 'horizontal' : 'vertical', gap };
}

function readFrame(
  document: FigDocument,
  node: FigNode,
  diagnostics: Diagnostic[],
  componentIds: Set<string>,
  root: boolean,
  vectorFallback: FigmaVectorFallback,
): ImportFrame {
  if (Array.isArray(node.prototypeInteractions) && node.prototypeInteractions.length > 0) diagnostics.push({
    code: 'INTERACTION_DROPPED',
    message: 'Prototype interaction 没有通用 FairyGUI 事件等价物，当前未写入工程。',
    nodeId: id(node),
    severity: 'warning',
  });
  const inferredSize = nodeSize(node) ? undefined : inferResizeToFitSize(document, node);
  if (inferredSize) diagnostics.push({
    code: 'FIG_BOUNDS_INFERRED',
    message: `本地 .fig 自动尺寸容器缺少有效边界，已根据子节点推导为 ${inferredSize.width} × ${inferredSize.height}。`,
    nodeId: id(node),
    severity: 'warning',
  });
  const sourceChildren = children(document, node);
  const convertedChildren = sourceChildren
    .map((child) => readNode(document, child, diagnostics, componentIds, vectorFallback))
    .filter((child): child is ImportNode => child !== undefined);
  const componentSet = node.type === 'COMPONENT_SET' || isLegacyComponentSet(document, node);
  const group = !componentSet && isFigmaGroup(node);
  const canFlatten = flattenableGroup(node, sourceChildren, convertedChildren);
  if (group && !canFlatten) diagnostics.push({
    code: 'GROUP_COMPONENT_FALLBACK',
    message: 'Group 包含变换、蒙版、效果、复杂约束或未转换子节点，已保留为独立 FairyGUI component。',
    nodeId: id(node),
    severity: 'warning',
  });
  const layout = simpleAutoLayout(node, sourceChildren, convertedChildren);
  if (typeof node.stackMode === 'string' && node.stackMode !== 'NONE' && !layout) diagnostics.push({
    code: 'AUTO_LAYOUT_BAKED',
    message: '复杂 Auto Layout 已按当前坐标烘焙；简单无 padding/wrap/grow 的布局才映射为 FairyGUI Group。',
    nodeId: id(node),
    severity: 'warning',
  });
  const decoration = group ? undefined : frameDecoration(node, diagnostics, inferredSize);
  const visibleFills = paints(node.fillPaints);
  if (!decoration && (visibleFills.length > 1 || visibleFills.some((paint) => paint.type !== 'SOLID'))) {
    diagnostics.push({
      code: 'FRAME_STYLE_DROPPED',
      message: 'Frame 的多重或非纯色背景无法映射为 FairyGUI component 背景。',
      nodeId: id(node),
      severity: 'warning',
    });
  }
  const background = onlyPaint(node.fillPaints, 'SOLID');
  return {
    kind: 'frame',
    ...base(node, root, inferredSize),
    sourceType: group
      ? 'group'
      : node.type === 'SYMBOL'
      ? 'component'
      : componentSet ? 'componentSet' : 'frame',
    ...(group ? { flattenable: canFlatten } : {}),
    variantProperties: variantProperties(document, node),
    layout,
    clipContent: group ? false : node.frameMaskDisabled === false,
    backgroundColor: group ? null : !decoration && background ? color(background) ?? null : null,
    children: [...(decoration ? [decoration] : []), ...convertedChildren],
  };
}

export function parseFigmaFile(
  source: Uint8Array,
  fallbackName = 'FigmaProject',
  vectorFallback: FigmaVectorFallback = 'skip',
): ImportDocument {
  let document: FigDocument;
  try {
    document = parseFig(source);
  } catch (error) {
    throw new Error(`Invalid Figma .fig file: ${error instanceof Error ? error.message : String(error)}`);
  }
  return importFigmaDocument(document, fallbackName, vectorFallback);
}

export function importFigmaDocument(
  document: FigDocument,
  fallbackName = 'FigmaProject',
  vectorFallback: FigmaVectorFallback = 'skip',
): ImportDocument {
  const diagnostics: Diagnostic[] = [];
  const canvases = document.nodes
    .filter((node) => node.phase !== 'REMOVED' && node.type === 'CANVAS')
    .sort((left, right) => compareFigmaPositions(
      left.parentIndex?.position ?? '',
      right.parentIndex?.position ?? '',
    ));
  const sources = canvases
    .filter((page) => page.name !== 'Internal Only Canvas')
    .map((page) => {
      return {
        id: id(page),
        name: page.name || 'Page',
        roots: children(document, page)
          .flatMap((node) => collectFigmaPageRoots(document, node, diagnostics)),
      };
    });
  const internal = canvases.find((page) => page.name === 'Internal Only Canvas');
  const internalRoots = internal
    ? children(document, internal).flatMap((node) => componentRoots(document, node))
    : [];
  if (internal && internalRoots.length > 0) {
    sources.push({ id: id(internal), name: 'Components', roots: internalRoots });
  }
  const componentIds = new Set<string>();
  sources.flatMap((page) => page.roots)
    .forEach((root) => collectComponentIds(document, root, componentIds));
  const pages: ImportPage[] = sources
    .filter((page) => page.roots.length > 0)
    .map((page) => ({
      id: page.id,
      name: page.name,
      roots: page.roots.map((node) => readFrame(document, node, diagnostics, componentIds, true, vectorFallback)),
    }));
  if (pages.length === 0) throw new Error('Figma .fig file contains no Frame, Component, or ComponentSet roots');
  const parentById = new Map<string, string>();
  for (const [parentId, childNodes] of document.childrenMap) {
    for (const child of childNodes) parentById.set(id(child), parentId);
  }
  const contextualDiagnostics = diagnostics.map((diagnostic): Diagnostic => {
    const sourceNode = document.nodeMap.get(diagnostic.nodeId);
    if (!sourceNode) return diagnostic;
    let current = sourceNode;
    let root = sourceNode;
    let page: FigNode | undefined;
    for (;;) {
      const parentId = parentById.get(id(current));
      const parent = parentId ? document.nodeMap.get(parentId) : undefined;
      if (!parent) break;
      if (parent.type === 'CANVAS') {
        page = parent;
        break;
      }
      root = parent;
      current = parent;
    }
    return {
      ...diagnostic,
      nodeName: sourceNode.name || sourceNode.type,
      nodeType: sourceNode.type,
      ...(page ? { pageId: id(page), pageName: page.name || 'Page' } : {}),
      rootId: id(root),
      rootName: root.name || root.type,
    };
  });
  return {
    name: typeof document.meta?.file_name === 'string' && document.meta.file_name.trim()
      ? document.meta.file_name
      : fallbackName,
    pages,
    diagnostics: contextualDiagnostics,
  };
}
