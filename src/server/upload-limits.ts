import type { MiddlewareHandler } from "hono"
import { MAX_ARTIFACT_FILE_BYTES } from "../artifact-protocol"
import { MAX_IMPORT_SOURCE_BYTES, MAX_VISUAL_EVIDENCE_BYTES } from "../design-import/draft-store"
import { UploadError, UPLOAD_TIMEOUT_MS } from "../upload"

export const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024
// ponytail: native formData buffers at most this envelope; stream multipart parts only if larger evidence is needed.
export const MAX_VISUAL_UPLOAD_BYTES = MAX_VISUAL_EVIDENCE_BYTES * 3 + 64 * 1024
export const MAX_ACTIVE_UPLOADS = 4

export function uploadLimits(): MiddlewareHandler {
  let activeUploads = 0
  return async (c, next) => {
    if (!["POST", "PUT", "PATCH"].includes(c.req.method) || !c.req.raw.body) return next()
    const artifact = c.req.method === "PUT" && /^\/api\/artifact-imports\/[^/]+\/files$/.test(c.req.path)
    const draft = c.req.method === "PUT" && /^\/api\/import-drafts\/[^/]+\/source$/.test(c.req.path)
    const visual = c.req.method === "POST" && /^\/api\/import-drafts\/[^/]+\/visual-evidence$/.test(c.req.path)
    const upload = artifact || draft || visual
    const maxBytes = artifact ? MAX_ARTIFACT_FILE_BYTES : draft ? MAX_IMPORT_SOURCE_BYTES : visual ? MAX_VISUAL_UPLOAD_BYTES : MAX_JSON_BODY_BYTES
    const length = c.req.header("content-length")
    if (length && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) return c.json({ error: "upload_content_length_invalid" }, 400, { Connection: "close" })
    if (length && Number(length) > maxBytes) return c.json({ error: "upload_size_exceeded" }, 413, { Connection: "close" })
    if (upload && activeUploads >= MAX_ACTIVE_UPLOADS) return c.json({ error: "upload_concurrency_limit_reached" }, 503, { Connection: "close" })
    if (upload) activeUploads += 1
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(UPLOAD_TIMEOUT_MS)])
    let failure: UploadError | undefined
    let bytes = 0
    const body = c.req.raw.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > maxBytes) {
          failure = new UploadError("upload_size_exceeded", 413)
          throw failure
        }
        controller.enqueue(chunk)
      },
    }), { signal })
    try {
      c.req.raw = new Request(c.req.raw, { body, signal, duplex: "half" } as RequestInit)
      await next()
      // JSON/multipart parsers may wrap stream errors; keep the ingress status.
      if (failure) c.res = c.json({ error: failure.message }, failure.status)
      else if (signal.aborted) c.res = c.json({ error: "upload_aborted_or_timed_out" }, 408)
      // The HTTP adapter must not keep a rejected, potentially unfinished body alive.
      if (c.res.status >= 400) c.header("Connection", "close")
    } finally {
      if (upload) activeUploads -= 1
      if (!body.locked) await body.cancel().catch(() => undefined)
    }
  }
}
