import type { EvidenceStore } from "./evidence.js";
import type { Observation, ProductRecord, PublicationRecord, RunState, SiteProfile } from "../shared/types.js";
import type { Repository } from "./repository.js";

export type RepositoryRpc =
  | { action: "getRun"; id: string }
  | { action: "saveRun"; run: RunState }
  | { action: "getProfile"; domain: string }
  | { action: "saveProfile"; profile: SiteProfile }
  | { action: "listProducts"; spreadsheetId: string }
  | { action: "saveProducts"; spreadsheetId: string; records: ProductRecord[] }
  | { action: "replaceProducts"; spreadsheetId: string; records: ProductRecord[] }
  | { action: "getSnapshots"; spreadsheetId: string }
  | { action: "saveSnapshot"; spreadsheetId: string; month: string; observations: Observation[] }
  | { action: "replaceSnapshots"; spreadsheetId: string; snapshots: Record<string, Record<string, Observation>> }
  | { action: "getPublication"; key: string }
  | { action: "savePublication"; key: string; publication: PublicationRecord }
  | { action: "reserveUsage"; key: string; amount: number; limit: number }
  | { action: "acquireLease"; scope: string; leaseMs: number }
  | { action: "releaseLease"; lease: { token: string; keys: string[] } }
  | { action: "putEvidence"; payload: unknown };

export class RemoteRepository implements Repository {
  private readonly token: string;

  constructor(private readonly endpoint: string, token: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.token = token.trim();
    if (this.token.length < 32) {
      throw new Error("INTERNAL_AGENT_TOKEN не настроен или короче 32 символов");
    }
  }

  async call<T>(request: RepositoryRpc): Promise<T> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000)
    });
    const value = await response.json() as { result?: T; error?: string };
    if (!response.ok) throw new Error(value.error ?? `Repository RPC HTTP ${response.status}`);
    return value.result as T;
  }

  getRun(id: string) { return this.call<RunState | undefined>({ action: "getRun", id }); }
  async saveRun(run: RunState) { await this.call({ action: "saveRun", run }); }
  getProfile(domain: string) { return this.call<SiteProfile | undefined>({ action: "getProfile", domain }); }
  async saveProfile(profile: SiteProfile) { await this.call({ action: "saveProfile", profile }); }
  listProducts(spreadsheetId: string) { return this.call<ProductRecord[]>({ action: "listProducts", spreadsheetId }); }
  async saveProducts(spreadsheetId: string, records: ProductRecord[]) { await this.call({ action: "saveProducts", spreadsheetId, records }); }
  async replaceProducts(spreadsheetId: string, records: ProductRecord[]) { await this.call({ action: "replaceProducts", spreadsheetId, records }); }
  getSnapshots(spreadsheetId: string) { return this.call<Record<string, Record<string, Observation>>>({ action: "getSnapshots", spreadsheetId }); }
  async saveSnapshot(spreadsheetId: string, month: string, observations: Observation[]) { await this.call({ action: "saveSnapshot", spreadsheetId, month, observations }); }
  async replaceSnapshots(spreadsheetId: string, snapshots: Record<string, Record<string, Observation>>) { await this.call({ action: "replaceSnapshots", spreadsheetId, snapshots }); }
  getPublication(key: string) { return this.call<PublicationRecord | undefined>({ action: "getPublication", key }); }
  async savePublication(key: string, publication: PublicationRecord) { await this.call({ action: "savePublication", key, publication }); }
  reserveUsage(key: string, amount: number, limit: number) { return this.call<number>({ action: "reserveUsage", key, amount, limit }); }
  acquireLease(scope: string, leaseMs: number) { return this.call<{ token: string; keys: string[] }>({ action: "acquireLease", scope, leaseMs }); }
  async releaseLease(lease: { token: string; keys: string[] }) { await this.call({ action: "releaseLease", lease }); }
}

export class RemoteEvidenceStore implements EvidenceStore {
  constructor(private readonly repository: RemoteRepository) {}
  async put(payload: unknown): Promise<string> {
    return this.repository.call<string>({ action: "putEvidence", payload });
  }
}
