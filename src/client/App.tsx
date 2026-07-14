import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_RUN_PARTITIONS, type Observation, type RunState, type SiteProfile } from "../shared/types.js";
import type { OzonCompanionResult, OzonCompanionSession } from "../shared/companion.js";
import { analyzeProductIdentity } from "../server/utils/product-name.js";
import {
  canConfirmObservation,
  canRetryFailedPartitions,
  finalProductLabel,
  friendlyErrorMessage,
  observationIssueText,
  observationMatchesQuery,
  ozonCompanionEligibleBrands,
  reviewIntroText,
  setupReadinessText,
  summarizeIssues
} from "./review-copy.js";
import {
  CATALOG_DOMAINS,
  SELECTABLE_CATALOG_DOMAINS,
  SITE_CATALOG,
  countCustomDomains,
  parseDomainList,
  updateDomainSelection
} from "./site-catalog.js";

type Config = {
  domains: readonly string[];
  brands: readonly string[];
  googleClientId: string | null;
  authRequired: boolean;
  agentMode?: boolean;
};

type RunPage = RunState & {
  observationPage?: { offset: number; limit: number; total: number };
};

type SavedConfiguration = {
  sheetUrl: string;
  month: string;
  region: string;
  domains: string;
  brands: string;
};

const FORM_STORAGE_KEY = "ratings-last-configuration";
const CONVERSATION_STORAGE_KEY = "ratings-conversation-id";
const LAST_RUN_STORAGE_KEY = "ratings-last-run-id";
const pendingStatuses = new Set<RunState["status"]>(["queued", "running", "publishing"]);
type BusyAction = "resume" | "start" | "retry" | "review" | "profile" | "publish" | "companion";

type CompanionState = {
  status: "idle" | "checking" | "collecting" | "importing" | "unavailable" | "captcha" | "error";
  message?: string;
};

class LocalCompanionError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

const LOCAL_COMPANION_ORIGIN = "http://127.0.0.1:8765";

async function localCompanion<T>(path: string, options: RequestInit = {}, timeoutMs = 4_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${LOCAL_COMPANION_ORIGIN}${path}`, {
      ...options,
      cache: "no-store",
      signal: controller.signal,
      headers: options.body ? { "content-type": "application/json", ...(options.headers ?? {}) } : options.headers
    });
    const payload = await response.json().catch(() => ({})) as { code?: string; error?: string };
    if (!response.ok) throw new LocalCompanionError(payload.code ?? "local_error", payload.error ?? "Локальный сборщик не завершил запрос");
    return payload as T;
  } catch (error) {
    if (error instanceof LocalCompanionError) throw error;
    throw new LocalCompanionError("unavailable", "Локальный сборщик не запущен на этом компьютере");
  } finally {
    clearTimeout(timeout);
  }
}

const runStatusLabels: Record<RunState["status"], string> = {
  queued: "Готовим запуск",
  running: "Собираем данные",
  review: "Нужна проверка",
  publishing: "Записываем в таблицу",
  published: "Таблица обновлена",
  failed: "Сбор остановлен"
};

const observationStatusLabels: Record<Observation["status"], string> = {
  ok: "Готово",
  no_reviews: "Без отзывов / оценок",
  not_found: "Не найдено",
  blocked: "Нет доступа",
  needs_review: "Нужно проверить",
  quota_exceeded: "Лимит исчерпан",
  parser_changed: "Площадка изменилась"
};

const productIdentityLabels = {
  variant: "Точный продукт",
  family: "Агрегат бренда",
  line: "Агрегат линейки",
  unresolved: "Продукт по доступным данным",
  not_product: "Не товар"
} as const;

function uniqueLines(value: string) {
  return [...new Set(value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean))];
}

function isGoogleSheetUrl(value: string) {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "docs.google.com" && url.pathname.startsWith("/spreadsheets/");
  } catch { return false; }
}

function plural(count: number, one: string, few: string, many: string) {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

function readSavedConfiguration(): SavedConfiguration | null {
  try {
    const stored = localStorage.getItem(FORM_STORAGE_KEY);
    return stored ? JSON.parse(stored) as SavedConfiguration : null;
  } catch { return null; }
}

function conversationId() {
  const stored = localStorage.getItem(CONVERSATION_STORAGE_KEY);
  if (stored) return stored;
  const suffix = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "").slice(0, 24)
    : Math.random().toString(36).slice(2, 26);
  const id = `ratings-${suffix}`;
  localStorage.setItem(CONVERSATION_STORAGE_KEY, id);
  return id;
}

function productKey(item: Observation) {
  return `${item.domain}:${item.listingId}`;
}

export function retainValidSelection(selected: Set<string>, validKeys: ReadonlySet<string>): Set<string> {
  const next = new Set([...selected].filter((key) => validKeys.has(key)));
  if (next.size === selected.size && [...next].every((key) => selected.has(key))) return selected;
  return next;
}

export function shouldShowReviewSelectionBar(visibleConfirmableCount: number, selectedCount: number) {
  return visibleConfirmableCount > 0 || selectedCount > 0;
}

type ReviewCountMeaning = SiteProfile["reviewCountMeaning"];

export function canApproveSiteProfile(input: {
  status?: SiteProfile["status"];
  exampleCount: number;
  confirmedExampleCount: number;
  reviewCountMeaning: ReviewCountMeaning;
}) {
  return input.status !== undefined && !["approved", "blocked_free_mode"].includes(input.status)
    && input.exampleCount === 3
    && input.confirmedExampleCount === 3
    && input.reviewCountMeaning !== "unknown";
}

function nextMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return new Date().toISOString().slice(0, 7);
  const next = new Date(Date.UTC(year, month, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatMonth(value: string) {
  const [year, month] = value.split("-").map(Number);
  if (!year || !month) return value;
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" })
    .format(new Date(Date.UTC(year, month - 1, 1)));
}

function formatReviews(value: number | null) {
  return value === null ? "—" : value.toLocaleString("ru-RU");
}

function formatRating(value: number | null) {
  return value === null ? "—" : value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

export function App() {
  const [config, setConfig] = useState<Config>();
  const [savedConfiguration, setSavedConfiguration] = useState<SavedConfiguration | null>(() => readSavedConfiguration());
  const [sheetUrl, setSheetUrl] = useState("");
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [region, setRegion] = useState("Москва");
  const [domains, setDomains] = useState("");
  const [brands, setBrands] = useState("");
  const [run, setRun] = useState<RunState>();
  const [selected, setSelected] = useState(new Set<string>());
  const [profileMeanings, setProfileMeanings] = useState<Record<string, ReviewCountMeaning>>({});
  const [siteProfiles, setSiteProfiles] = useState<Record<string, SiteProfile | null>>({});
  const [confirmedProfileExamples, setConfirmedProfileExamples] = useState<Record<string, string[]>>({});
  const [reviewOnly, setReviewOnly] = useState(true);
  const [listQuery, setListQuery] = useState("");
  const [busyAction, setBusyAction] = useState<BusyAction>();
  const [error, setError] = useState("");
  const [companionState, setCompanionState] = useState<CompanionState>({ status: "idle" });
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/config", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json() as Promise<Config>;
      })
      .then((value) => {
        setConfig(value);
        setDomains((current) => current || value.domains.join("\n"));
        setBrands((current) => current || value.brands.join("\n"));
      })
      .catch((caught) => {
        if ((caught as Error).name !== "AbortError") setError(friendlyErrorMessage(caught, "load"));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const queryRunId = new URLSearchParams(window.location.search).get("runId")?.trim();
    const storedRunId = localStorage.getItem(LAST_RUN_STORAGE_KEY)?.trim();
    const id = queryRunId || storedRunId;
    if (!id || id.length > 160) return;
    let cancelled = false;
    setBusyAction("resume");
    setError("");
    void (async () => {
      try {
        let restored = await fetchRun(id);
        if (cancelled) return;
        if (!queryRunId && restored.status === "published") {
          localStorage.removeItem(LAST_RUN_STORAGE_KEY);
          return;
        }
        setRun(restored);
        setSheetUrl(restored.request.sheetUrl);
        setMonth(restored.request.month);
        setRegion(restored.request.region);
        setDomains(restored.request.domains.join("\n"));
        setBrands(restored.request.brands.join("\n"));
        while (!cancelled && pendingStatuses.has(restored.status)) {
          await new Promise((resolve) => setTimeout(resolve, 2500));
          if (cancelled) return;
          restored = await fetchRun(id);
          if (!cancelled) setRun(restored);
        }
      } catch (caught) {
        if (cancelled) return;
        if (!queryRunId) localStorage.removeItem(LAST_RUN_STORAGE_KEY);
        setError(friendlyErrorMessage(caught, "restore"));
      } finally {
        if (!cancelled) setBusyAction(undefined);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!run) return;
    if (run.status === "published") localStorage.removeItem(LAST_RUN_STORAGE_KEY);
    else localStorage.setItem(LAST_RUN_STORAGE_KEY, run.id);
  }, [run?.id, run?.status]);

  const normalizedDomains = useMemo(() => parseDomainList(domains), [domains]);
  const normalizedBrands = useMemo(() => uniqueLines(brands), [brands]);
  const selectedDomainSet = useMemo(() => new Set(normalizedDomains), [normalizedDomains]);
  const customDomainCount = useMemo(() => countCustomDomains(domains), [domains]);
  const checkCount = normalizedDomains.length * normalizedBrands.length;
  const sheetIsValid = isGoogleSheetUrl(sheetUrl);
  const busy = busyAction !== undefined;
  const formIsReady = Boolean(config)
    && sheetIsValid
    && Boolean(month)
    && region.trim().length >= 2
    && normalizedDomains.length > 0
    && normalizedBrands.length > 0
    && checkCount <= MAX_RUN_PARTITIONS;
  const setupStatus = setupReadinessText({
    configLoaded: Boolean(config),
    sheetProvided: Boolean(sheetUrl.trim()),
    sheetValid: sheetIsValid,
    monthProvided: Boolean(month),
    regionValid: region.trim().length >= 2,
    domainCount: normalizedDomains.length,
    brandCount: normalizedBrands.length,
    checkCount,
    maxChecks: MAX_RUN_PARTITIONS
  });

  function headers() {
    return {
      "content-type": "application/json",
      "makers-conversation-id": conversationId()
    };
  }

  async function api(path: string, options: RequestInit = {}) {
    const response = await fetch(path, { ...options, headers: { ...headers(), ...(options.headers ?? {}) } });
    const contentType = response.headers.get("content-type") ?? "";
    const payload = contentType.includes("application/json")
      ? await response.json() as { error?: string }
      : { error: await response.text() };
    if (!response.ok) throw new Error(payload.error || "Сервис временно недоступен");
    return payload;
  }

  async function fetchRun(id: string): Promise<RunState> {
    const first = await api(`/api/runs/${encodeURIComponent(id)}?offset=0&limit=250`) as RunPage;
    const page = first.observationPage;
    if (!page || page.total <= first.observations.length || pendingStatuses.has(first.status)) return first;
    const pageCount = Math.ceil(page.total / page.limit);
    const offsets = Array.from({ length: pageCount - 1 }, (_, index) => (index + 1) * page.limit);
    const rest = await Promise.all(offsets.map((offset) =>
      api(`/api/runs/${encodeURIComponent(id)}?offset=${offset}&limit=${page.limit}`) as Promise<RunPage>
    ));
    return { ...first, observations: [first.observations, ...rest.map((item) => item.observations)].flat() };
  }

  async function poll(id: string, triggerError?: () => Error | undefined) {
    for (;;) {
      const failure = triggerError?.();
      if (failure) throw failure;
      const next = await fetchRun(id);
      setRun(next);
      if (!pendingStatuses.has(next.status)) return next;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  async function pollRetry(
    id: string,
    previousUpdatedAt: string,
    triggerError: () => Error | undefined,
    triggerFinished: () => boolean
  ) {
    for (;;) {
      const failure = triggerError();
      if (failure) throw failure;
      const next = await fetchRun(id);
      setRun(next);
      const retryHasStarted = next.updatedAt !== previousUpdatedAt || pendingStatuses.has(next.status);
      if (!pendingStatuses.has(next.status) && (retryHasStarted || triggerFinished())) return next;
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  function saveCurrentConfiguration(): SavedConfiguration {
    const value = { sheetUrl: sheetUrl.trim(), month, region: region.trim(), domains, brands };
    localStorage.setItem(FORM_STORAGE_KEY, JSON.stringify(value));
    setSavedConfiguration(value);
    return value;
  }

  async function start(event?: React.FormEvent) {
    event?.preventDefault();
    if (!formIsReady) return;
    setBusyAction("start");
    setError("");
    setRun(undefined);
    setSelected(new Set());
    setSiteProfiles({});
    setConfirmedProfileExamples({});
    setProfileMeanings({});
    setReviewOnly(true);
    setListQuery("");
    setCompanionState({ status: "idle" });
    saveCurrentConfiguration();
    try {
      const created = await api("/api/runs", {
        method: "POST",
        body: JSON.stringify({
          sheetUrl: sheetUrl.trim(),
          month,
          region: region.trim(),
          domains: normalizedDomains,
          brands: normalizedBrands
        })
      }) as RunState;
      setRun(created);
      if (["queued", "running"].includes(created.status)) {
        if (config?.agentMode) {
          await api("/sheet-publisher", {
            method: "POST",
            body: JSON.stringify({ runId: created.id, operation: "preflight" })
          });
        }
        let triggerFailure: Error | undefined;
        const trigger = config?.agentMode
          ? api("/ratings", { method: "POST", body: JSON.stringify({ runId: created.id }) })
            .catch((caught) => { triggerFailure = caught as Error; })
          : Promise.resolve();
        await poll(created.id, () => triggerFailure);
        await trigger;
        if (triggerFailure) throw triggerFailure;
      }
    } catch (caught) {
      setError(friendlyErrorMessage(caught, "start"));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function acceptSelected() {
    if (!run || validSelectedKeys.length === 0) return;
    setBusyAction("review");
    setError("");
    try {
      await api(`/api/runs/${run.id}/review`, {
        method: "POST",
        body: JSON.stringify({ acceptedKeys: validSelectedKeys })
      });
      setRun(await fetchRun(run.id));
      setSelected(new Set());
    } catch (caught) {
      setError(friendlyErrorMessage(caught, "review"));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function retryFailedPartitions() {
    if (!run || !canRetryFailedPartitions(run.status, partitionSummary?.failed ?? 0)) return;
    setBusyAction("retry");
    setError("");
    const previousUpdatedAt = run.updatedAt;
    let triggerFailure: Error | undefined;
    let triggerFinished = false;
    try {
      const trigger = api(
        config?.agentMode ? "/ratings" : `/api/runs/${encodeURIComponent(run.id)}/retry`,
        {
          method: "POST",
          body: config?.agentMode ? JSON.stringify({ runId: run.id }) : "{}"
        }
      )
        .catch((caught) => { triggerFailure = caught as Error; })
        .finally(() => { triggerFinished = true; });
      await pollRetry(run.id, previousUpdatedAt, () => triggerFailure, () => triggerFinished);
      await trigger;
      if (triggerFailure) throw triggerFailure;
      setRun(await fetchRun(run.id));
    } catch (caught) {
      setError(friendlyErrorMessage(caught, "retry"));
      setRun(await fetchRun(run.id).catch(() => run));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function collectOzonOnThisComputer() {
    if (!run) return;
    setBusyAction("companion");
    setError("");
    setCompanionState({ status: "checking" });
    try {
      const health = await localCompanion<{ ok?: boolean; capabilities?: string[] }>("/health");
      if (!health.ok || !health.capabilities?.includes("ozon")) {
        throw new LocalCompanionError("unavailable", "Запущенный локальный помощник не поддерживает Ozon");
      }
      const session = await api(`/api/runs/${encodeURIComponent(run.id)}/companion/ozon/session`, {
        method: "POST", body: "{}"
      }) as OzonCompanionSession;
      setCompanionState({ status: "collecting" });
      const localResult = await localCompanion<OzonCompanionResult>("/v1/ozon/discover", {
        method: "POST",
        body: JSON.stringify({ brands: session.brands, region: run.request.region })
      }, 30 * 60 * 1000);
      setCompanionState({ status: "importing" });
      await api(`/api/runs/${encodeURIComponent(run.id)}/companion/ozon`, {
        method: "POST",
        body: JSON.stringify({ ...localResult, nonce: session.nonce })
      });
      setRun(await fetchRun(run.id));
      setCompanionState({ status: "idle" });
    } catch (caught) {
      if (caught instanceof LocalCompanionError && caught.code === "ozon_challenge") {
        setCompanionState({
          status: "captcha",
          message: "Chrome открыт. Пройдите проверку Ozon вручную, затем нажмите кнопку повторения."
        });
      } else if (caught instanceof LocalCompanionError && caught.code === "unavailable") {
        setCompanionState({
          status: "unavailable",
          message: "Помощник ещё не запущен. Скачайте его кнопкой рядом, откройте файл и оставьте окно помощника открытым."
        });
      } else {
        setCompanionState({ status: "error", message: caught instanceof Error ? caught.message : "Локальный сбор Ozon не завершён" });
      }
    } finally {
      setBusyAction(undefined);
    }
  }

  async function approveSelectedProfiles() {
    if (selectedUnapprovedProfileDomains.length === 0 || !selectedProfilesReady) return;
    setBusyAction("profile");
    setError("");
    try {
      for (const domain of selectedUnapprovedProfileDomains) {
        const profile = siteProfiles[domain];
        if (!profile) throw new Error(`Не удалось загрузить профиль площадки ${domain}`);
        const confirmed = new Set(confirmedProfileExamples[domain] ?? []);
        const examples = profile.testExamples.filter((example) => confirmed.has(example.url));
        const approved = await api(`/api/site-profiles/${encodeURIComponent(domain)}/approve`, {
          method: "POST",
          body: JSON.stringify({ examples, reviewCountMeaning: profileMeanings[domain] ?? "unknown" })
        }) as SiteProfile;
        setSiteProfiles((current) => ({ ...current, [domain]: approved }));
      }
    } catch (caught) {
      setError(friendlyErrorMessage(caught, "profile"));
    } finally {
      setBusyAction(undefined);
    }
  }

  async function publish() {
    if (!run) return;
    setBusyAction("publish");
    setError("");
    try {
      const intent = await api(`/api/runs/${run.id}/publish`, { method: "POST", body: "{}" }) as RunState;
      setRun(intent);
      if (intent.status === "publishing") {
        if (!config?.agentMode) throw new Error("Запись в таблицу пока доступна только в облачной версии сервиса");
        let triggerFailure: Error | undefined;
        const trigger = api("/sheet-publisher", {
          method: "POST",
          body: JSON.stringify({ runId: run.id, operation: "publish" })
        }).catch((caught) => { triggerFailure = caught as Error; });
        await poll(run.id, () => triggerFailure);
        await trigger;
        if (triggerFailure) throw triggerFailure;
      }
      setRun(await fetchRun(run.id));
    } catch (caught) {
      setError(friendlyErrorMessage(caught, "publish"));
      setRun(await fetchRun(run.id).catch(() => run));
    } finally {
      setBusyAction(undefined);
    }
  }

  function useSavedConfiguration() {
    if (!savedConfiguration) return;
    setSheetUrl(savedConfiguration.sheetUrl);
    setMonth(savedConfiguration.month);
    setRegion(savedConfiguration.region);
    setDomains(savedConfiguration.domains);
    setBrands(savedConfiguration.brands);
    setRun(undefined);
    setSelected(new Set());
    setSiteProfiles({});
    setConfirmedProfileExamples({});
    setProfileMeanings({});
    setListQuery("");
    setCompanionState({ status: "idle" });
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function prepareNextMonth() {
    if (!run) return;
    setSheetUrl(run.request.sheetUrl);
    setMonth(nextMonth(run.request.month));
    setRegion(run.request.region);
    setDomains(run.request.domains.join("\n"));
    setBrands(run.request.brands.join("\n"));
    setRun(undefined);
    setSelected(new Set());
    setSiteProfiles({});
    setConfirmedProfileExamples({});
    setProfileMeanings({});
    setListQuery("");
    setCompanionState({ status: "idle" });
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  const reviewItems = run?.observations.filter((item) => item.status === "needs_review") ?? [];
  const confirmableReviewItems = reviewItems.filter(canConfirmObservation);
  const unfilteredItems = run ? (reviewOnly && reviewItems.length ? reviewItems : run.observations) : [];
  const normalizedListQuery = listQuery.trim();
  const visibleItems = normalizedListQuery ? unfilteredItems.filter((item) => observationMatchesQuery(item, normalizedListQuery)) : unfilteredItems;
  const canonicalProducts = useMemo(() => {
    const items = run?.observations ?? [];
    const labels = items.map((item) => finalProductLabel(item.productIdentity?.label ?? analyzeProductIdentity({
      brand: item.brand,
      product: item.product,
      url: item.canonicalUrl,
      evidence: item.productEvidence
    }).label, item.product));
    return new Map(items.map((item, index) => [productKey(item), labels[index]]));
  }, [run?.observations]);
  const publicationSummary = useMemo(() => {
    const items = run?.observations.filter((item) => ["ok", "no_reviews"].includes(item.status)) ?? [];
    return {
      cards: items.length,
      brands: new Set(items.map((item) => item.brand)).size,
      domains: new Set(items.map((item) => item.domain)).size
    };
  }, [run?.observations]);
  const newDomains = [...new Set(reviewItems.filter((item) => item.profileVersion !== undefined).map((item) => item.domain))];
  const visibleConfirmableReviewItems = visibleItems.filter((item) => item.status === "needs_review" && canConfirmObservation(item));
  const confirmableReviewKeySignature = confirmableReviewItems.map(productKey).sort().join("\n");
  const confirmableReviewKeys = useMemo(
    () => new Set(confirmableReviewItems.map(productKey)),
    [confirmableReviewKeySignature]
  );
  const validSelectedKeys = [...selected].filter((key) => confirmableReviewKeys.has(key));
  const selectedCount = validSelectedKeys.length;
  const validSelectedKeySet = new Set(validSelectedKeys);
  const selectedProfileDomains = [...new Set(confirmableReviewItems
    .filter((item) => item.profileVersion !== undefined && validSelectedKeySet.has(productKey(item)))
    .map((item) => item.domain))];
  const selectedUnapprovedProfileDomains = selectedProfileDomains
    .filter((domain) => siteProfiles[domain]?.status !== "approved");
  const selectedProfilesReady = selectedUnapprovedProfileDomains.length > 0 && selectedUnapprovedProfileDomains.every((domain) => {
    const profile = siteProfiles[domain];
    const confirmed = new Set(confirmedProfileExamples[domain] ?? []);
    return canApproveSiteProfile({
      status: profile?.status,
      exampleCount: profile?.testExamples.length ?? 0,
      confirmedExampleCount: profile?.testExamples.filter((example) => confirmed.has(example.url)).length ?? 0,
      reviewCountMeaning: profileMeanings[domain] ?? "unknown"
    });
  });
  const allReviewSelected = visibleConfirmableReviewItems.length > 0 && visibleConfirmableReviewItems.every((item) => selected.has(productKey(item)));
  const partitionSummary = useMemo(() => run ? {
    complete: run.partitions.filter((item) => item.status === "complete").length,
    empty: run.partitions.filter((item) => item.status === "no_results").length,
    failed: run.partitions.filter((item) => !["complete", "no_results"].includes(item.status)).length
  } : undefined, [run]);
  const canRetry = Boolean(run && canRetryFailedPartitions(run.status, partitionSummary?.failed ?? 0));
  const companionBrands = useMemo(() => run ? ozonCompanionEligibleBrands(run) : [], [run]);
  const visibleBlockers = summarizeIssues(run?.qa?.blockers ?? []);
  const visibleWarnings = summarizeIssues(run?.qa?.warnings ?? []);
  const progress = run
    ? Math.round(100 * run.progress.completedPartitions / Math.max(1, run.progress.totalPartitions))
    : 0;
  const currentStep = !run
    ? 1
    : ["queued", "running"].includes(run.status)
      ? 2
      : ["publishing", "published"].includes(run.status)
        ? 4
        : 3;

  useEffect(() => {
    if (!run || pendingStatuses.has(run.status)) return;
    setSelected((current) => retainValidSelection(current, confirmableReviewKeys));
  }, [run?.id, run?.updatedAt, run?.status, confirmableReviewKeys]);

  const profileDomainSignature = newDomains.slice().sort().join("\n");
  useEffect(() => {
    if (!run || pendingStatuses.has(run.status) || newDomains.length === 0) return;
    let cancelled = false;
    void Promise.all(newDomains.map(async (domain) => {
      try {
        return [domain, await api(`/api/site-profiles/${encodeURIComponent(domain)}`) as SiteProfile] as const;
      } catch {
        return [domain, null] as const;
      }
    })).then((entries) => {
      if (!cancelled) setSiteProfiles((current) => ({ ...current, ...Object.fromEntries(entries) }));
    });
    return () => { cancelled = true; };
  }, [run?.id, run?.status, profileDomainSignature]);

  function profileApprovalHint(domain: string) {
    const profile = siteProfiles[domain];
    if (profile === undefined) return "Загружаем контрольные карточки…";
    if (profile === null) return "Не удалось загрузить профиль площадки. Обновите страницу и повторите.";
    if (profile.status === "blocked_free_mode") return "Площадка не допускает бесплатную автоматическую проверку профиля.";
    if (profile.testExamples.length !== 3) return `Профиль подготовил ${profile.testExamples.length} из 3 контрольных карточек — подтверждение пока недоступно.`;
    const confirmed = new Set(confirmedProfileExamples[domain] ?? []);
    const confirmedCount = profile.testExamples.filter((example) => confirmed.has(example.url)).length;
    if (confirmedCount !== 3) return `Откройте и отметьте все три контрольные карточки (${confirmedCount}/3).`;
    if ((profileMeanings[domain] ?? "unknown") === "unknown") return "Укажите, что площадка включает в общий счётчик.";
    return "Контрольные карточки и смысл счётчика проверены.";
  }

  function toggleAllReview() {
    setSelected((current) => {
      const next = new Set(current);
      if (allReviewSelected) visibleConfirmableReviewItems.forEach((item) => next.delete(productKey(item)));
      else visibleConfirmableReviewItems.forEach((item) => next.add(productKey(item)));
      return next;
    });
  }

  function setPresetSites(targetDomains: readonly string[], selected: boolean) {
    setDomains((current) => updateDomainSelection(current, targetDomains, selected));
  }

  return <div className="app-shell">
    <a className="skip-link" href="#setup">Перейти к настройке</a>
    <header className="topbar">
      <a className="logo" href="#top" aria-label="Сбор рейтингов — в начало">
        <span className="logo-mark" aria-hidden="true">Р</span>
        <span><strong>Сбор рейтингов</strong><small>Ежемесячное обновление таблицы</small></span>
      </a>
      <div className="access-note"><span aria-hidden="true">●</span> Без Google API-ключей</div>
    </header>

    <main id="top" aria-busy={busy}>
      <section className="intro" aria-labelledby="page-title">
        <div>
          <p className="eyebrow">Отзывы, оценки и рейтинги с площадок</p>
          <h1 id="page-title">Соберите рейтинги<br />и обновите таблицу</h1>
          <p className="intro-copy">Выберите площадки и бренды. Сервис найдёт карточки, покажет спорные результаты и запишет только проверенные данные.</p>
          <ul className="intro-benefits" aria-label="Преимущества сервиса">
            <li>Без ключей Google</li>
            <li>Проверка до записи</li>
            <li>История по месяцам</li>
          </ul>
        </div>
        <ol className="workflow" aria-label="Этапы работы">
          <li className={currentStep >= 1 ? "active" : ""} aria-current={currentStep === 1 ? "step" : undefined}><span>1</span><div><strong>Настройка</strong><small>Таблица, месяц и список</small></div></li>
          <li className={currentStep >= 2 ? "active" : ""} aria-current={currentStep === 2 ? "step" : undefined}><span>2</span><div><strong>Сбор</strong><small>Поиск карточек и данных</small></div></li>
          <li className={currentStep >= 3 ? "active" : ""} aria-current={currentStep === 3 ? "step" : undefined}><span>3</span><div><strong>Проверка</strong><small>Только спорные находки</small></div></li>
          <li className={currentStep >= 4 ? "active" : ""} aria-current={currentStep === 4 ? "step" : undefined}><span>4</span><div><strong>Готово</strong><small>Запись в исходный лист</small></div></li>
        </ol>
      </section>

      {config?.authRequired && <section className="notice notice-error" role="alert">
        <span className="notice-icon" aria-hidden="true">!</span>
        <div><strong>Единый доступ ещё не включён</strong><p>Попросите администратора открыть сервис без входа, затем обновите эту страницу.</p></div>
      </section>}

      <form id="setup" className="card setup-card" onSubmit={start} ref={formRef} noValidate>
        <div className="card-heading">
          <div><p className="section-number">Шаг 1</p><h2>Настройте сбор</h2><p>Укажите таблицу, затем выберите площадки и бренды.</p></div>
          {savedConfiguration && <button className="text-button" type="button" onClick={useSavedConfiguration}>Заполнить как в прошлый раз</button>}
        </div>

        <div className="sheet-field">
          <div className="field-heading">
            <label htmlFor="sheet-url">Google Таблица для записи</label>
            <a className="create-sheet-link" href="https://sheets.new" target="_blank" rel="noreferrer">Создать новую <span aria-hidden="true">↗</span></a>
          </div>
          <div className={`input-with-icon ${sheetUrl && !sheetIsValid ? "invalid" : ""}`}>
            <span aria-hidden="true">▦</span>
            <input
              id="sheet-url"
              type="url"
              inputMode="url"
              autoComplete="url"
              value={sheetUrl}
              onChange={(event) => setSheetUrl(event.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              aria-describedby="sheet-help"
              aria-invalid={Boolean(sheetUrl && !sheetIsValid)}
              required
            />
          </div>
          <p id="sheet-help" className={sheetUrl && !sheetIsValid ? "field-help field-error" : "field-help"}>
            {sheetUrl && !sheetIsValid ? "Вставьте ссылку вида docs.google.com/spreadsheets/…" : "В таблице включите «Доступ по ссылке → Редактор», затем вставьте ссылку. Новая таблица создаётся в вашем Google-аккаунте."}
          </p>
          <details className="sheet-guide">
            <summary>Как подготовить новую таблицу</summary>
            <ol><li>Нажмите «Создать новую» и дождитесь открытия Google Таблиц.</li><li>Включите общий доступ по ссылке с ролью «Редактор».</li><li>Скопируйте адрес таблицы и вставьте его выше.</li></ol>
          </details>
        </div>

        <div className="compact-grid">
          <label><span>Месяц отчёта</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} required /></label>
          <label><span>Регион</span><input value={region} onChange={(event) => setRegion(event.target.value)} placeholder="Москва" required /></label>
        </div>

        <div className="setup-lists">
          <section className="site-picker" aria-labelledby="sites-title">
            <div className="picker-heading">
              <div><span className="label-row"><span id="sites-title">Площадки</span><small>{normalizedDomains.length}</small></span><p>Выберите готовые варианты или добавьте свои.</p></div>
              <div className="picker-actions">
                <button type="button" onClick={() => setPresetSites(SELECTABLE_CATALOG_DOMAINS, true)} disabled={SELECTABLE_CATALOG_DOMAINS.every((domain) => selectedDomainSet.has(domain))}>Выбрать все доступные</button>
                <button type="button" onClick={() => setDomains("")} disabled={normalizedDomains.length === 0}>Очистить</button>
              </div>
            </div>

            <div className="site-groups">
              {SITE_CATALOG.map((group) => {
                const groupDomains = group.sites.filter((site) => site.availability !== "temporarily_blocked").map((site) => site.domain);
                const selectedCount = groupDomains.filter((domain) => selectedDomainSet.has(domain)).length;
                const allSelected = selectedCount === groupDomains.length;
                return <div className="site-group" key={group.id}>
                  <div className="site-group-heading">
                    <div><h3>{group.label}</h3><p>{group.description}</p></div>
                    <button type="button" onClick={() => setPresetSites(groupDomains, !allSelected)} aria-label={`${allSelected ? "Снять выбор" : "Выбрать все"}: ${group.label}`}>{allSelected ? "Снять" : `Все · ${selectedCount}/${groupDomains.length}`}</button>
                  </div>
                  <div className="site-options">
                    {group.sites.map((site) => {
                      const checked = selectedDomainSet.has(site.domain);
                      const blocked = site.availability === "temporarily_blocked";
                      return <label className={`site-option ${checked ? "selected" : ""} ${blocked ? "unavailable" : ""}`} key={site.domain} title={site.note}>
                        <input type="checkbox" checked={checked} disabled={blocked} onChange={(event) => setPresetSites([site.domain], event.target.checked)} />
                        <span><strong>{site.label}</strong><small>{blocked ? "Временно недоступно" : site.domain}</small></span>
                      </label>;
                    })}
                  </div>
                </div>;
              })}
            </div>

            <details className="manual-domains">
              <summary><span>Добавить домены списком</span>{customDomainCount > 0 && <small>{customDomainCount} своих</small>}</summary>
              <label htmlFor="domains-list">Все выбранные домены</label>
              <textarea id="domains-list" value={domains} onChange={(event) => setDomains(event.target.value)} rows={5} spellCheck={false} placeholder={"example.ru\nanother-site.ru"} required />
              <small className="field-help">По одному домену в строке — без ссылок на товары. Готовый выбор выше обновится автоматически.</small>
            </details>
          </section>

          <label className="brand-field">
            <span className="label-row"><span>Бренды</span><small>{normalizedBrands.length}</small></span>
            <textarea value={brands} onChange={(event) => setBrands(event.target.value)} rows={12} placeholder={"Кагоцел\nАрбидол\nИнгавирин"} required />
            <small className="field-help">По одному бренду в строке. Повторы будут убраны автоматически.</small>
            <span className="brand-hint"><span aria-hidden="true">✓</span><span>Название бренда и уточнение продукта будут записаны в разные столбцы.</span></span>
          </label>
        </div>

        <div className="setup-footer">
          <div className={checkCount > MAX_RUN_PARTITIONS || Boolean(sheetUrl && !sheetIsValid) ? "run-summary limit" : "run-summary"} aria-live="polite">
            <strong>{checkCount.toLocaleString("ru-RU")}</strong>
            <span id="setup-status">{setupStatus}</span>
          </div>
          <button className="button button-primary button-large" type="submit" disabled={!formIsReady || busy || config?.authRequired} aria-describedby="setup-status">
            <span>{busyAction === "resume" ? "Восстанавливаем…" : busyAction === "start" ? "Собираем данные…" : "Запустить сбор"}</span><span aria-hidden="true">→</span>
          </button>
        </div>
      </form>

      {(busy || run) && <section className={`card progress-card ${run && pendingStatuses.has(run.status) ? "progress-active" : ""}`} aria-labelledby="progress-title" aria-live="polite" aria-busy={Boolean(run && pendingStatuses.has(run.status))}>
        <div className="card-heading compact">
          <div><p className="section-number">Шаг 2</p><h2 id="progress-title">{busyAction === "resume" ? "Восстанавливаем последний запуск" : busyAction === "retry" ? "Повторяем неуспешные площадки" : run ? runStatusLabels[run.status] : "Создаём запуск"}</h2><p>{busyAction === "resume" ? "Загружаем сохранённый результат и актуальный статус площадок." : busyAction === "retry" ? (run?.progress.current ? `Повторная проверка: ${run.progress.current}` : "Уже собранные данные сохранены. Обновляем только площадки с ошибками.") : run?.progress.current ? `Сейчас проверяем: ${run.progress.current}` : pendingStatuses.has(run?.status ?? "queued") ? "Можно перейти в другую вкладку — этот экран обновится автоматически." : "Сбор завершён. Ниже можно проверить результат."}</p></div>
          <div className="progress-value"><strong>{run ? `${progress}%` : "…"}</strong><small>{run ? `${run.progress.completedPartitions} из ${run.progress.totalPartitions}` : "подготовка"}</small></div>
        </div>
        <div className="progress-track" role="progressbar" aria-label="Ход сбора" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span style={{ width: `${progress}%` }} />
        </div>
        {run && <div className="metrics">
          <article><strong>{run.observations.length.toLocaleString("ru-RU")}</strong><span>карточек найдено</span></article>
          <article><strong>{partitionSummary?.complete ?? 0}</strong><span>проверок завершено</span></article>
          <article><strong>{partitionSummary?.empty ?? 0}</strong><span>ничего не найдено</span></article>
          <article className={(partitionSummary?.failed ?? 0) > 0 ? "metric-warning" : ""}><strong>{partitionSummary?.failed ?? 0}</strong><span>требуют внимания</span></article>
        </div>}
      </section>}

      {run && !pendingStatuses.has(run.status) && <section className="card review-card" aria-labelledby="review-title">
        <div className="card-heading review-heading">
          <div><p className="section-number">Шаг 3</p><h2 id="review-title">Проверьте спорные находки</h2><p>{reviewIntroText(reviewItems.length, partitionSummary?.failed ?? 0)}</p></div>
          <div className="view-switch" role="group" aria-label="Какие карточки показывать">
            <button type="button" className={reviewOnly && reviewItems.length ? "active" : ""} aria-pressed={Boolean(reviewOnly && reviewItems.length)} onClick={() => setReviewOnly(true)} disabled={!reviewItems.length}>Требуют проверки <span>{reviewItems.length}</span></button>
            <button type="button" className={!reviewOnly || !reviewItems.length ? "active" : ""} aria-pressed={!reviewOnly || !reviewItems.length} onClick={() => setReviewOnly(false)}>Все <span>{run.observations.length}</span></button>
          </div>
        </div>

        {(partitionSummary?.failed ?? 0) > 0 && <div className="collection-warning" role="status">
          <span className="notice-icon" aria-hidden="true">!</span>
          <div><strong>{busyAction === "retry" ? "Повторно проверяем проблемные площадки…" : "Сбор неполный — публикация отключена"}</strong><p>{busyAction === "retry" ? "Готовые результаты остаются на месте. После завершения список и проверка публикации обновятся автоматически." : "Данные не будут записаны частично. Можно повторить только неуспешные площадки, не запуская весь сбор заново."}</p></div>
          <div className="collection-warning-actions">
            {canRetry && <button className="button button-secondary" type="button" onClick={retryFailedPartitions} disabled={busy}>{busyAction === "retry" ? "Повторяем…" : "Повторить неуспешные площадки"}</button>}
            <a className="button button-quiet" href="#publish-status">Посмотреть причины</a>
          </div>
        </div>}

        {companionBrands.length > 0 && <div className="companion-card" role="region" aria-label="Резервный сбор Ozon через Chrome">
          <span className="companion-icon" aria-hidden="true">◉</span>
          <div className="companion-copy">
            <strong>Ozon можно собрать через Chrome на этом компьютере</strong>
            <p>{companionState.message ?? `Облачный сбор не завершился для ${companionBrands.length} ${plural(companionBrands.length, "бренда", "брендов", "брендов")}. Локальный помощник использует обычное подключение этого компьютера и вернёт только карточки, отзывы / оценки и рейтинг.`}</p>
            <small>{companionState.status === "unavailable"
              ? "Откройте скачанный файл, оставьте его окно открытым и нажмите «Проверить после запуска»."
              : "При первом использовании скачайте и запустите помощник один раз; Google‑ключ и Apify не используются."}</small>
          </div>
          <div className="companion-actions">
            <a className="button button-quiet" href="/ratings-ozon-helper.cmd" download>Скачать помощник</a>
            <button className="button button-secondary" type="button" onClick={collectOzonOnThisComputer} disabled={busy}>
              {busyAction === "companion"
                ? companionState.status === "importing" ? "Добавляем в запуск…" : companionState.status === "collecting" ? "Собираем Ozon…" : "Проверяем помощник…"
                : companionState.status === "captcha" ? "Я прошёл проверку — повторить"
                  : companionState.status === "unavailable" ? "Проверить после запуска" : "Проверить и собрать"}
            </button>
          </div>
        </div>}

        {run.observations.length > 8 && <div className="list-filter" role="search" aria-label="Фильтр найденных карточек">
          <div className="list-filter-field">
            <span aria-hidden="true">⌕</span>
            <input type="search" value={listQuery} onChange={(event) => setListQuery(event.target.value)} placeholder="Найти бренд, продукт, площадку или ID" aria-label="Поиск по найденным карточкам" />
            {listQuery && <button type="button" onClick={() => setListQuery("")} aria-label="Очистить поиск">×</button>}
          </div>
          <span>Показано {visibleItems.length} из {unfilteredItems.length}</span>
        </div>}

        {shouldShowReviewSelectionBar(visibleConfirmableReviewItems.length, selectedCount) && <div className={`selection-bar ${selectedUnapprovedProfileDomains.length > 0 ? "selection-bar-profile" : ""}`} role="region" aria-label="Подтверждение выбранных карточек">
          <div className="selection-bar-top">
            <label><input type="checkbox" checked={allReviewSelected} onChange={toggleAllReview} disabled={visibleConfirmableReviewItems.length === 0} /> <span>Выбрать все показанные</span></label>
            <div className="selection-actions">
              <span aria-live="polite">Выбрано: {selectedCount}</span>
              {selectedUnapprovedProfileDomains.length === 0 && <button className="button button-secondary button-compact" type="button" onClick={acceptSelected} disabled={selectedCount === 0 || busy}>{busyAction === "review" ? "Сохраняем…" : `Подтвердить выбранные · ${selectedCount}`}</button>}
            </div>
          </div>

          {selectedUnapprovedProfileDomains.length > 0 && <div className="profile-gate">
            <div className="profile-gate-intro"><strong>Сначала проверьте правила новых площадок</strong><p>Это обязательный одноразовый шаг: откройте три контрольные карточки каждой площадки, отметьте их и укажите смысл счётчика. Выбранные {selectedCount} карточек останутся отмеченными.</p></div>
            {selectedUnapprovedProfileDomains.map((domain) => {
              const profile = siteProfiles[domain];
              const confirmed = new Set(confirmedProfileExamples[domain] ?? []);
              return <div className="profile-gate-domain" key={domain}>
                <div className="profile-gate-heading"><strong>{domain}</strong><span>{profileApprovalHint(domain)}</span></div>
                {profile && <>
                  <div className="control-examples" aria-label={`Контрольные карточки ${domain}`}>
                    {profile.testExamples.map((example, index) => <label key={example.url}>
                      <input type="checkbox" checked={confirmed.has(example.url)} onChange={(event) => setConfirmedProfileExamples((current) => {
                        const next = new Set(current[domain] ?? []);
                        event.target.checked ? next.add(example.url) : next.delete(example.url);
                        return { ...current, [domain]: [...next] };
                      })} />
                      <a href={example.url} target="_blank" rel="noreferrer">Карточка {index + 1}<span aria-hidden="true">↗</span></a>
                    </label>)}
                  </div>
                  <label className="profile-meaning"><span>Что площадка включает в общий счётчик?</span><select value={profileMeanings[domain] ?? "unknown"} onChange={(event) => setProfileMeanings((current) => ({ ...current, [domain]: event.target.value as ReviewCountMeaning }))}>
                    <option value="unknown">Выберите вариант</option>
                    <option value="reviews">Отзывы</option>
                    <option value="ratings">Оценки / голоса</option>
                    <option value="feedback">Отзывы и оценки</option>
                  </select></label>
                </>}
              </div>;
            })}
            <div className="profile-gate-action">
              <span>После сохранения останется подтвердить выбранные карточки.</span>
              <button className="button button-secondary button-compact" type="button" onClick={approveSelectedProfiles} disabled={!selectedProfilesReady || busy}>{busyAction === "profile" ? "Сохраняем правила…" : `Сохранить правила · ${selectedUnapprovedProfileDomains.length}`}</button>
            </div>
          </div>}
        </div>}

        <div className="table-wrap" tabIndex={0} aria-label="Список найденных карточек">
          <table>
            <thead><tr><th scope="col" className="check-column"><span className="sr-only">Выбор</span></th><th scope="col">Площадка</th><th scope="col">Бренд</th><th scope="col">Продукт в таблице</th><th scope="col">Отзывы / оценки</th><th scope="col">Рейтинг</th><th scope="col">Результат</th></tr></thead>
            <tbody>
              {visibleItems.map((item) => {
                const confirmable = canConfirmObservation(item);
                const canonicalProduct = canonicalProducts.get(productKey(item)) ?? item.product;
                const identity = item.productIdentity ?? analyzeProductIdentity({ brand: item.brand, product: item.product, url: item.canonicalUrl, evidence: item.productEvidence });
                return <tr key={productKey(item)} className={item.status === "needs_review" ? "row-review" : ""}>
                  <td className={`check-column ${item.status !== "needs_review" ? "check-empty" : ""}`} data-label="Выбрать">{item.status === "needs_review" && (confirmable
                    ? <input aria-label={`Подтвердить карточку ${item.product}`} type="checkbox" checked={selected.has(productKey(item))} onChange={(event) => setSelected((current) => { const next = new Set(current); event.target.checked ? next.add(productKey(item)) : next.delete(productKey(item)); return next; })} />
                    : <span className="check-unavailable" aria-label="Карточку нельзя подтвердить без полных метрик">—</span>)}</td>
                  <td data-label="Площадка"><span className="domain-name">{item.domain}</span></td>
                  <td className="brand-cell" data-label="Бренд"><strong>{item.brand}</strong></td>
                  <td className="product-cell" data-label="Продукт"><a href={item.canonicalUrl} target="_blank" rel="noreferrer" aria-label={`Открыть карточку «${item.product}» на ${item.domain} в новой вкладке`}>{canonicalProduct}<span aria-hidden="true">↗</span></a><div className={`identity-badge identity-${identity.granularity}`}>{productIdentityLabels[identity.granularity]}</div><small>Название на площадке: {item.product} · ID {item.listingId}</small>{(identity.reasons.length > 0 || (item.productEvidence?.variants.length ?? 0) > 0) && <details className="product-proof"><summary>На основании каких данных</summary>{identity.reasons.map((reason) => <p key={reason}>{reason}</p>)}{(item.productEvidence?.variants.length ?? 0) > 0 && <ul>{item.productEvidence!.variants.slice(0, 6).map((variant) => <li key={variant}>{variant}</li>)}</ul>}</details>}</td>
                  <td className="number-cell" data-label="Отзывы / оценки">{formatReviews(item.reviews)}</td>
                  <td className="number-cell" data-label="Рейтинг">{formatRating(item.rating)}</td>
                  <td data-label="Результат"><span className={`result-badge result-${item.status}`}>{observationStatusLabels[item.status]}</span>{item.status === "needs_review" && !confirmable && <small className={`result-note ${identity.granularity === "not_product" ? "result-note-error" : ""}`}>{observationIssueText(item)}</small>}</td>
                </tr>;
              })}
              {visibleItems.length === 0 && <tr><td colSpan={7} className="empty-state"><strong>{normalizedListQuery ? "По вашему запросу ничего нет" : "Карточки не найдены"}</strong><span>{normalizedListQuery ? "Измените запрос или очистите поиск." : "Проверьте площадки и бренды, затем повторите запуск."}</span></td></tr>}
            </tbody>
          </table>
        </div>

      </section>}

      {run?.qa && <section id="publish-status" className={`card publish-card ${run.qa.ok ? "publish-ready" : "publish-blocked"}`} aria-labelledby="publish-title">
        <div className="publish-summary">
          <span className="publish-icon" aria-hidden="true">{run.qa.ok ? "✓" : "!"}</span>
          <div><p className="section-number">Шаг 4</p><h2 id="publish-title">{run.status === "published" ? "Готово — таблица обновлена" : run.qa.ok ? "Всё готово к записи" : "Сначала устраните замечания"}</h2><p>{run.status === "published" ? `Данные за ${formatMonth(run.request.month)} сохранены в исходном листе: ${publicationSummary.cards} ${plural(publicationSummary.cards, "карточка", "карточки", "карточек")}, ${publicationSummary.brands} ${plural(publicationSummary.brands, "бренд", "бренда", "брендов")}, ${publicationSummary.domains} ${plural(publicationSummary.domains, "площадка", "площадки", "площадок")}.` : run.qa.ok ? `Будет записано: ${publicationSummary.cards} ${plural(publicationSummary.cards, "карточка", "карточки", "карточек")}, ${publicationSummary.brands} ${plural(publicationSummary.brands, "бренд", "бренда", "брендов")}, ${publicationSummary.domains} ${plural(publicationSummary.domains, "площадка", "площадки", "площадок")} за ${formatMonth(run.request.month)} Столбцы: Бренд · Ссылка · Продукт · Отзывы / оценки · Рейтинг.` : "Разберите отмеченные карточки или повторите проблемные площадки. Частичный результат в таблицу не попадёт."}</p></div>
        </div>

        {visibleBlockers.length > 0 && <div className="issue-list"><strong>Что нужно исправить</strong><ul>{visibleBlockers.map((item) => <li key={item}>{item}</li>)}</ul></div>}
        {visibleWarnings.length > 0 && <details className="warning-details"><summary>Есть замечания ({visibleWarnings.length})</summary><ul>{visibleWarnings.map((item) => <li key={item}>{item}</li>)}</ul></details>}

        <div className="publish-actions">
          <a className="button button-quiet" href={run.request.sheetUrl} target="_blank" rel="noreferrer" aria-label="Открыть исходную Google Таблицу в новой вкладке">Открыть таблицу <span aria-hidden="true">↗</span></a>
          {run.status === "published"
            ? <button className="button button-primary" type="button" onClick={prepareNextMonth}>Подготовить следующий месяц <span aria-hidden="true">→</span></button>
            : <button className="button button-primary" type="button" disabled={!run.qa.ok || busy || run.status === "failed"} onClick={publish}>{busyAction === "publish" ? "Записываем…" : "Записать в таблицу"} <span aria-hidden="true">→</span></button>}
        </div>
      </section>}
    </main>

    {error && <div className="toast" role="alert" aria-live="assertive">
      <span className="toast-icon" aria-hidden="true">!</span>
      <div><strong>Действие не завершено</strong><p>{error}</p></div>
      <button type="button" onClick={() => setError("")} aria-label="Закрыть сообщение">×</button>
    </div>}

    <footer><span>Сбор рейтингов</span><span>Данные публикуются только после проверки</span></footer>
  </div>;
}
