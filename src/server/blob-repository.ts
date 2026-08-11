import { createHash, randomUUID } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { getStore, PreconditionFailedError, type Store } from "@edgeone/pages-blob";
import type { EvidenceStore } from "./evidence.js";
import type {
  BeginAttemptCommand,
  CommitPartitionCommand,
  FinishAttemptCommand,
  Observation,
  PartitionCheckpoint,
  ProductRecord,
  PublicationRecord,
  RunAttempt,
  RunHistoryItem,
  RunState,
  RunSummaryV2,
  SiteProfile,
  SourceCardRecord
} from "../shared/types.js";
import { productMasterCatalogSchema, type ProductMasterCatalog } from "../shared/product-master.js";
import {
  assertProductMasterRevision,
  attemptPartitionKey,
  beginAttemptTransition,
  commitPartitionTransition,
  emptyProductMasterCatalog,
  finishAttemptTransition,
  LeaseConflictError,
  nextRunSummaryV2,
  productKey,
  runHistoryItem,
  type RepositoryLease,
  type Repository
} from "./repository.js";

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

  async findRecentRunsByBrand(brand: string, limit = 5): Promise<Array<{
    id: string;
    status: RunState["status"];
    updatedAt: string;
    brands: string[];
    completedPartitions: number;
    totalPartitions: number;
  }>> {
    const normalized = brand.normalize("NFKC").toLocaleLowerCase("ru-RU").trim();
    if (normalized.length < 2 || normalized.length > 160) throw new Error("Invalid run brand lookup");
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 5));
    const { blobs } = await this.store.list({ prefix: "runs/", consistency: "strong" });
    const runs = await Promise.all(blobs.map((item) => this.store.get(item.key, strongJson) as Promise<RunState | null>));
    return runs
      .filter((run): run is RunState => Boolean(run?.request.brands.some((item) =>
        item.normalize("NFKC").toLocaleLowerCase("ru-RU").trim() === normalized
      )))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, boundedLimit)
      .map((run) => ({
        id: run.id,
        status: run.status,
        updatedAt: run.updatedAt,
        brands: [...run.request.brands],
        completedPartitions: run.progress.completedPartitions,
        totalPartitions: run.progress.totalPartitions
      }));
  }

  async getRun(id: string): Promise<RunState | undefined> {
    return (await this.store.get(`runs/${segment(id)}.json`, strongJson) as RunState | null) ?? undefined;
  }

  async getRunSummary(id: string): Promise<RunSummaryV2 | undefined> {
    return (await this.store.get(`run-summaries/${segment(id)}.json`, strongJson) as RunSummaryV2 | null) ?? undefined;
  }

  async getProductMaster(): Promise<ProductMasterCatalog> {
    const stored = await this.store.get("product-master/catalog-v2.json", strongJson) as ProductMasterCatalog | null;
    return stored ? productMasterCatalogSchema.parse(stored) : emptyProductMasterCatalog();
  }

  async saveProductMaster(catalog: ProductMasterCatalog, expectedRevision: number): Promise<void> {
    await this.withLease("product-master:v2", 20_000, async () => {
      const current = await this.getProductMaster();
      assertProductMasterRevision(catalog, current.revision, expectedRevision);
      await this.store.setJSON("product-master/catalog-v2.json", productMasterCatalogSchema.parse(catalog));
    });
  }

  async getRunAttempt(runId: string): Promise<RunAttempt | undefined> {
    return (await this.store.get(`run-attempt-heads/${segment(runId)}.json`, strongJson) as RunAttempt | null) ?? undefined;
  }

  async getPartitionCheckpoint(
    runId: string,
    fencingToken: number,
    domain: string,
    brand: string
  ): Promise<PartitionCheckpoint | undefined> {
    const partitionKey = attemptPartitionKey(domain, brand);
    return (await this.store.get(
      `run-attempt-partitions/${segment(runId)}/${fencingToken}/${hash(partitionKey)}.json`,
      strongJson
    ) as PartitionCheckpoint | null) ?? undefined;
  }

  async beginAttempt(command: BeginAttemptCommand): Promise<RunAttempt> {
    return this.withLease(`run-attempt:${command.runId}`, 20_000, async () => {
      if (!await this.getRun(command.runId)) throw new Error("run_not_found");
      const current = await this.getRunAttempt(command.runId);
      const { attempt, superseded } = beginAttemptTransition(current, command);
      await this.store.setJSON(
        `run-attempts/${segment(command.runId)}/${attempt.fencingToken}.json`,
        attempt
      );
      await this.store.setJSON(`run-attempt-heads/${segment(command.runId)}.json`, attempt);
      if (superseded) {
        await this.store.setJSON(
          `run-attempts/${segment(command.runId)}/${superseded.fencingToken}.json`,
          superseded
        );
      }
      return attempt;
    });
  }

  async commitPartition(command: CommitPartitionCommand): Promise<PartitionCheckpoint> {
    return this.withLease(`run-attempt:${command.runId}`, 20_000, async () => {
      const current = await this.getRunAttempt(command.runId);
      const partitionKey = attemptPartitionKey(command.partition.domain, command.partition.brand);
      const checkpointPath = `run-attempt-partitions/${segment(command.runId)}/${command.fencingToken}/${hash(partitionKey)}.json`;
      const existing = await this.store.get(checkpointPath, strongJson) as PartitionCheckpoint | null;
      const transition = commitPartitionTransition(current, command, existing ?? undefined);
      if (!existing) await this.store.setJSON(checkpointPath, transition.checkpoint, { onlyIfNew: true });
      await this.store.setJSON(
        `run-attempts/${segment(command.runId)}/${transition.attempt.fencingToken}.json`,
        transition.attempt
      );
      await this.store.setJSON(`run-attempt-heads/${segment(command.runId)}.json`, transition.attempt);
      return transition.checkpoint;
    });
  }

  async finishAttempt(command: FinishAttemptCommand): Promise<RunAttempt> {
    return this.withLease(`run-attempt:${command.runId}`, 20_000, async () => {
      const current = await this.getRunAttempt(command.runId);
      const finished = finishAttemptTransition(current, command);
      await this.store.setJSON(
        `run-attempts/${segment(command.runId)}/${finished.fencingToken}.json`,
        finished
      );
      await this.store.setJSON(`run-attempt-heads/${segment(command.runId)}.json`, finished);
      return finished;
    });
  }

  async listRecentRuns(ownerEmail?: string, limit = 8): Promise<RunHistoryItem[]> {
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 8));
    const { blobs } = await this.store.list({ prefix: "run-history/", consistency: "strong" });
    const history = await Promise.all(blobs.map((item) => this.store.get(item.key, strongJson) as Promise<(RunHistoryItem & { ownerEmail?: string }) | null>));
    return history
      .filter((item): item is RunHistoryItem & { ownerEmail?: string } => Boolean(item && (!ownerEmail || item.ownerEmail === ownerEmail)))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, boundedLimit)
      .map(({ ownerEmail: _ownerEmail, ...item }) => item);
  }

  async saveRun(run: RunState): Promise<void> {
    await this.withLease(`run:${run.id}`, 20_000, async () => {
      const summaryPath = `run-summaries/${segment(run.id)}.json`;
      const previousSummary = await this.store.get(summaryPath, strongJson) as RunSummaryV2 | null;
      const summary = nextRunSummaryV2(run, previousSummary ?? undefined);
      await this.store.setJSON(`runs/${segment(run.id)}.json`, run);
      // The compact projection advances only after the full checkpoint is
      // durable, so a terminal summary can never point at an older RunState.
      await this.store.setJSON(summaryPath, summary);
      if (run.collectionFinishedAt) {
        await this.store.setJSON(`run-history/${segment(run.id)}.json`, {
          ...runHistoryItem(run),
          ownerEmail: run.ownerEmail
        });
      }
    });
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

  async listSourceCards(spreadsheetId: string): Promise<SourceCardRecord[]> {
    return (await this.store.get(`sheets/${segment(spreadsheetId)}/source-cards.json`, strongJson) as SourceCardRecord[] | null) ?? [];
  }

  async saveSourceCards(spreadsheetId: string, records: SourceCardRecord[]): Promise<void> {
    await this.withLease(`source-cards:${spreadsheetId}`, 20_000, async () => {
      const sourceCards = new Map((await this.listSourceCards(spreadsheetId)).map((item) => [item.key, item]));
      for (const record of records) {
        const previous = sourceCards.get(record.key);
        sourceCards.set(record.key, {
          ...structuredClone(record),
          firstSeenAt: previous?.firstSeenAt ?? record.firstSeenAt
        });
      }
      await this.store.setJSON(`sheets/${segment(spreadsheetId)}/source-cards.json`, [...sourceCards.values()]);
    });
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

  async releaseUsage(key: string, amount: number): Promise<number> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Incorrect usage release parameters");
    }
    return this.withLease(`usage:${key}`, 20_000, async () => {
      const path = `usage/${hash(key)}.json`;
      const value = await this.store.get(path, strongJson) as { used?: number } | null;
      const used = Number(value?.used ?? 0);
      if (!Number.isFinite(used) || used < 0) {
        throw new Error("Incorrect reserved usage value");
      }
      const next = Math.max(0, used - amount);
      if (next !== used) {
        await this.store.setJSON(path, { used: next, updatedAt: new Date().toISOString() });
      }
      return next;
    });
  }

  async acquireLease(scope: string, leaseMs: number, attempts = 30): Promise<RepositoryLease> {
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
        return { token, keys, scope };
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

  async renewLease(lease: RepositoryLease, leaseMs: number): Promise<RepositoryLease> {
    if (!Number.isFinite(leaseMs) || leaseMs < 1000 || leaseMs > 3_700_000 ||
      !lease.scope?.trim() || !lease.token.trim() || lease.keys.length === 0) {
      throw new Error("Некорректное продление lease");
    }
    const records = await Promise.all(lease.keys.map((key) => this.store.get(key, strongJson) as Promise<{
      token?: string;
      scope?: string;
    } | null>));
    if (records.some((record) => record?.token !== lease.token || record.scope !== lease.scope)) {
      throw new LeaseConflictError();
    }
    const lockPrefix = `locks/${hash(lease.scope)}`;
    const slot = Math.floor(Date.now() / leaseMs);
    const targetKeys = [`${lockPrefix}/${slot}.json`, `${lockPrefix}/${slot + 1}.json`];
    const expiresAt = Date.now() + 2 * leaseMs;
    const newlyAcquired: string[] = [];
    try {
      for (const key of targetKeys) {
        if (lease.keys.includes(key)) continue;
        try {
          await this.store.setJSON(key, { token: lease.token, scope: lease.scope, expiresAt }, { onlyIfNew: true });
          newlyAcquired.push(key);
        } catch (error) {
          if (!(error instanceof PreconditionFailedError) && (error as { code?: string }).code !== "PRECONDITION_FAILED") throw error;
          const current = await this.store.get(key, strongJson) as { token?: string; scope?: string } | null;
          if (current?.token !== lease.token || current.scope !== lease.scope) throw new LeaseConflictError();
        }
      }
    } catch (error) {
      for (const key of newlyAcquired) {
        const current = await this.store.get(key, strongJson) as { token?: string } | null;
        if (current?.token === lease.token) await this.store.delete(key);
      }
      throw error;
    }
    // Keep prior slots in the returned handle. That makes a renewal replay
    // safe when the RPC response is lost: the old handle still proves the
    // token and can discover the already-created current slots.
    return { token: lease.token, keys: [...new Set([...lease.keys, ...targetKeys])], scope: lease.scope };
  }

  async releaseLease(lease: RepositoryLease): Promise<void> {
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
