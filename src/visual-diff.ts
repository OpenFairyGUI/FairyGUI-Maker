// Pure RGBA pixel comparison shared by Workbench visual evidence, browser test gates and Host visual baselines.

export type VisualMetrics = {
  width: number
  height: number
  totalPixels: number
  differentPixels: number
  meanAbsoluteError: number
  maxChannelDelta: number
}

export function comparePixelData(
  reference: { width: number; height: number; data: Uint8ClampedArray },
  capture: { width: number; height: number; data: Uint8ClampedArray },
) {
  assertPixels(reference)
  assertPixels(capture)
  const width = Math.max(reference.width, capture.width)
  const height = Math.max(reference.height, capture.height)
  const diff = new Uint8ClampedArray(width * height * 4)
  let differentPixels = 0
  let absoluteError = 0
  let maxChannelDelta = 0

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const output = (y * width + x) * 4
      let pixelDelta = 0
      for (let channel = 0; channel < 4; channel += 1) {
        const left = pixelChannel(reference, x, y, channel)
        const right = pixelChannel(capture, x, y, channel)
        const delta = Math.abs(left - right)
        absoluteError += delta
        pixelDelta = Math.max(pixelDelta, delta)
        maxChannelDelta = Math.max(maxChannelDelta, delta)
      }
      if (pixelDelta > 0) {
        differentPixels += 1
        diff[output] = 255
        diff[output + 3] = Math.max(48, pixelDelta)
      }
    }
  }

  const totalPixels = width * height
  return {
    diff,
    metrics: {
      width,
      height,
      totalPixels,
      differentPixels,
      meanAbsoluteError: totalPixels ? absoluteError / (totalPixels * 4) : 0,
      maxChannelDelta,
    } satisfies VisualMetrics,
  }
}

function assertPixels(image: { width: number; height: number; data: Uint8ClampedArray }) {
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1) {
    throw new Error("Invalid pixel dimensions")
  }
  if (image.data.length !== image.width * image.height * 4) throw new Error("Invalid pixel data length")
}

function pixelChannel(image: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number, channel: number) {
  return x < image.width && y < image.height ? image.data[(y * image.width + x) * 4 + channel] : 0
}
