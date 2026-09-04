import { probeRasterImage, validateSafeSvgSource } from "@openfairygui/core"
import { checkBudget, checkPngDimensions, probeWebpDimensions, RUNTIME_LIMITS } from "./resource-budget"

self.onmessage = ({ data }: MessageEvent<{ bytes: ArrayBuffer; svg: boolean }>) => {
  try {
    checkBudget(data.bytes.byteLength, RUNTIME_LIMITS.fileBytes, "image_encoded_bytes")
    const bytes = new Uint8Array(data.bytes)
    checkPngDimensions(bytes)
    const result = data.svg ? { svg: validateSafeSvgSource(bytes) } : probeWebpDimensions(bytes) ?? probeRasterImage(bytes)
    if (!result) throw new Error("Unsupported or invalid image (expected static PNG, JPEG, WebP or safe SVG)")
    self.postMessage({ result })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) })
  }
}
