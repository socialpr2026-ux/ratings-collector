import type {
  RunActivity,
  RunActivityChannel,
  RunActivityParser,
  RunActivityStage,
  RunActivityStatus,
  RunState
} from "../shared/types.js";

const RECENT_LIMIT = 64;

export type RuntimeSignals = {
  channels?: RunActivityChannel[];
  parsers?: RunActivityParser[];
};

export type StartActivity = {
  stage: RunActivityStage;
  label: string;
  domain?: string;
  brand?: string;
  listingId?: string;
  channels?: RunActivityChannel[];
  parsers?: RunActivityParser[];
  detail?: string;
};

type FinishActivity = RuntimeSignals & {
  detail?: string;
};

function unique<T>(values: readonly T[] | undefined): T[] | undefined {
  if (!values?.length) return undefined;
  return [...new Set(values)];
}

function stringsFrom(value: unknown, target: string[], depth = 0): void {
  if (depth > 4 || target.length >= 80 || value === null || value === undefined) return;
  if (typeof value === "string") {
    target.push(value.toLocaleLowerCase("en-US"));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) stringsFrom(item, target, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      target.push(key.toLocaleLowerCase("en-US"));
      stringsFrom(item, target, depth + 1);
    }
  }
}

/**
 * Extract transport/parser facts only from values returned by a collector.
 * Domain names are deliberately not accepted here: the trace must describe
 * the route that was actually evidenced, not the route normally expected for
 * a platform.
 */
export function runtimeSignals(...evidence: unknown[]): RuntimeSignals {
  const tokens: string[] = [];
  for (const value of evidence) stringsFrom(value, tokens);
  const text = tokens.join(" ");
  const channels: RunActivityChannel[] = [];
  const parsers: RunActivityParser[] = [];

  if (/yandex[-_\s]?translate|translate\.yandex|turbopages/.test(text)) channels.push("yandex_translate");
  else if (/google[-_\s]?translate|translate\.goog|translated/.test(text)) channels.push("google_translate");
  if (/\breader\b|reader[-_\s]?proxy|static[-_\s]?reader/.test(text)) channels.push("reader_proxy");
  if (/\bgateway\b|fixed[-_\s]?proxy|proxy[-_\s]?gateway/.test(text)) channels.push("gateway");
  if (/edgeone[-_\s]?browser|sandbox/.test(text)) channels.push("sandbox", "browser");
  else if (/\bbrowser\b/.test(text)) channels.push("browser");
  if (/historical[-_\s]?registry|previous[-_\s]?registry|\bregistry\b/.test(text)) channels.push("registry");
  if (/first[-_\s]?party[-_\s]?(?:api|json)|composer[-_\s]?api|card[-_\s]?v\d+|search[-_\s]?json/.test(text)) {
    channels.push("first_party_api");
  }
  if (
    !channels.some((channel) => ["google_translate", "yandex_translate", "reader_proxy", "gateway", "sandbox", "browser", "registry"].includes(channel)) &&
    /\bdirect\b|first[-_\s]?party|site[-_\s]?search|data[-_\s]?layer|initial[-_\s]?state|next[-_\s]?data/.test(text)
  ) {
    channels.push("direct");
  }

  if (/json[-_\s]?ld|aggregate[-_\s]?rating/.test(text)) parsers.push("json_ld");
  if (/microdata|\bvisible\b|category[-_\s]?summary|\bdom\b/.test(text)) parsers.push("dom");
  if (/data[-_\s]?layer|initial[-_\s]?state|next[-_\s]?data|embedded[-_\s]?state|reviewinfo/.test(text)) parsers.push("embedded_state");
  if (/composer[-_\s]?api|card[-_\s]?v\d+|search[-_\s]?json|api[-_\s]?json/.test(text)) parsers.push("api_json");

  return { channels: unique(channels), parsers: unique(parsers) };
}

export class RunActivityTracker {
  constructor(
    private readonly run: RunState,
    private readonly now: () => string = () => new Date().toISOString()
  ) {
    const previous = run.activity;
    const interrupted = (previous?.active ?? []).map((item): RunActivity => ({
      ...item,
      status: "warning",
      finishedAt: this.now(),
      detail: item.detail ?? "Предыдущая попытка была прервана"
    }));
    run.activity = {
      sequence: previous?.sequence ?? 0,
      active: [],
      recent: [...(previous?.recent ?? []), ...interrupted].slice(-RECENT_LIMIT)
    };
  }

  start(input: StartActivity): string {
    const trace = this.run.activity!;
    trace.sequence += 1;
    const id = `${this.run.id}:${trace.sequence}`;
    trace.active.push({
      ...input,
      id,
      sequence: trace.sequence,
      status: "active",
      startedAt: this.now(),
      channels: unique(input.channels),
      parsers: unique(input.parsers)
    });
    return id;
  }

  finish(id: string, status: Exclude<RunActivityStatus, "active">, patch: FinishActivity = {}): void {
    const trace = this.run.activity!;
    const index = trace.active.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [active] = trace.active.splice(index, 1);
    trace.recent.push({
      ...active,
      ...patch,
      status,
      finishedAt: this.now(),
      channels: unique([...(active.channels ?? []), ...(patch.channels ?? [])]),
      parsers: unique([...(active.parsers ?? []), ...(patch.parsers ?? [])])
    });
    if (trace.recent.length > RECENT_LIMIT) trace.recent.splice(0, trace.recent.length - RECENT_LIMIT);
  }

  complete(id: string, patch: FinishActivity = {}): void {
    this.finish(id, "complete", patch);
  }

  warn(id: string, patch: FinishActivity = {}): void {
    this.finish(id, "warning", patch);
  }

  instant(input: StartActivity, status: Exclude<RunActivityStatus, "active"> = "complete"): void {
    this.finish(this.start(input), status);
  }
}
