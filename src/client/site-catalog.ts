export type SiteCatalogGroup = {
  id: "marketplaces" | "review-sites" | "pharmacies";
  label: string;
  description: string;
  sites: readonly {
    domain: string;
    label: string;
    availability?: "ready" | "temporarily_blocked";
    note?: string;
  }[];
};

export const SITE_CATALOG: readonly SiteCatalogGroup[] = [
  {
    id: "marketplaces",
    label: "Маркетплейсы",
    description: "Карточки товаров без дублей продавцов",
    sites: [
      { domain: "ozon.ru", label: "Ozon" },
      { domain: "wildberries.ru", label: "Wildberries" },
      { domain: "market.yandex.ru", label: "Яндекс Маркет" }
    ]
  },
  {
    id: "review-sites",
    label: "Отзовики",
    description: "Площадки с отзывами и оценками брендов и товаров",
    sites: [
      { domain: "irecommend.ru", label: "iRecommend" },
      { domain: "otzovik.com", label: "Отзовик" },
      { domain: "otzyv.pro", label: "Отзыв.pro" },
      { domain: "vseotzyvy.ru", label: "Все отзывы" },
      { domain: "otzyvru.com", label: "ОтзывРу" },
      { domain: "pravogolosa.net", label: "Право голоса" },
      { domain: "ru.otzyv.com", label: "Otzyv.com" }
    ]
  },
  {
    id: "pharmacies",
    label: "Аптеки",
    description: "Карточки препаратов в аптечных каталогах",
    sites: [
      { domain: "uteka.ru", label: "Ютека" },
      { domain: "megapteka.ru", label: "Мегаптека" },
      { domain: "medum.ru", label: "Medum", availability: "temporarily_blocked", note: "Сайт сейчас блокирует автоматический доступ" },
      { domain: "eapteka.ru", label: "ЕАПТЕКА" },
      { domain: "polza.ru", label: "POLZAru" },
      { domain: "asna.ru", label: "АСНА" },
      { domain: "farmlend.ru", label: "Фармленд" },
      { domain: "okapteka.ru", label: "ОК Аптека" },
      { domain: "rigla.ru", label: "Ригла" },
      { domain: "zdravcity.ru", label: "Здравсити" }
    ]
  }
] as const;

export const CATALOG_DOMAINS = SITE_CATALOG.flatMap((group) => group.sites.map((site) => site.domain));
export const SELECTABLE_CATALOG_DOMAINS = SITE_CATALOG.flatMap((group) =>
  group.sites.filter((site) => site.availability !== "temporarily_blocked").map((site) => site.domain)
);

function rawDomainLines(value: string) {
  return value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
}

export function normalizeDomain(value: string) {
  const candidate = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    return new URL(candidate).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//i, "").split("/")[0].replace(/^www\./i, "").toLowerCase();
  }
}

export function parseDomainList(value: string) {
  const seen = new Set<string>();
  return rawDomainLines(value).map(normalizeDomain).filter((domain) => {
    if (!domain || seen.has(domain)) return false;
    seen.add(domain);
    return true;
  });
}

/**
 * Updates preset sites while leaving every unrelated manual entry byte-for-byte
 * intact. This keeps the textarea and the visual picker as one source of truth.
 */
export function updateDomainSelection(value: string, targetDomains: readonly string[], selected: boolean) {
  const targets = new Set(targetDomains.map(normalizeDomain));
  const rawLines = rawDomainLines(value);
  const kept = selected ? rawLines : rawLines.filter((line) => !targets.has(normalizeDomain(line)));
  const present = new Set(kept.map(normalizeDomain));

  if (selected) {
    for (const domain of targetDomains) {
      const normalized = normalizeDomain(domain);
      if (normalized && !present.has(normalized)) {
        kept.push(normalized);
        present.add(normalized);
      }
    }
  }

  return kept.join("\n");
}

export function countCustomDomains(value: string) {
  const catalog = new Set(CATALOG_DOMAINS);
  return parseDomainList(value).filter((domain) => !catalog.has(domain)).length;
}
