export const INITIAL_DOMAINS = ["ozon.ru", "wildberries.ru", "market.yandex.ru"] as const;

export const INITIAL_BRANDS = [
  "Арбидол",
  "Кагоцел",
  "Рафамин",
  "Эргоферон",
  "Анаферон",
  "Гриппферон",
  "Ингавирин",
  "Циклоферон",
  "Полиоксидоний",
  "Трекрезан",
  "Цитовир-3",
  "Бронхо-мунал",
  "Амиксин",
  "Номидес",
  "Триазавирин",
  "Нобазит",
  "Исмиген"
] as const;

export const BRAND_ALIASES: Record<string, string[]> = {
  "Кагоцел": ["Kagocel", "Kagotsel"],
  "Циклоферон": ["Cycloferon", "Tsikloferon"],
  "Полиоксидоний": ["Polyoxidonium", "Polioksidoniy", "Polioksidonii"],
  "Арбидол": ["Арбидол", "Арбидол Максимум", "Arbidol"],
  "Амиксин": ["Amixin", "Amiksin"],
  "Ингавирин": ["Ingavirin"],
  "Эргоферон": ["Ergoferon"],
  "Цитовир-3": ["Цитовир 3", "Цитовир-3"],
  "Бронхо-мунал": ["Бронхо мунал", "Бронхомунал", "Бронхо-мунал"],
  "Анаферон": ["Анаферон", "Анаферон детский", "Anaferon"],
  "Бактоблис": ["БактоБЛИС", "Бакто БЛИС", "Бакто-БЛИС", "Bactoblis"]
};
