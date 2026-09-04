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

export async function compareVisualBlobs(reference: Blob, capture: Blob) {
  const [referenceImage, captureImage] = await Promise.all([createImageBitmap(reference), createImageBitmap(capture)])
  try {
    const referencePixels = readPixels(referenceImage)
    const capturePixels = readPixels(captureImage)
    const compared = comparePixelData(referencePixels, capturePixels)
    const canvas = document.createElement("canvas")
    canvas.width = compared.metrics.width
    canvas.height = compared.metrics.height
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context) throw new Error("浏览器无法生成 Pixel Diff。")
    context.putImageData(
      new ImageData(compared.diff, compared.metrics.width, compared.metrics.height),
      0,
      0,
    )
    const diff = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (
      blob ? resolve(blob) : reject(new Error("无法生成 Pixel Diff PNG。"))
    ), "image/png"))
    return {
      reference: { width: referenceImage.width, height: referenceImage.height },
      capture: { width: captureImage.width, height: captureImage.height },
      metrics: compared.metrics,
      diff,
    }
  } finally {
    referenceImage.close()
    captureImage.close()
  }
}

function readPixels(image: ImageBitmap) {
  if (image.width > 8_192 || image.height > 8_192 || image.width * image.height > 32_000_000) {
    throw new Error("视觉证据图片尺寸过大。")
  }
  const canvas = document.createElement("canvas")
  canvas.width = image.width
  canvas.height = image.height
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context) throw new Error("浏览器无法读取视觉证据图片。")
  context.drawImage(image, 0, 0)
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data }
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
