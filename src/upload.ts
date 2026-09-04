import { createHash, randomUUID } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import { lstat, mkdir, rename, rm } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

export const MAX_PENDING_UPLOADS = 16
export const PENDING_UPLOAD_TTL_MS = 30 * 60 * 1_000
export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1_000
export type UploadBody = ReadableStream<Uint8Array> | Uint8Array | null

export class UploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 408 | 409 | 413 | 503 = 400) {
    super(message)
  }
}

export async function hashUploadFile(filePath: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest("hex")
}

// Callers serialize writes to a target in their private store. Staging is outside
// the declared source namespace, so an interrupted .part can never be completed.
export async function receiveUpload(
  target: string,
  stagingRoot: string,
  body: UploadBody,
  declared: { size: number; sha256?: string },
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(declared.size) || declared.size < 0) throw new UploadError("upload_size_invalid")
  const cancellation = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(UPLOAD_TIMEOUT_MS)])
  const temporary = path.join(stagingRoot, `${randomUUID()}.part`)
  const hash = createHash("sha256")
  let size = 0
  try {
    cancellation.throwIfAborted()
    await mkdir(stagingRoot, { recursive: true })
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength
        if (size > declared.size) return callback(new UploadError("upload_size_exceeded", 413))
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    const source = body instanceof Uint8Array ? Readable.from([body]) : body ?? Readable.from([])
    await pipeline(source, counter, createWriteStream(temporary, { flags: "wx", flush: true }), { signal: cancellation })
    if (size !== declared.size) throw new UploadError("upload_size_mismatch")
    const sha256 = hash.digest("hex")
    if (declared.sha256 && sha256 !== declared.sha256) throw new UploadError("upload_digest_mismatch", 409)

    const existing = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.size !== size || await hashUploadFile(target) !== sha256)) {
      throw new UploadError("upload_file_content_conflict", 409)
    }
    cancellation.throwIfAborted()
    if (!existing) {
      await mkdir(path.dirname(target), { recursive: true })
      cancellation.throwIfAborted()
      await rename(temporary, target)
    }
    return { size, sha256 }
  } catch (error) {
    if (cancellation.aborted) {
      throw cancellation.reason instanceof UploadError ? cancellation.reason : new UploadError("upload_aborted_or_timed_out", 408)
    }
    throw error
  } finally {
    if (body && !(body instanceof Uint8Array) && !body.locked) await body.cancel().catch(() => undefined)
    await rm(temporary, { force: true })
  }
}
