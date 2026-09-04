import assert from "node:assert/strict"
import test from "node:test"

import { comparePixelData } from "../../src/web/lib/visual-evidence"

test("visual evidence reports exact pixel deltas without a global pass threshold", () => {
  const reference = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) }
  const capture = { width: 2, height: 1, data: new Uint8ClampedArray([10, 25, 30, 255, 1, 2, 3, 255]) }
  const result = comparePixelData(reference, capture)

  assert.deepEqual(result.metrics, {
    width: 2,
    height: 1,
    totalPixels: 2,
    differentPixels: 2,
    meanAbsoluteError: 33.25,
    maxChannelDelta: 255,
  })
  assert.deepEqual([...result.diff], [255, 0, 0, 48, 255, 0, 0, 255])
})
