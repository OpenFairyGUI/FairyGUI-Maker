import { crc32, deflateSync } from 'node:zlib';
import {
  initializeCanvas,
  getLayerImageData,
  readPsd,
  type Color,
  type Layer,
  type PixelData,
} from 'ag-psd';
import type {
  Diagnostic,
  ImportDocument,
  ImportFrame,
  ImportImage,
  ImportNode,
  ImportText,
} from './model';

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const MAX_INPUT_BYTES = 512 * 1024 * 1024;
const MAX_DECODED_BYTES = 512 * 1024 * 1024;
const MAX_DIMENSION = 10_000;
const MAX_LAYERS = 5_000;
const MAX_DEPTH = 100;

initializeCanvas(
  () => { throw new Error('Canvas access is unavailable'); },
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData,
);

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function ownBox(layer: Layer): Box {
  const artboard = layer.artboard?.rect;
  if (artboard && artboard.right > artboard.left && artboard.bottom > artboard.top) return artboard;
  return {
    left: number(layer.left),
    top: number(layer.top),
    right: number(layer.right),
    bottom: number(layer.bottom),
  };
}

function layerBox(layer: Layer): Box {
  const direct = ownBox(layer);
  if (direct.right > direct.left || direct.bottom > direct.top) return direct;
  const children = layer.children?.map(layerBox).filter((box) => box.right > box.left || box.bottom > box.top) ?? [];
  return children.length === 0 ? direct : {
    left: Math.min(...children.map((box) => box.left)),
    top: Math.min(...children.map((box) => box.top)),
    right: Math.max(...children.map((box) => box.right)),
    bottom: Math.max(...children.map((box) => box.bottom)),
  };
}

function layerId(layer: Layer, path: number[]): string {
  return `psd:${layer.id ?? path.join('.')}`;
}

function base(layer: Layer, parent: Box, path: number[], root = false) {
  const box = layerBox(layer);
  return {
    id: layerId(layer, path),
    name: layer.name || `Layer ${path.join('.')}`,
    x: root ? 0 : box.left - parent.left,
    y: root ? 0 : box.top - parent.top,
    width: Math.max(0, box.right - box.left),
    height: Math.max(0, box.bottom - box.top),
    visible: layer.hidden !== true,
    opacity: Math.min(1, Math.max(0, number(layer.opacity, 1))),
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    mask: false,
    constraints: null,
    layoutChild: true,
  };
}

function color(value: Color | undefined): string {
  let channels: number[] | undefined;
  if (value && 'r' in value) channels = [value.r, value.g, value.b];
  if (value && 'fr' in value) channels = [value.fr * 255, value.fg * 255, value.fb * 255];
  if (!channels) return '#ffffff';
  return `#${channels.map((channel) => Math.round(Math.min(255, Math.max(0, channel)))
    .toString(16).padStart(2, '0')).join('')}`;
}

function textNode(
  layer: Layer,
  parent: Box,
  path: number[],
  diagnostics: Diagnostic[],
): ImportText | undefined {
  const text = layer.text;
  if (!text || typeof text.text !== 'string') return undefined;
  const style = text.style ?? text.styleRuns?.[0]?.style ?? {};
  const paragraph = text.paragraphStyle ?? text.paragraphStyleRuns?.[0]?.style;
  const fontSize = Math.max(1, number(style.fontSize, 12));
  const justification = paragraph?.justification ?? 'left';
  if ((text.styleRuns?.length ?? 0) > 1 || (text.paragraphStyleRuns?.length ?? 0) > 1
    || text.orientation === 'vertical' || (text.warp?.style && text.warp.style !== 'none')) {
    diagnostics.push({
      code: 'PSD_TEXT_STYLE_APPROXIMATED',
      message: 'PSD 文本包含分段样式、竖排或变形；当前使用首个基础样式保持为可编辑文本。',
      nodeId: layerId(layer, path),
      severity: 'warning',
    });
  }
  return {
    kind: 'text',
    ...base(layer, parent, path),
    text: text.text.replace(/\r/g, '\n'),
    fontFamily: style.font?.name || 'Arial',
    fontSize,
    color: color(style.fillColor),
    align: justification === 'center' || justification === 'justify-center'
      ? 'center'
      : justification === 'right' || justification === 'justify-right' ? 'right' : 'left',
    verticalAlign: 'top',
    lineHeight: number(style.leading) || null,
    letterSpacing: number(style.tracking) * fontSize / 1000,
    autoSize: 'none',
    singleLine: false,
    bold: style.fauxBold === true,
    italic: style.fauxItalic === true,
    underline: style.underline === true,
    strikethrough: style.strikethrough === true,
    runs: [],
    shadow: null,
  };
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  name.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0, data.length + 8);
  return chunk;
}

function pngBytes(image: PixelData): Uint8Array {
  const { width, height } = image;
  const expected = width * height * 4;
  if (!Number.isSafeInteger(expected) || width <= 0 || height <= 0 || expected > 512 * 1024 * 1024) {
    throw new Error('decoded image dimensions exceed the 512 MiB limit');
  }
  if (image.data.length !== expected) throw new Error('decoded image is not RGBA');
  const rgba = image.data instanceof Uint16Array
    ? Uint8Array.from(image.data, (value) => Math.round(value / 257))
    : image.data instanceof Float32Array
      ? Uint8Array.from(image.data, (value) => Math.round(Math.min(1, Math.max(0, value)) * 255))
      : Uint8Array.from(image.data);
  const stride = width * 4;
  const scanlines = Buffer.allocUnsafe(height * (stride + 1));
  for (let row = 0; row < height; row += 1) {
    const offset = row * (stride + 1);
    scanlines[offset] = 0;
    scanlines.set(rgba.subarray(row * stride, (row + 1) * stride), offset + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  // ponytail: filter 0 keeps this encoder tiny; add adaptive filters only if PSD ZIP size becomes material.
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND'),
  ]);
}

function imageNode(
  layer: Layer,
  parent: Box,
  path: number[],
  diagnostics: Diagnostic[],
): ImportImage | undefined {
  const imageData = layer.imageData ?? getLayerImageData(layer);
  if (!imageData) return undefined;
  const item = {
    kind: 'image' as const,
    ...base(layer, parent, path),
    format: 'png' as const,
    bytes: pngBytes(imageData),
  };
  if (item.width === 0 || item.height === 0) {
    item.width = imageData.width;
    item.height = imageData.height;
  }
  diagnostics.push({
    code: 'RASTERIZED_NODE',
    message: 'PSD 图层已通过 ag-psd 解码并栅格化为 PNG。',
    nodeId: item.id,
    severity: 'warning',
  });
  return item;
}

function validateStructure(layers: Layer[], bitsPerChannel: number): void {
  let layerCount = 0;
  let decodedBytes = 0;
  const bytesPerChannel = bitsPerChannel <= 8 ? 1 : bitsPerChannel <= 16 ? 2 : 4;
  const visit = (layer: Layer, depth: number): void => {
    layerCount += 1;
    if (layerCount > MAX_LAYERS) throw new Error(`PSD contains more than ${MAX_LAYERS} layers`);
    if (depth > MAX_DEPTH) throw new Error(`PSD layer nesting exceeds ${MAX_DEPTH} levels`);
    const box = ownBox(layer);
    const width = Math.max(0, box.right - box.left);
    const height = Math.max(0, box.bottom - box.top);
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw new Error(`PSD layer exceeds ${MAX_DIMENSION} px: ${layer.name || layer.id || layerCount}`);
    }
    if (!layer.children && !layer.text) {
      decodedBytes += width * height * 4 * bytesPerChannel;
      if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_DECODED_BYTES) {
        throw new Error('PSD decoded layer pixels exceed the 512 MiB limit');
      }
    }
    layer.children?.forEach((child) => visit(child, depth + 1));
  };
  layers.forEach((layer) => visit(layer, 1));
}

function diagnoseStyle(layer: Layer, path: number[], diagnostics: Diagnostic[]): void {
  if (!layer.effects && !layer.mask && !layer.realMask && !layer.vectorMask && !layer.adjustment
    && !layer.clipping && (!layer.blendMode || layer.blendMode === 'normal' || layer.blendMode === 'pass through')) return;
  diagnostics.push({
    code: 'PSD_LAYER_STYLE_APPROXIMATED',
    message: 'PSD 图层的混合、蒙版、调整或效果尚未映射为 FairyGUI 语义。',
    nodeId: layerId(layer, path),
    severity: 'warning',
  });
}

function node(layer: Layer, parent: Box, path: number[], diagnostics: Diagnostic[]): ImportNode | undefined {
  diagnoseStyle(layer, path, diagnostics);
  if (layer.children) return frame(layer, parent, path, diagnostics);
  const text = textNode(layer, parent, path, diagnostics);
  if (text) return text;
  try {
    const image = imageNode(layer, parent, path, diagnostics);
    if (image) return image;
  } catch (error) {
    diagnostics.push({
      code: 'PSD_LAYER_SKIPPED',
      message: `PSD 图层像素无法编码：${error instanceof Error ? error.message : String(error)}`,
      nodeId: layerId(layer, path),
      severity: 'warning',
    });
    return undefined;
  }
  diagnostics.push({
    code: 'PSD_LAYER_SKIPPED',
    message: 'PSD 图层没有可编辑文本或可解码像素，当前已跳过。',
    nodeId: layerId(layer, path),
    severity: 'warning',
  });
  return undefined;
}

function frame(
  layer: Layer,
  parent: Box,
  path: number[],
  diagnostics: Diagnostic[],
  root = false,
): ImportFrame {
  const box = layerBox(layer);
  return {
    kind: 'frame',
    ...base(layer, parent, path, root),
    sourceType: 'frame',
    variantProperties: {},
    layout: null,
    clipContent: root,
    backgroundColor: null,
    children: (layer.children ?? []).flatMap((child, index) => {
      const converted = node(child, box, [...path, index], diagnostics);
      return converted ? [converted] : [];
    }),
  };
}

export function parsePsdFile(input: Uint8Array, name = 'PhotoshopDocument'): ImportDocument {
  if (input.byteLength > MAX_INPUT_BYTES) throw new Error('PSD input exceeds the 512 MiB limit');
  if (input.length < 6 || Buffer.from(input.subarray(0, 4)).toString('ascii') !== '8BPS') {
    throw new Error('Invalid PSD file: missing 8BPS signature');
  }
  const version = (input[4] << 8) | input[5];
  if (version === 2) throw new Error('PSB files are not supported by ag-psd');
  if (version !== 1) throw new Error(`Invalid PSD file: unsupported version ${version}`);

  let psd;
  try {
    psd = readPsd(input, {
      useRawData: true,
      useRawThumbnail: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      skipLinkedFilesData: true,
      totalMemoryLimit: 512 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(`Invalid PSD file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (psd.width <= 0 || psd.height <= 0) throw new Error('Invalid PSD file: document dimensions must be positive');
  if (psd.width > MAX_DIMENSION || psd.height > MAX_DIMENSION) {
    throw new Error(`PSD document exceeds ${MAX_DIMENSION} px`);
  }

  const diagnostics: Diagnostic[] = [];
  const documentBox = { left: 0, top: 0, right: psd.width, bottom: psd.height };
  const layers = psd.children ?? [];
  // ponytail: synchronous hard caps are enough for a CLI; use a worker/streaming decoder if larger PSDs become required.
  validateStructure(layers, psd.bitsPerChannel ?? 8);
  const artboards = layers.filter((layer) => layer.artboard);
  const roots = artboards.length > 0
    ? artboards.map((artboard, index) => frame(artboard, layerBox(artboard), [index], diagnostics, true))
    : [{
      kind: 'frame' as const,
      id: 'psd:document',
      name,
      x: 0,
      y: 0,
      width: psd.width,
      height: psd.height,
      visible: true,
      opacity: 1,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      mask: false,
      constraints: null,
      layoutChild: true,
      sourceType: 'frame' as const,
      variantProperties: {},
      layout: null,
      clipContent: true,
      backgroundColor: null,
      children: layers.flatMap((layer, index) => {
        const converted = node(layer, documentBox, [index], diagnostics);
        return converted ? [converted] : [];
      }),
    }];
  return {
    name,
    pages: [{ id: 'psd:page', name: 'Photoshop', roots }],
    diagnostics,
  };
}
