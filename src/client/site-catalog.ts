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
      { domain: "market.yandex.ru", label: "Яндекс Маркет" },
      { domain: "megamarket.ru", label: "Мегамаркет" }
    ]
  },
  {
    id: "review-sites",
    label: "Отзовики",
    description: "Площадки с отзывами и оценками брендов и товаров",
    sites: [
      { domain: "irecommend.ru", label: "iRecommend" },
      { domain: "reviews.yandex.ru", label: "Яндекс Отзывы", note: "Отдельная площадка; не объединяется с Яндекс Маркетом" },
      {
        domain: "med-otzyv.ru",
        label: "Мед-отзыв",
        availability: "temporarily_blocked",
        note: "Сайт сейчас недоступен"
      },
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
      { domain: "009.xn--p1ai", label: "009.рф" },
      { domain: "aptekaplus.ru", label: "Аптека Плюс", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "megapteka.ru", label: "Мегаптека" },
      { domain: "redapteka.ru", label: "REDapteka", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "maksavit.ru", label: "Максавит" },
      { domain: "vapteke.ru", label: "ВАптеке" },
      { domain: "polza.ru", label: "POLZAru" },
      { domain: "expero.ru", label: "Expero", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "rigla.ru", label: "Ригла" },
      { domain: "gorzdrav.org", label: "Горздрав", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "366.ru", label: "36,6", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "stolichki.ru", label: "Столички", availability: "temporarily_blocked", note: "Сайт сейчас блокирует автоматический доступ" },
      { domain: "neopharm.ru", label: "Неофарм", availability: "temporarily_blocked", note: "Сайт сейчас блокирует автоматический доступ" },
      { domain: "ozerki.ru", label: "Озерки" },
      { domain: "stoletov.ru", label: "Доктор Столетов", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      {
        domain: "apteka-april.ru",
        label: "Апрель",
        availability: "temporarily_blocked",
        note: "Защита площадки блокирует бесплатный облачный доступ"
      },
      { domain: "farmlend.ru", label: "Фармленд" },
      { domain: "planetazdorovo.ru", label: "Планета Здоровья", availability: "temporarily_blocked", note: "Сайт сейчас блокирует автоматический доступ" },
      { domain: "budzdorov.ru", label: "Будь Здоров" },
      { domain: "samson-pharma.ru", label: "Самсон-Фарма", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "zdesapteka.ru", label: "Здесь Аптека", availability: "temporarily_blocked", note: "Сайт сейчас блокирует автоматический доступ" },
      {
        domain: "apteka.magnit.ru",
        label: "Магнит Аптека",
        availability: "temporarily_blocked",
        note: "Рейтинг не отображается на карточке товара; скрытые API-агрегаты исключены"
      },
      { domain: "superapteka.ru", label: "СуперАптека", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "vitaexpress.ru", label: "Аптека Вита" },
      { domain: "zhivika.ru", label: "Живика", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "aptekasalve.ru", label: "Salve", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "zdorov.ru", label: "Здоров.ру", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "tabletka.ru", label: "tabletka.ru", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "pharmeconom.ru", label: "ФАРМЭКОНОМ", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "aptstore.ru", label: "aptstore.ru", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "newapteka.ru", label: "Новая аптека", availability: "temporarily_blocked", note: "Сайт сейчас блокирует автоматический доступ" },
      { domain: "ovita.ru", label: "Овита.ру", availability: "temporarily_blocked", note: "Сборщик ещё не подключён" },
      { domain: "uteka.ru", label: "Ютека" },
      { domain: "eapteka.ru", label: "ЕАПТЕКА" },
      { domain: "medum.ru", label: "Medum", availability: "temporarily_blocked", note: "Сайт сейчас блокирует автоматический доступ" },
      { domain: "asna.ru", label: "АСНА" },
      { domain: "okapteka.ru", label: "ОК Аптека" },
      { domain: "zdravcity.ru", label: "Здравсити" },
      { domain: "apteka.ru", label: "Apteka.ru" },
      { domain: "nfapteka.ru", label: "Надежда-Фарм" },
      {
        domain: "etabl.ru",
        label: "eTabl.ru",
        availability: "temporarily_blocked",
        note: "Публичные рейтинги подтверждены; автоматический маршрут сейчас недоступен"
      }
    ]
  }
] as const;

export const CATALOG_DOMAINS = SITE_CATALOG.flatMap((group) => group.sites.map((site) => site.domain));
export const TEMPORARILY_BLOCKED_CATALOG_DOMAINS = SITE_CATALOG.flatMap((group) =>
  group.sites.filter((site) => site.availability === "temporarily_blocked").map((site) => site.domain)
);
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

export function parseRunnableDomainList(value: string) {
  const blocked = new Set(TEMPORARILY_BLOCKED_CATALOG_DOMAINS);
  return parseDomainList(value).filter((domain) => !blocked.has(domain));
}

export function parseTemporarilyBlockedDomainList(value: string) {
  const blocked = new Set(TEMPORARILY_BLOCKED_CATALOG_DOMAINS);
  return parseDomainList(value).filter((domain) => blocked.has(domain));
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
