import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  Observation,
  ProductRecord,
  PublicationRecord,
  RunHistoryItem,
  RunActivity,
  RunSummaryV2,
  RunState,
  SourceCardRecord,
  SiteProfile
} from "../shared/types.js";
import { productMasterCatalogSchema, type ProductMasterCatalog } from "../shared/product-master.js";

export type Database = {
  version: 1;
  runs: Record<string, RunState>;
  /** V2 shadow projection. Optional so existing local databases remain valid. */
  runSummaries?: Record<string, RunSummaryV2>;
  /** Global cross-sheet Product Master shadow catalog. */
  productMaster?: ProductMasterCatalog;
  profiles: Record<string, SiteProfile>;
  products: Record<string, Record<string, ProductRecord>>;
  sourceCards: Record<string, Record<string, SourceCardRecord>>;
  snapshots: Record<string, Record<string, Record<string, Observation>>>;
  publications: Record<string, PublicationRecord>;
  usage: Record<string, number>;
};

export interface Repository {
  getRun(id: string): Promise<RunState | undefined>;
  getRunSummary(id: string): Promise<RunSummaryV2 | undefined>;
  getProductMaster(): Promise<ProductMasterCatalog>;
  saveProductMaster(catalog: ProductMasterCatalog, expectedRevision: number): Promise<void>;
  saveRun(run: RunState): Promise<void>;
  listRecentRuns(ownerEmail?: string, limit?: number): Promise<RunHistoryItem[]>;
  getProfile(domain: string): Promise<SiteProfile | undefined>;
  saveProfile(profile: SiteProfile): Promise<void>;
  listProducts(spreadsheetId: string): Promise<ProductRecord[]>;
  saveProducts(spreadsheetId: string, records: ProductRecord[]): Promise<void>;
  replaceProducts(spreadsheetId: string, records: ProductRecord[]): Promise<void>;
  listSourceCards(spreadsheetId: string): Promise<SourceCardRecord[]>;
  saveSourceCards(spreadsheetId: string, records: SourceCardRecord[]): Promise<void>;
  getSnapshots(spreadsheetId: string): Promise<Record<string, Record<string, Observation>>>;
  saveSnapshot(spreadsheetId: string, month: string, observations: Observation[]): Promise<void>;
  replaceSnapshots(spreadsheetId: string, snapshots: Record<string, Record<string, Observation>>): Promise<void>;
  getPublication(key: string): Promise<PublicationRecord | undefined>;
  savePublication(key: string, publication: PublicationRecord): Promise<void>;
  reserveUsage(key: string, amount: number, limit: number): Promise<number>;
  releaseUsage(key: string, amount: number): Promise<number>;
  /** Optional cross-instance lock used by short atomic workflows. */
  acquireLease?(scope: string, leaseMs: number): Promise<{ token: string; keys: string[] }>;
  releaseLease?(lease: { token: string; keys: string[] }): Promise<void>;
}

const emptyDatabase = (): Database => ({
  version: 1,
  runs: {},
  runSummaries: {},
  profiles: {},
  products: {},
  sourceCards: {},
  snapshots: {},
  publications: {},
  usage: {}
});

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryRepository implements Repository {
  protected db: Database;

  constructor(seed?: Partial<Database>) {
    this.db = { ...emptyDatabase(), ...clone(seed ?? {}) } as Database;
  }

  async getRun(id: string) { return this.db.runs[id] ? clone(this.db.runs[id]) : undefined; }
  async getRunSummary(id: string) {
    const stored = this.db.runSummaries?.[id];
    if (stored) return clone(stored);
    const legacy = this.db.runs[id];
    return legacy ? createRunSummaryV2(legacy, 1) : undefined;
  }
  async getProductMaster() {
    return clone(this.db.productMaster ?? emptyProductMasterCatalog());
  }
  async saveProductMaster(catalog: ProductMasterCatalog, expectedRevision: number) {
    const current = this.db.productMaster ?? emptyProductMasterCatalog();
    assertProductMasterRevision(catalog, current.revision, expectedRevision);
    this.db.productMaster = clone(productMasterCatalogSchema.parse(catalog));
    await this.changed();
  }
  async saveRun(run: RunState) {
    const summaries = this.db.runSummaries ??= {};
    const previous = summaries[run.id] ?? (this.db.runs[run.id]
      ? createRunSummaryV2(this.db.runs[run.id], 1)
      : undefined);
    this.db.runs[run.id] = clone(run);
    summaries[run.id] = nextRunSummaryV2(run, previous);
    await this.changed();
  }
  async listRecentRuns(ownerEmail?: string, limit = 8): Promise<RunHistoryItem[]> {
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit) || 8));
    return Object.values(this.db.runs)
      .filter((run) => !ownerEmail || run.ownerEmail === ownerEmail)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
      .slice(0, boundedLimit)
      .map(runHistoryItem);
  }
  async getProfile(domain: string) { return this.db.profiles[domain] ? clone(this.db.profiles[domain]) : undefined; }
  async saveProfile(profile: SiteProfile) { this.db.profiles[profile.domain] = clone(profile); await this.changed(); }
  async listProducts(spreadsheetId: string) { return Object.values(clone(this.db.products[spreadsheetId] ?? {})); }
  async saveProducts(spreadsheetId: string, records: ProductRecord[]) {
    const products = this.db.products[spreadsheetId] ??= {};
    for (const record of records) products[record.key] = clone(record);
    await this.changed();
  }
  async replaceProducts(spreadsheetId: string, records: ProductRecord[]) {
    this.db.products[spreadsheetId] = Object.fromEntries(records.map((record) => [record.key, clone(record)]));
    await this.changed();
  }
  async listSourceCards(spreadsheetId: string) {
    return Object.values(clone((this.db.sourceCards ??= {})[spreadsheetId] ?? {}));
  }
  async saveSourceCards(spreadsheetId: string, records: SourceCardRecord[]) {
    const sourceCards = (this.db.sourceCards ??= {})[spreadsheetId] ??= {};
    for (const record of records) {
      const previous = sourceCards[record.key];
      sourceCards[record.key] = clone({
        ...record,
        firstSeenAt: previous?.firstSeenAt ?? record.firstSeenAt
      });
    }
    await this.changed();
  }
  async getSnapshots(spreadsheetId: string) { return clone(this.db.snapshots[spreadsheetId] ?? {}); }
  async saveSnapshot(spreadsheetId: string, month: string, observations: Observation[]) {
    const next: Record<string, Observation> = {};
    for (const observation of observations) next[productKey(observation.domain, observation.listingId)] = clone(observation);
    (this.db.snapshots[spreadsheetId] ??= {})[month] = next;
    await this.changed();
  }
  async replaceSnapshots(spreadsheetId: string, snapshots: Record<string, Record<string, Observation>>) {
    this.db.snapshots[spreadsheetId] = clone(snapshots);
    await this.changed();
  }
  async getPublication(key: string) {
    return this.db.publications[key] ? clone(this.db.publications[key]) : undefined;
  }
  async savePublication(key: string, publication: PublicationRecord) {
    this.db.publications[key] = clone(publication);
    await this.changed();
  }
  async reserveUsage(key: string, amount: number, limit: number): Promise<number> {
    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(limit) || limit <= 0 || limit > 4.5) {
      throw new Error("Invalid usage reservation parameters");
    }
    const used = this.db.usage[key] ?? 0;
    if (used + amount > limit + Number.EPSILON) throw new Error(`Квота ${limit} исчерпана (зарезервировано ${used})`);
    if (amount === 0) return used;
    this.db.usage[key] = used + amount;
    await this.changed();
    return this.db.usage[key];
  }
  async releaseUsage(key: string, amount: number): Promise<number> {
    if (!Number.isFinite(amount) || amount < 0) {
      throw new Error("Invalid usage release parameters");
    }
    const used = this.db.usage[key] ?? 0;
    const next = Math.max(0, used - amount);
    if (next === used) return used;
    this.db.usage[key] = next;
    await this.changed();
    return next;
  }
  protected async changed(): Promise<void> {}
}

export class FileRepository extends MemoryRepository {
  private readonly filePath: string;
  private writeQueue = Promise.resolve();

  private constructor(filePath: string, db: Database) {
    super(db);
    this.filePath = filePath;
  }

  static async open(filePath = process.env.DATA_DIR ? `${process.env.DATA_DIR}/ratings.json` : "./data/ratings.json") {
    const absolute = resolve(filePath);
    let db = emptyDatabase();
    try {
      db = JSON.parse(await readFile(absolute, "utf8")) as Database;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new FileRepository(absolute, db);
  }

  protected override async changed(): Promise<void> {
    const snapshot = JSON.stringify(this.db, null, 2);
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      await writeFile(temporary, snapshot, "utf8");
      await rename(temporary, this.filePath);
    });
    await this.writeQueue;
  }
}

export function productKey(domain: string, listingId: string): string {
  return `${domain.toLocaleLowerCase("ru-RU")}:${listingId}`;
}

export function emptyProductMasterCatalog(now = new Date().toISOString()): ProductMasterCatalog {
  return {
    schemaVersion: 2,
    revision: 0,
    brands: [],
    families: [],
    variants: [],
    identifiers: [],
    crosswalks: [],
    aliases: [],
    aggregates: [],
    decisions: [],
    legacyIds: [],
    updatedAt: now
  };
}

export function assertProductMasterRevision(
  catalog: Pick<ProductMasterCatalog, "revision">,
  currentRevision: number,
  expectedRevision: number
): void {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error("Invalid Product Master expected revision");
  }
  if (currentRevision !== expectedRevision) {
    throw new Error(`Product Master revision conflict: expected ${expectedRevision}, current ${currentRevision}`);
  }
  if (catalog.revision !== expectedRevision + 1) {
    throw new Error(`Product Master next revision must be ${expectedRevision + 1}`);
  }
}

export function runHistoryItem(run: RunState): RunHistoryItem {
  const startedAt = run.collectionStartedAt ?? run.createdAt;
  const finishedAt = run.collectionFinishedAt;
  const duration = finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : Number.NaN;
  return {
    id: run.id,
    brands: [...run.request.brands],
    createdAt: run.createdAt,
    collectionStartedAt: startedAt,
    collectionFinishedAt: finishedAt,
    durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null
  };
}

const SUMMARY_ACTIVE_LIMIT = 4;
const SUMMARY_RECENT_LIMIT = 8;

function bounded(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function compactActivity(item: RunActivity): RunActivity {
  return {
    ...item,
    label: bounded(item.label, 160) ?? "",
    domain: bounded(item.domain, 253),
    brand: bounded(item.brand, 160),
    listingId: bounded(item.listingId, 96),
    detail: bounded(item.detail, 240)
  };
}

export function createRunSummaryV2(run: RunState, revision: number): RunSummaryV2 {
  const partitionCounts: RunSummaryV2["partitionCounts"] = {
    pending: Math.max(0, run.progress.totalPartitions - run.partitions.length),
    complete: 0,
    no_results: 0,
    blocked: 0,
    error: 0
  };
  for (const partition of run.partitions) partitionCounts[partition.status] += 1;
  const activity = run.activity ? {
    sequence: run.activity.sequence,
    active: run.activity.active.slice(-SUMMARY_ACTIVE_LIMIT).map(compactActivity),
    recent: run.activity.recent.slice(-SUMMARY_RECENT_LIMIT).map(compactActivity)
  } : undefined;
  return {
    version: 2,
    revision,
    id: run.id,
    ownerEmail: run.ownerEmail,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    collectionStartedAt: run.collectionStartedAt,
    collectionFinishedAt: run.collectionFinishedAt,
    progress: {
      totalPartitions: run.progress.totalPartitions,
      completedPartitions: run.progress.completedPartitions,
      current: bounded(run.progress.current, 500)
    },
    observationCount: run.observations.length,
    partitionCounts,
    errorCount: run.errors.length,
    activity
  };
}

function comparableSummary(summary: RunSummaryV2): Omit<RunSummaryV2, "revision"> {
  const { revision: _revision, ...comparable } = summary;
  return comparable;
}

export function nextRunSummaryV2(run: RunState, previous?: RunSummaryV2): RunSummaryV2 {
  const candidate = createRunSummaryV2(run, previous?.revision ?? 1);
  if (!previous || JSON.stringify(comparableSummary(previous)) === JSON.stringify(comparableSummary(candidate))) {
    return candidate;
  }
  return { ...candidate, revision: previous.revision + 1 };
}

export function runSummaryEtag(summary: Pick<RunSummaryV2, "revision">): string {
  return `"ratings-progress-v2-${summary.revision}"`;
}

export function isRunSummaryUnchanged(
  summary: Pick<RunSummaryV2, "revision">,
  condition: { etag?: string | null; sinceRevision?: string | null }
): boolean {
  if (condition.etag?.split(",").map((value) => value.trim()).includes(runSummaryEtag(summary))) return true;
  const sinceRevision = condition.sinceRevision?.trim();
  return Boolean(sinceRevision && /^\d+$/.test(sinceRevision) && Number(sinceRevision) === summary.revision);
}
