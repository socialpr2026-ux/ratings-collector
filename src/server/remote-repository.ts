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
import type { AttemptFence, Repository, RepositoryLease } from "./repository.js";
import type { ProductMasterCatalog } from "../shared/product-master.js";

export type RepositoryRpc =
  | { action: "findRuns"; brand: string; limit?: number }
  | { action: "listRuns"; ownerEmail?: string; limit?: number }
  | { action: "getRun"; id: string }
  | { action: "getRunSummary"; id: string }
  | { action: "getProductMaster" }
  | { action: "saveProductMaster"; catalog: ProductMasterCatalog; expectedRevision: number }
  | { action: "saveRun"; run: RunState; attemptFence?: AttemptFence }
  | { action: "getRunAttempt"; runId: string }
  | { action: "getPartitionCheckpoint"; runId: string; fencingToken: number; domain: string; brand: string }
  | { action: "beginAttempt"; command: BeginAttemptCommand }
  | { action: "commitPartition"; command: CommitPartitionCommand }
  | { action: "finishAttempt"; command: FinishAttemptCommand }
  | { action: "getProfile"; domain: string }
  | { action: "saveProfile"; profile: SiteProfile }
  | { action: "listProducts"; spreadsheetId: string }
  | { action: "saveProducts"; spreadsheetId: string; records: ProductRecord[] }
  | { action: "replaceProducts"; spreadsheetId: string; records: ProductRecord[] }
  | { action: "listSourceCards"; spreadsheetId: string }
  | { action: "saveSourceCards"; spreadsheetId: string; records: SourceCardRecord[] }
  | { action: "getSnapshots"; spreadsheetId: string }
  | { action: "saveSnapshot"; spreadsheetId: string; month: string; observations: Observation[] }
  | { action: "replaceSnapshots"; spreadsheetId: string; snapshots: Record<string, Record<string, Observation>> }
  | { action: "getPublication"; key: string }
  | { action: "savePublication"; key: string; publication: PublicationRecord }
  | { action: "reserveUsage"; key: string; amount: number; limit: number }
  | { action: "releaseUsage"; key: string; amount: number }
  | { action: "acquireLease"; scope: string; leaseMs: number }
  | { action: "renewLease"; lease: RepositoryLease; leaseMs: number }
  | { action: "releaseLease"; lease: RepositoryLease }
  | { action: "putEvidence"; payload: unknown };

const RETRYABLE_ACTIONS = new Set<RepositoryRpc["action"]>([
  "findRuns",
  "listRuns",
  "getRun",
  "getRunSummary",
  "getProductMaster",
  "saveRun",
  "getRunAttempt",
  "getPartitionCheckpoint",
  "commitPartition",
  "getProfile",
  "saveProfile",
  "listProducts",
  "listSourceCards",
  "getSnapshots",
  "getPublication",
  "putEvidence"
]);

const transientStatus = (status: number) => status === 429 || status >= 500;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class RepositoryRpcRejectedError extends Error {}

export class RemoteRepository implements Repository {
  private readonly token: string;
  private attemptFence: AttemptFence | undefined;

  constructor(
    private readonly endpoint: string,
    token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly wait: (ms: number) => Promise<unknown> = delay
  ) {
    this.token = token.trim();
    if (this.token.length < 32) {
      throw new Error("INTERNAL_AGENT_TOKEN не настроен или короче 32 символов");
    }
  }

  async call<T>(request: RepositoryRpc): Promise<T> {
    // A run checkpoint is idempotent and is the employee's recovery boundary.
    // Keep retrying it through a short edge rollout/gateway brownout instead of
    // losing the just-completed partition after only 600 ms of backoff.
    const attempts = request.action === "saveRun" ? 7 : RETRYABLE_ACTIONS.has(request.action) ? 3 : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(30_000)
        });
        const text = await response.text();
        let value: { result?: T; error?: string };
        try {
          value = JSON.parse(text) as typeof value;
        } catch {
          if (attempt < attempts && transientStatus(response.status)) {
            await this.wait(Math.min(4_000, 200 * 2 ** (attempt - 1)));
            continue;
          }
          throw new Error(`Repository RPC HTTP ${response.status}: non-JSON response`);
        }
        if (!response.ok) {
          if (attempt < attempts && transientStatus(response.status)) {
            await this.wait(Math.min(4_000, 200 * 2 ** (attempt - 1)));
            continue;
          }
          throw new RepositoryRpcRejectedError(value.error ?? `Repository RPC HTTP ${response.status}`);
        }
        return value.result as T;
      } catch (error) {
        lastError = error;
        if (attempt >= attempts || error instanceof RepositoryRpcRejectedError ||
          error instanceof Error && /^Repository RPC HTTP \d+:/.test(error.message)) throw error;
        await this.wait(Math.min(4_000, 200 * 2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  getRun(id: string) { return this.call<RunState | undefined>({ action: "getRun", id }); }
  getRunSummary(id: string) { return this.call<RunSummaryV2 | undefined>({ action: "getRunSummary", id }); }
  getProductMaster() { return this.call<ProductMasterCatalog>({ action: "getProductMaster" }); }
  async saveProductMaster(catalog: ProductMasterCatalog, expectedRevision: number) {
    await this.call({ action: "saveProductMaster", catalog, expectedRevision });
  }
  bindRunAttempt(attempt: RunAttempt): void {
    this.attemptFence = { attemptId: attempt.attemptId, fencingToken: attempt.fencingToken };
  }
  clearRunAttempt(): void { this.attemptFence = undefined; }
  async saveRun(run: RunState) {
    await this.call({ action: "saveRun", run, ...(this.attemptFence ? { attemptFence: this.attemptFence } : {}) });
  }
  getRunAttempt(runId: string) { return this.call<RunAttempt | undefined>({ action: "getRunAttempt", runId }); }
  getPartitionCheckpoint(runId: string, fencingToken: number, domain: string, brand: string) {
    return this.call<PartitionCheckpoint | undefined>({
      action: "getPartitionCheckpoint", runId, fencingToken, domain, brand
    });
  }
  beginAttempt(command: BeginAttemptCommand) { return this.call<RunAttempt>({ action: "beginAttempt", command }); }
  commitPartition(command: CommitPartitionCommand) {
    return this.call<PartitionCheckpoint>({ action: "commitPartition", command });
  }
  finishAttempt(command: FinishAttemptCommand) { return this.call<RunAttempt>({ action: "finishAttempt", command }); }
  listRecentRuns(ownerEmail?: string, limit?: number) { return this.call<RunHistoryItem[]>({ action: "listRuns", ownerEmail, limit }); }
  getProfile(domain: string) { return this.call<SiteProfile | undefined>({ action: "getProfile", domain }); }
  async saveProfile(profile: SiteProfile) { await this.call({ action: "saveProfile", profile }); }
  listProducts(spreadsheetId: string) { return this.call<ProductRecord[]>({ action: "listProducts", spreadsheetId }); }
  async saveProducts(spreadsheetId: string, records: ProductRecord[]) { await this.call({ action: "saveProducts", spreadsheetId, records }); }
  async replaceProducts(spreadsheetId: string, records: ProductRecord[]) { await this.call({ action: "replaceProducts", spreadsheetId, records }); }
  listSourceCards(spreadsheetId: string) { return this.call<SourceCardRecord[]>({ action: "listSourceCards", spreadsheetId }); }
  async saveSourceCards(spreadsheetId: string, records: SourceCardRecord[]) { await this.call({ action: "saveSourceCards", spreadsheetId, records }); }
  getSnapshots(spreadsheetId: string) { return this.call<Record<string, Record<string, Observation>>>({ action: "getSnapshots", spreadsheetId }); }
  async saveSnapshot(spreadsheetId: string, month: string, observations: Observation[]) { await this.call({ action: "saveSnapshot", spreadsheetId, month, observations }); }
  async replaceSnapshots(spreadsheetId: string, snapshots: Record<string, Record<string, Observation>>) { await this.call({ action: "replaceSnapshots", spreadsheetId, snapshots }); }
  getPublication(key: string) { return this.call<PublicationRecord | undefined>({ action: "getPublication", key }); }
  async savePublication(key: string, publication: PublicationRecord) { await this.call({ action: "savePublication", key, publication }); }
  reserveUsage(key: string, amount: number, limit: number) { return this.call<number>({ action: "reserveUsage", key, amount, limit }); }
  releaseUsage(key: string, amount: number) { return this.call<number>({ action: "releaseUsage", key, amount }); }
  acquireLease(scope: string, leaseMs: number) { return this.call<RepositoryLease>({ action: "acquireLease", scope, leaseMs }); }
  renewLease(lease: RepositoryLease, leaseMs: number) {
    return this.call<RepositoryLease>({ action: "renewLease", lease, leaseMs });
  }
  async releaseLease(lease: RepositoryLease) { await this.call({ action: "releaseLease", lease }); }
}

export class RemoteEvidenceStore implements EvidenceStore {
  constructor(private readonly repository: RemoteRepository) {}
  async put(payload: unknown): Promise<string> {
    return this.repository.call<string>({ action: "putEvidence", payload });
  }
}
