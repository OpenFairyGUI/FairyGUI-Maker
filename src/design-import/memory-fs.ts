import type { FileSystem } from '@openfairygui/core/project-io';

function normalize(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string | Uint8Array>();
  private readonly directories = new Set(['/']);

  join(...paths: string[]): string {
    return normalize(paths.join('/'));
  }

  dirname(path: string): string {
    const normalized = normalize(path);
    return normalized.slice(0, normalized.lastIndexOf('/')) || '/';
  }

  async mkdir(path: string): Promise<void> {
    const parts = normalize(path).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      this.directories.add(current);
    }
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.mkdir(this.dirname(path));
    this.files.set(normalize(path), content);
  }

  async writeFileRaw(path: string, data: Uint8Array): Promise<void> {
    await this.mkdir(this.dirname(path));
    this.files.set(normalize(path), new Uint8Array(data));
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(normalize(path));
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  }

  async readFileRaw(path: string): Promise<Uint8Array> {
    const value = this.files.get(normalize(path));
    if (value === undefined) throw new Error(`File not found: ${path}`);
    return typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
  }

  async readdir(path: string): Promise<string[]> {
    const directory = normalize(path);
    const prefix = directory === '/' ? '/' : `${directory}/`;
    const children = new Set<string>();
    for (const candidate of [...this.directories, ...this.files.keys()]) {
      if (!candidate.startsWith(prefix) || candidate === directory) continue;
      const child = candidate.slice(prefix.length).split('/')[0];
      if (child) children.add(child);
    }
    return [...children].sort();
  }

  async exists(path: string): Promise<boolean> {
    const normalized = normalize(path);
    return this.files.has(normalized) || this.directories.has(normalized);
  }

  async unlink(path: string): Promise<void> {
    this.files.delete(normalize(path));
  }

  toZipEntries(wrapper: string): Record<string, Uint8Array> {
    const entries: Record<string, Uint8Array> = {};
    for (const [path, value] of this.files) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      entries[`${safeWrapper(wrapper)}/${path.slice(1)}`] = new Uint8Array(bytes);
    }
    return entries;
  }
}

function safeWrapper(value: string): string {
  return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'FigmaProject';
}
