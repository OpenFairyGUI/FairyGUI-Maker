export interface Diagnostic {
  code: string;
  message: string;
  nodeId: string;
  severity: 'warning' | 'error';
  nodeName?: string;
  nodeType?: string;
  pageId?: string;
  pageName?: string;
  rootId?: string;
  rootName?: string;
}

interface ImportNodeBase {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  opacity: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  mask: boolean;
  constraints: ImportConstraints | null;
  layoutChild: boolean;
}

export type ImportConstraint = 'min' | 'center' | 'max' | 'stretch' | 'scale';

export interface ImportConstraints {
  horizontal: ImportConstraint;
  vertical: ImportConstraint;
}

export interface ImportLayout {
  mode: 'horizontal' | 'vertical';
  gap: number;
}

export interface ImportShadow {
  color: string;
  offsetX: number;
  offsetY: number;
}

export interface ImportTextRun {
  start: number;
  end: number;
  fontFamily: string;
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
}

export interface ImportFrame extends ImportNodeBase {
  kind: 'frame';
  sourceType: 'frame' | 'group' | 'component' | 'componentSet';
  flattenable?: boolean;
  variantProperties: Record<string, string>;
  layout: ImportLayout | null;
  clipContent: boolean;
  backgroundColor: string | null;
  children: ImportNode[];
}

export interface ImportInstance extends ImportNodeBase {
  kind: 'instance';
  componentId: string;
  overrides: ImportInstanceOverride[];
}

export interface ImportInstanceOverride {
  targetId: string;
  targetPath: string[];
  componentId: string | null;
  name: string | null;
  text: string | null;
  visible: boolean | null;
  opacity: number | null;
  width: number | null;
  height: number | null;
  fillColor: string | null;
  strokeColor: string | null;
  strokeWidth: number | null;
  cornerRadius: [number, number, number, number] | null;
  fontFamily: string | null;
  fontSize: number | null;
  bold: boolean | null;
  italic: boolean | null;
  underline: boolean | null;
  strikethrough: boolean | null;
}

export interface ImportText extends ImportNodeBase {
  kind: 'text';
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  align: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  lineHeight: number | null;
  letterSpacing: number;
  autoSize: 'none' | 'both' | 'height' | 'ellipsis';
  singleLine: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strikethrough: boolean;
  runs: ImportTextRun[];
  shadow: ImportShadow | null;
}

export interface ImportShape extends ImportNodeBase {
  kind: 'shape';
  shape: 'rectangle' | 'ellipse' | 'polygon';
  fillColor: string;
  strokeColor: string | null;
  strokeWidth: number;
  cornerRadius: [number, number, number, number] | null;
  points: number[] | null;
  shadows: ImportShadow[];
}

export interface ImportImage extends ImportNodeBase {
  kind: 'image';
  format: 'png' | 'svg';
  bytes: Uint8Array;
}

export type ImportNode = ImportFrame | ImportInstance | ImportText | ImportShape | ImportImage;

export interface ImportPage {
  id: string;
  name: string;
  roots: ImportFrame[];
}

export interface ImportDocument {
  name: string;
  pages: ImportPage[];
  diagnostics: Diagnostic[];
}
