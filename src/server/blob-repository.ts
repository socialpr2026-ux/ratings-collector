import { createHash, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { getStore, PreconditionFailedError, type Store } from "@edgeone/pages-blob";
import type { EvidenceStore } from "./evidence.js";
import type { Observation, ProductRecord, PublicationRecord, RunState, SiteProfile } from "../shared/types.js";
import { productKey, type Repository } from "./repository.js";

const gzipAsync = promisify(gzip);
const strongJson = { type: "json" as const, consistency: "strong" as const };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const segment = (value: string) => encodeURIComponent(value.toLocaleLowerCase("en-US"));
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let cleanupCompletedDay: string | undefined;

export function ratingsBlobStore(): Store {
  return getStore("ratings-state");
}

export class BlobRepository implements Repository {
  constructor(private readonly store: Store = ratingsBlobStore()) {}

  async getRun(id: string): Promise<RunState | undefined> {
    return (await this.store.get(`runs/${segment(id)}.json`, strongJson) as RunState | null) ?? undefined;
  }

  async saveRun(run: RunState): Promise<void> {
    await this.withLease(`run:${run.id}`, 20_000, () => this.store.setJSON(`runs/${segment(run.id)}.json`, run));
  }

  async getProfile(domain: string): Promise<SiteProfile | undefined> {
    return (await this.store.get(`profiles/${segment(domain)}.json`, strongJson) as SiteProfile | null) ?? undefined;
  }

  async saveProfile(profile: SiteProfile): Promise<void> {
    await this.withLease(`profile:${profile.domain}`, 20_000, () => this.store.setJSON(`profiles/${segment(profile.domain)}.json`, profile));
  }

  async listProducts(spreadsheetId: string): Promise<ProductRecord[]> {
    return (await this.store.get(`sheets/${segment(spreadsheetId)}/products.json`, strongJson) as ProductRecord[] | null) ?? [];
  }

  async saveProducts(spreadsheetId: string, records: ProductRecord[]): Promise<void> {
    await this.withLease(`products:${spreadsheetId}`, 20_000, async () => {
      const products = new Map((await this.listProducts(spreadsheetId)).map((item) => [item.key, item]));
      for (const record of records) products.set(record.key, structuredClone(record));
      await this.store.setJSON(`sheets/${segment(spreadsheetId)}/products.json`, [...products.values()]);
    });
  }

  async replaceProducts(spreadsheetId: string, records: ProductRecord[]): Promise<void> {
    await this.withLease(`products:${spreadsheetId}`, 20_000, () =>
      this.store.setJSON(`sheets/${segment(spreadsheetId)}/products.json`, structuredClone(records))
    );
  }

  async getSnapshots(spreadsheetId: string): Promise<Record<string, Record<string, Observation>>> {
    return (await this.store.get(`sheets/${segment(spreadsheetId)}/snapshots.json`, strongJson) as Record<string, Record<string, Observation>> | null) ?? {};
  }

  async saveSnapshot(spreadsheetId: string, month: string, observations: Observation[]): Promise<void> {
    await this.withLease(`snapshots:${spreadsheetId}`, 20_000, async () => {
      const snapshots = await this.getSnapshots(spreadsheetId);
      snapshots[month] = Object.fromEntries(observations.map((item) => [productKey(item.domain, item.listingId), structuredClone(item)]));
      await this.store.setJSON(`sheets/${segment(spreadsheetId)}/snapshots.json`, snapshots);
    });
  }

  async replaceSnapshots(
    spreadsheetId: string,
    snapshots: Record<string, Record<string, Observation>>
  ): Promise<void> {
    await this.withLease(`snapshots:${spreadsheetId}`, 20_000, () =>
      this.store.setJSON(`sheets/${segment(spreadsheetId)}/snapshots.json`, structuredClone(snapshots))
    );
  }

  async getPublication(key: string): Promise<PublicationRecord | undefined> {
    return (await this.store.get(`publications/${hash(key)}.json`, strongJson) as PublicationRecord | null) ?? undefined;
  }

  async savePublication(key: string, publication: PublicationRecord): Promise<void> {
    await this.withLease(`publication:${key}`, 20_000, () => this.store.setJSON(`publications/${hash(key)}.json`, publication));
  }

  async reserveUsage(key: string, amount: number, limit: number): Promise<number> {
    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(limit) || limit <= 0 || limit > 4.5) {
      throw new Error("Некорректные параметры квоты");
    }
    return this.withLease(`usage:${key}`, 20_000, async () => {
      const path = `usage/${hash(key)}.json`;
      const value = await this.store.get(path, strongJson) as { used?: number } | null;
      const used = Number(value?.used ?? 0);
      if (!Number.isFinite(used) || used < 0 || used + amount > limit + Number.EPSILON) {
        throw new Error(`Квота ${limit} исчерпана (зарезервировано ${Number.isFinite(used) ? used : "неизвестно"})`);
      }
      if (amount === 0) return used;
      // Keep the exact conservative reservation; rounding here could either
      // undercount usage or reject a deliberately sub-cent monthly cap.
      const next = used + amount;
      await this.store.setJSON(path, { used: next, updatedAt: new Date().toISOString() });
      return next;
    });
  }

  async acquireLease(scope: string, leaseMs: number, attempts = 30): Promise<{ token: string; keys: string[] }> {
    if (!Number.isFinite(leaseMs) || leaseMs < 1000 || leaseMs > 3_700_000) throw new Error("Некорректная длительность lease");
    const token = randomUUID();
    const lockPrefix = `locks/${hash(scope)}`;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const slot = Math.floor(Date.now() / leaseMs);
      const keys = [`${lockPrefix}/${slot}.json`, `${lockPrefix}/${slot + 1}.json`];
      const acquired: string[] = [];
      try {
        for (const key of keys) {
          await this.store.setJSON(key, { token, scope, expiresAt: Date.now() + 2 * leaseMs }, { onlyIfNew: true });
          acquired.push(key);
        }
        return { token, keys };
      } catch (error) {
        for (const key of acquired) {
          const current = await this.store.get(key, strongJson) as { token?: string } | null;
          if (current?.token === token) await this.store.delete(key);
        }
        if (!(error instanceof PreconditionFailedError) && (error as { code?: string }).code !== "PRECONDITION_FAILED") throw error;
        await delay(75 + attempt * 25);
      }
    }
    throw new Error(`Ресурс занят другим запуском: ${scope}`);
  }

  async releaseLease(lease: { token: string; keys: string[] }): Promise<void> {
    for (const key of lease.keys) {
      const current = await this.store.get(key, strongJson) as { token?: string } | null;
      if (current?.token === lease.token) await this.store.delete(key);
    }
  }

  async withLease<T>(scope: string, leaseMs: number, action: () => Promise<T>): Promise<T> {
    const lease = await this.acquireLease(scope, leaseMs);
    try {
      return await action();
    } finally {
      await this.releaseLease(lease);
    }
  }
}

export class BlobEvidenceStore implements EvidenceStore {
  constructor(private readonly store: Store = ratingsBlobStore()) {}

  async put(payload: unknown): Promise<string> {
    // Cleanup is triggered by authenticated Agent evidence traffic instead of
    // exposing a public maintenance endpoint. The daily marker keeps this to
    // one scan per active day.
    await this.cleanupExpired().catch(() => undefined);
    const json = JSON.stringify(payload);
    const digest = hash(json);
    const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
    const key = `evidence/${expiresAt}/${digest}.json.gz`;
    const compressed = await gzipAsync(Buffer.from(json));
    const bytes = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength) as ArrayBuffer;
    await this.store.set(key, bytes, { onlyIfNew: true }).catch((error) => {
      if (!(error instanceof PreconditionFailedError) && (error as { code?: string }).code !== "PRECONDITION_FAILED") throw error;
    });
    return `blob:ratings-state:${key}`;
  }

  async cleanupExpired(now = Date.now()): Promise<number> {
    const day = new Date(now).toISOString().slice(0, 10);
    if (cleanupCompletedDay === day) return 0;
    const markerPath = `maintenance/evidence-cleanup/${day}.json`;
    const existingMarker = await this.store.get(markerPath, strongJson) as { completedAt?: string } | null;
    if (existingMarker?.completedAt) {
      cleanupCompletedDay = day;
      return 0;
    }

    const repository = new BlobRepository(this.store);
    const lease = await repository.acquireLease("maintenance:evidence-cleanup", 300_000, 1).catch((error) => {
      if ((error as Error).message.startsWith("Ресурс занят другим запуском")) return undefined;
      throw error;
    });
    if (!lease) return 0;
    try {
      const alreadyCompleted = await this.store.get(markerPath, strongJson) as { completedAt?: string } | null;
      if (alreadyCompleted?.completedAt) {
        cleanupCompletedDay = day;
        return 0;
      }

      const { blobs } = await this.store.list({ prefix: "evidence/", consistency: "strong" });
      let deleted = 0;
      for (const item of blobs) {
        const expiresAt = Number(item.key.split("/")[1]);
        if (Number.isFinite(expiresAt) && expiresAt <= now) {
          await this.store.delete(item.key);
          deleted += 1;
        }
      }
      await this.store.setJSON(markerPath, { completedAt: new Date(now).toISOString(), deleted });
      cleanupCompletedDay = day;
      return deleted;
    } finally {
      await repository.releaseLease(lease);
    }
  }
}
