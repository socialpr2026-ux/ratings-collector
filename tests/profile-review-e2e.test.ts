import { describe, expect, it } from "vitest";
import type { Observation, ProductRef, SiteAdapter, SiteProfile } from "../src/shared/types.js";
import { RatingsService } from "../src/server/orchestrator.js";
import { MemoryRepository, productKey } from "../src/server/repository.js";
import { prepareBrowserPublication } from "../src/server/sheets/publication-state.js";

const domains = ["alpha.example.com", "beta.example.com"];
const request = {
  sheetUrl: "https://docs.google.com/spreadsheets/d/profile_review_e2e/edit",
  month: "2026-07",
  region: "Москва",
  domains,
  brands: ["Бренд"]
};

function profile(domain: string, status: "draft" | "approved", cardCount = 5): SiteProfile {
  const now = "2026-07-14T00:00:00.000Z";
  const examples = Array.from({ length: Math.min(3, cardCount) }, (_value, index) => ({
    url: `https://${domain}/product/${index + 1}`,
    title: `Бренд таблетки ${100 + index} мг №${20 + index}`
  }));
  return {
    domain,
    version: 1,
    status,
    sitemapUrls: [],
    ratingScale: 5,
    reviewCountMeaning: status === "approved" ? "reviews" : "unknown",
    rateLimitMs: 0,
    canaryUrls: status === "approved" ? examples.map((item) => item.url) : [],
    testExamples: status === "approved" ? examples : [],
    createdAt: now,
    updatedAt: now,
    approvedAt: status === "approved" ? now : undefined,
    notes: []
  };
}

function adapter(domain: string, cardCount = 5, profileVersion: number | null = 1): SiteAdapter {
  return {
    id: `test-${domain}`,
    supportedDomains: [domain],
    async healthCheck() { return { ok: true, checkedAt: new Date().toISOString() }; },
    async discover(brand: string): Promise<ProductRef[]> {
      return Array.from({ length: cardCount }, (_value, index) => ({
        domain,
        platform: domain,
        listingId: String(index + 1),
        brand,
        url: `https://${domain}/product/${index + 1}`,
        metadata: {}
      }));
    },
    async collect(ref: ProductRef): Promise<Observation> {
      const index = Number(ref.listingId) - 1;
      return {
        domain: ref.domain,
        platform: ref.platform,
        listingId: ref.listingId,
        brand: ref.brand,
        canonicalUrl: ref.url,
        product: `${ref.brand} таблетки ${100 + index} мг №${20 + index}`,
        reviews: 10 + index,
        rating: 4.5,
        status: "needs_review",
        capturedAt: new Date().toISOString(),
        ...(profileVersion === null ? {} : { profileVersion })
      };
    }
  };
}

async function setup(draftDomains: readonly string[]) {
  const repository = new MemoryRepository();
  for (const domain of domains) {
    await repository.saveProfile(profile(domain, draftDomains.includes(domain) ? "draft" : "approved"));
  }
  const service = new RatingsService(repository, async (domain) => adapter(domain));
  const run = await service.executeRun((await service.createRun(request)).id);
  return { repository, service, run };
}

describe("profile approval and selected-card review E2E guardrail", () => {
  it.each([
    { caseName: "one unapproved profile", draftDomains: [domains[1]] },
    { caseName: "several unapproved profiles", draftDomains: domains }
  ])("keeps 10 selected cards blocked until every profile passes its own three controls: $caseName", async ({ draftDomains }) => {
    const { repository, service, run } = await setup(draftDomains);
    const selectedKeys = run.observations.map((item) => productKey(item.domain, item.listingId));

    expect(run.observations).toHaveLength(10);
    expect(selectedKeys).toHaveLength(10);
    expect(run.qa?.blockers.filter((blocker) => blocker.includes("needs_review"))).toHaveLength(10);

    // Review acceptance is never allowed to silently approve a draft profile.
    await expect(service.approveObservations(run.id, selectedKeys))
      .rejects.toThrow("Сначала подтвердите профиль площадки");
    const unchanged = await service.getRun(run.id);
    expect(unchanged?.observations.every((item) => item.status === "needs_review")).toBe(true);

    // The first explicit user step approves each domain independently using
    // exactly the three URLs researched and persisted by the profiler.
    for (const domain of draftDomains) {
      const currentProfile = await repository.getProfile(domain);
      expect(currentProfile?.testExamples).toHaveLength(3);
      await service.approveProfile(domain, currentProfile!.testExamples, "reviews");
    }

    // Profile approval alone must not mutate the selected observations. The
    // second explicit step accepts the preserved 10-card selection.
    const afterProfiles = await service.getRun(run.id);
    expect(afterProfiles?.observations.every((item) => item.status === "needs_review")).toBe(true);
    const accepted = await service.approveObservations(run.id, selectedKeys);

    expect(accepted.observations).toHaveLength(10);
    expect(accepted.observations.every((item) => item.status === "ok")).toBe(true);
    expect(accepted.qa).toEqual({ ok: true, blockers: [], warnings: [] });

    const intent = await prepareBrowserPublication(repository, service, accepted);
    expect(intent).toMatchObject({ shouldPublish: true, run: { status: "publishing", qa: { ok: true, blockers: [] } } });
  });

  it("keeps a two-card profile as an explicit blocker and never enables review or publication", async () => {
    const domain = domains[0];
    const repository = new MemoryRepository();
    await repository.saveProfile(profile(domain, "draft", 2));
    const service = new RatingsService(repository, async () => adapter(domain, 2));
    const run = await service.executeRun((await service.createRun({ ...request, domains: [domain] })).id);
    const selectedKeys = run.observations.map((item) => productKey(item.domain, item.listingId));
    const currentProfile = await repository.getProfile(domain);

    expect(currentProfile?.testExamples).toHaveLength(2);
    await expect(service.approveProfile(domain, currentProfile!.testExamples, "reviews"))
      .rejects.toThrow("ровно три контрольные карточки");
    expect((await repository.getProfile(domain))?.status).toBe("draft");

    await expect(service.approveObservations(run.id, selectedKeys))
      .rejects.toThrow("Сначала подтвердите профиль площадки");
    const blocked = await service.getRun(run.id);
    expect(blocked?.qa?.ok).toBe(false);
    expect(blocked?.qa?.blockers.filter((blocker) => blocker.includes("needs_review"))).toHaveLength(2);
    await expect(prepareBrowserPublication(repository, service, blocked!))
      .rejects.toThrow("не одобрен");
  });

  it("rejects substituted or duplicated controls even when the request contains three entries", async () => {
    const { repository, service } = await setup([domains[0]]);
    const currentProfile = (await repository.getProfile(domains[0]))!;
    const substituted = [
      currentProfile.testExamples[0],
      currentProfile.testExamples[1],
      { url: `https://${domains[0]}/product/not-researched`, title: "Подменённая карточка" }
    ];
    await expect(service.approveProfile(domains[0], substituted, "reviews"))
      .rejects.toThrow("ровно три контрольные карточки");
    await expect(service.approveProfile(domains[0], [
      currentProfile.testExamples[0], currentProfile.testExamples[0], currentProfile.testExamples[1]
    ], "reviews")).rejects.toThrow("ровно три контрольные карточки");
    expect((await repository.getProfile(domains[0]))?.status).toBe("draft");
  });

  it("ignores stale draft KV state for a known unversioned adapter but keeps the versioned guardrail", async () => {
    const domain = "ru.otzyv.com";
    const repository = new MemoryRepository();
    await repository.saveProfile(profile(domain, "draft"));
    const service = new RatingsService(repository, async () => adapter(domain, 1, null));
    const run = await service.executeRun((await service.createRun({ ...request, domains: [domain] })).id);
    const key = productKey(domain, "1");

    expect(run.observations[0]).not.toHaveProperty("profileVersion");
    const accepted = await service.approveObservations(run.id, [key]);
    expect(accepted).toMatchObject({
      qa: { ok: true, blockers: [] },
      observations: [{ domain, listingId: "1", status: "ok" }]
    });
    // The stale generated profile is neither trusted nor silently promoted.
    expect((await repository.getProfile(domain))?.status).toBe("draft");
    await expect(prepareBrowserPublication(repository, service, accepted))
      .resolves.toMatchObject({ shouldPublish: true, run: { status: "publishing" } });
  });

  it("rejects a selected card if its researched profile version changed before acceptance", async () => {
    const domain = domains[0];
    const repository = new MemoryRepository();
    await repository.saveProfile(profile(domain, "draft"));
    const service = new RatingsService(repository, async () => adapter(domain, 3));
    const run = await service.executeRun((await service.createRun({ ...request, domains: [domain] })).id);
    const researched = (await repository.getProfile(domain))!;
    const approved = await service.approveProfile(domain, researched.testExamples, "reviews");
    await repository.saveProfile({ ...approved, version: 2, updatedAt: new Date().toISOString() });

    await expect(service.approveObservations(run.id, [productKey(domain, "1")]))
      .rejects.toThrow("собрана профилем другой версии");
    expect((await service.getRun(run.id))?.observations[0].status).toBe("needs_review");
  });
});
