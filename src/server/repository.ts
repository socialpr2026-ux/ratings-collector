import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  Observation,
  ProductRecord,
  PublicationRecord,
  RunState,
  SiteProfile
} from "../shared/types.js";

export type Database = {
  version: 1;
  runs: Record<string, RunState>;
  profiles: Record<string, SiteProfile>;
  products: Record<string, Record<string, ProductRecord>>;
  snapshots: Record<string, Record<string, Record<string, Observation>>>;
  publications: Record<string, PublicationRecord>;
  usage: Record<string, number>;
};

export interface Repository {
  getRun(id: string): Promise<RunState | undefined>;
  saveRun(run: RunState): Promise<void>;
  getProfile(domain: string): Promise<SiteProfile | undefined>;
  saveProfile(profile: SiteProfile): Promise<void>;
  listProducts(spreadsheetId: string): Promise<ProductRecord[]>;
  saveProducts(spreadsheetId: string, records: ProductRecord[]): Promise<void>;
  replaceProducts(spreadsheetId: string, records: ProductRecord[]): Promise<void>;
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
  profiles: {},
  products: {},
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
  async saveRun(run: RunState) { this.db.runs[run.id] = clone(run); await this.changed(); }
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
