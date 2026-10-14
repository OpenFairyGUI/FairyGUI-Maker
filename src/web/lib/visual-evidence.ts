import { comparePixelData } from "../../visual-diff"

export { comparePixelData, type VisualMetrics } from "../../visual-diff"

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
