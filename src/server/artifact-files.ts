import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import path from "node:path"
import { UploadError } from "../upload"

// Read, hash and return the SAME bounded buffer; a verified path/handle alone is
// not an immutable snapshot. Follow the Host project snapshot's no-link policy.
export async function readArtifactFile(root: string, relative: string, maxBytes: number, expected?: { size: number; sha256: string }, signal?: AbortSignal) {
  const changed = () => new UploadError("artifact_file_integrity_mismatch", 409)
  signal?.throwIfAborted()
  const canonicalRoot = await realpath(root)
  const checkedPath = async () => {
    let candidate = root
    for (const part of ["", ...relative.split("/")]) {
      candidate = path.join(candidate, part)
      if ((await lstat(candidate)).isSymbolicLink()) throw changed()
    }
    const canonical = await realpath(candidate)
    const outside = path.relative(canonicalRoot, canonical)
    if (outside === ".." || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) throw changed()
    return canonical
  }
  const filePath = await checkedPath()
  const initial = await lstat(filePath, { bigint: true })
  if (!initial.isFile() || initial.nlink !== 1n || initial.size > BigInt(maxBytes)) throw changed()
  const handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.dev !== initial.dev || before.ino !== initial.ino || before.size !== initial.size || before.nlink !== 1n) throw changed()
    if (expected && before.size !== BigInt(expected.size)) throw changed()
    const data = Buffer.alloc(Number(before.size))
    let offset = 0
    while (offset < data.length) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset)
      if (!bytesRead) throw changed()
      offset += bytesRead
    }
    const after = await handle.stat({ bigint: true })
    const confirmed = await lstat(await checkedPath(), { bigint: true })
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs", "nlink"] as const) {
      if (before[key] !== after[key] || before[key] !== confirmed[key]) throw changed()
    }
    if (expected && createHash("sha256").update(data).digest("hex") !== expected.sha256) throw changed()
    signal?.throwIfAborted()
    return data
  } finally { await handle.close() }
}
