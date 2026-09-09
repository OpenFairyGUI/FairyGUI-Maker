// Shared persisted byte encoding for CLI snapshots and Host drafts.
export function stringifyImportJson(value: unknown): string {
  return `${JSON.stringify(value, function (this: Record<string, unknown>, key, item) {
    const original = this[key];
    return original instanceof Uint8Array
      ? { $uint8: Buffer.from(original.buffer, original.byteOffset, original.byteLength).toString('base64') }
      : item;
  }, 2)}\n`;
}

export function parseImportJson(text: string): unknown {
  return JSON.parse(text, (_key, item) => {
    if (!item || typeof item !== 'object' || Object.keys(item).length !== 1 || typeof item.$uint8 !== 'string') return item;
    const bytes = Buffer.from(item.$uint8, 'base64');
    // Keep Uint8Array JSON semantics, without copying the decoded Buffer again.
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  });
}
