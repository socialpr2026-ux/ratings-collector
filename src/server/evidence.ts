import { createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const gzipAsync = promisify(gzip);

export interface EvidenceStore {
  put(payload: unknown): Promise<string>;
}

export class FileEvidenceStore implements EvidenceStore {
  private cleanup?: Promise<void>;
  constructor(private readonly directory = process.env.DATA_DIR ?? "./data") {}

  async put(payload: unknown): Promise<string> {
    const json = JSON.stringify(payload);
    const digest = createHash("sha256").update(json).digest("hex");
    const folder = resolve(this.directory, "evidence");
    await mkdir(folder, { recursive: true });
    this.cleanup ??= this.cleanupExpired(folder);
    await this.cleanup;
    await writeFile(resolve(folder, `${digest}.json.gz`), await gzipAsync(Buffer.from(json)));
    return `evidence:${digest}`;
  }

  private async cleanupExpired(folder: string): Promise<void> {
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    for (const name of await readdir(folder)) {
      if (!name.endsWith(".json.gz")) continue;
      const path = resolve(folder, name);
      try {
        if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
      } catch { /* a concurrent cleanup may already have removed the file */ }
    }
  }
}

export class MemoryEvidenceStore implements EvidenceStore {
  readonly items = new Map<string, unknown>();
  async put(payload: unknown): Promise<string> {
    const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    this.items.set(digest, structuredClone(payload));
    return `evidence:${digest}`;
  }
}
