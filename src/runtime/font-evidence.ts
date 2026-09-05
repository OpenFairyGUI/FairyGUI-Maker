export type RuntimeFontEvidence = {
  family: string;
  availability: 'bitmap' | 'generic' | 'loaded-face' | 'metrics-distinct' | 'fallback-or-equivalent' | 'unverified';
  renderedTextWidth?: number;
  singleLineOverflow?: boolean;
};

// Metric probing is evidence, not a claim about installed files or complete glyph coverage.
let context: CanvasRenderingContext2D | null;
export function inspectRuntimeFont(object: any, family: string, cache: Map<string, RuntimeFontEvidence['availability']>): RuntimeFontEvidence {
  let availability = cache.get(family);
  if (!availability) {
    availability = 'unverified';
    if (family.startsWith('ui://')) availability = 'bitmap';
    else if (/^(serif|sans-serif|monospace|cursive|fantasy|system-ui)$/i.test(family)) availability = 'generic';
    // Bound optional metric work independently of the scene's text-node budget.
    else if (cache.size < 128 && family.length <= 256 && !/["\\\u0000-\u001f]/.test(family)) {
      let count = 0;
      for (const face of document.fonts) {
        if (++count > 1_024) break;
        if (face.family.replace(/^["']|["']$/g, '').toLowerCase() === family.toLowerCase() && face.status === 'loaded') availability = 'loaded-face';
      }
      if (availability !== 'loaded-face') {
        context ??= document.createElement('canvas').getContext('2d');
        if (context) {
          const measure = (font: string) => { context!.font = `72px ${font}`; return context!.measureText('mmmmWWWWil0123456789').width; };
          availability = ['monospace', 'serif'].some((fallback) => measure(`"${family}", ${fallback}`) !== measure(fallback))
            ? 'metrics-distinct' : 'fallback-or-equivalent';
        }
      }
    }
    if (cache.size < 128) cache.set(family, availability);
  }
  const width = Number(object.textWidth);
  return { family, availability, ...(Number.isFinite(width) ? { renderedTextWidth: width,
    ...(object.singleLine === true ? { singleLineOverflow: width > Number(object.width) + 0.5 } : {}) } : {}) };
}
