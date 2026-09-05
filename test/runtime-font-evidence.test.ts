import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectRuntimeFont, type RuntimeFontEvidence } from '../src/runtime/font-evidence';

test('font probing bounds unique families, reuses measurements and distinguishes evidence from fallback', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let probes = 0;
  const context = { font: '', measureText() { probes++; return { width: this.font.includes('Distinct') ? 101 : 100 }; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    fonts: [{ family: 'Loaded', status: 'loaded' }], createElement: () => ({ getContext: () => context }),
  } });
  try {
    const cache = new Map<string, RuntimeFontEvidence['availability']>();
    const object = { textWidth: 101, width: 100, singleLine: true };
    assert.equal(inspectRuntimeFont(object, 'Loaded', cache).availability, 'loaded-face');
    assert.equal(inspectRuntimeFont(object, 'Distinct', cache).availability, 'metrics-distinct');
    assert.equal(inspectRuntimeFont(object, 'Missing', cache).availability, 'fallback-or-equivalent');
    const previous = probes;
    assert.equal(inspectRuntimeFont(object, 'Missing', cache).singleLineOverflow, true);
    assert.equal(probes, previous);
    for (let index = 0; index < 200; index++) inspectRuntimeFont(object, `Family ${index}`, cache);
    assert.equal(cache.size, 128);
    const bounded = probes;
    assert.equal(inspectRuntimeFont(object, 'Beyond limit', cache).availability, 'unverified');
    assert.equal(probes, bounded);
    assert.equal(inspectRuntimeFont(object, 'sans-serif', cache).availability, 'generic');
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
