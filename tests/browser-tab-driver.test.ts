import { describe, expect, it } from "vitest";
import {
  PlaywrightSheetsUiDriver,
  type LocatorLike,
  type PlaywrightPageLike
} from "../src/server/sheets/browser-ui-driver.js";

type Item = {
  kind: "tab" | "add" | "grid" | "toolbar" | "rename";
  text?: string;
};

class FakePage {
  tabs: string[];
  active: string;
  addClicks = 0;
  renameMode = false;
  pendingName = "";

  constructor(tabs: string[]) {
    this.tabs = [...tabs];
    this.active = tabs[0] ?? "";
  }

  locator(selector: string): FakeLocator {
    if (selector.includes("View only") || selector.includes("Только просмотр")) return new FakeLocator(this, []);
    if (selector.includes("waffle-grid-container")) return new FakeLocator(this, [{ kind: "grid" }]);
    if (selector.includes("#t-merge-menu") || selector.includes("#docs-toolbar")) return new FakeLocator(this, [{ kind: "toolbar" }]);
    if (selector.includes("#docs-sheet-add") || selector.includes("aria-label='Add sheet'")) return new FakeLocator(this, [{ kind: "add" }]);
    if (selector.includes("contenteditable='true'") || selector.includes("tab-name-input") || selector.includes("active-tab input")) {
      return new FakeLocator(this, this.renameMode ? [{ kind: "rename" }] : []);
    }
    if (selector.includes("active-tab") || selector.includes("aria-selected='true'")) {
      return new FakeLocator(this, this.active ? [{ kind: "tab", text: this.active }] : []);
    }
    if (selector === ".docs-sheet-tab-name" || selector === "[role='tab']") {
      return new FakeLocator(this, this.tabs.map((text) => ({ kind: "tab", text })));
    }
    return new FakeLocator(this, []);
  }

  keyboard = {
    press: async (_key: string) => undefined,
    type: async (_text: string) => undefined
  };

  async evaluate<Result, Argument>(_fn: (argument: Argument) => Result | Promise<Result>, _argument: Argument): Promise<Result> {
    throw new Error("unused");
  }

  async waitForTimeout(_milliseconds: number): Promise<void> {}
  context() { return { grantPermissions: async () => undefined }; }
  url() { return "https://docs.google.com/spreadsheets/d/test/edit?gid=0#gid=0"; }
  async goto() { return undefined; }
}

class FakeLocator implements LocatorLike {
  constructor(private readonly page: FakePage, private readonly items: Item[]) {}
  async count() { return this.items.length; }
  first() { return new FakeLocator(this.page, this.items.slice(0, 1)); }
  nth(index: number) { return new FakeLocator(this.page, this.items.slice(index, index + 1)); }
  filter(options: { hasText: string }) {
    return new FakeLocator(this.page, this.items.filter((item) => item.text?.includes(options.hasText)));
  }
  async click() {
    const item = this.items[0];
    if (item?.kind === "tab" && item.text) this.page.active = item.text;
    if (item?.kind === "add") {
      this.page.addClicks += 1;
      const name = `Лист${this.page.tabs.length + 1}`;
      this.page.tabs.push(name);
      this.page.active = name;
    }
  }
  async dblclick() {
    if (this.items[0]?.kind === "tab") this.page.renameMode = true;
  }
  async hover() {}
  async fill(value: string) { this.page.pendingName = value; }
  async press(key: string) {
    if (this.items[0]?.kind === "rename" && key === "Enter") {
      const index = this.page.tabs.indexOf(this.page.active);
      this.page.tabs[index] = this.page.pendingName;
      this.page.active = this.page.pendingName;
      this.page.renameMode = false;
    }
  }
  async waitFor() {}
  async isVisible() { return this.items.length > 0; }
  async getAttribute(_name: string) { return null; }
  async textContent() { return this.items[0]?.text ?? null; }
  async inputValue() { return this.page.pendingName; }
}

function driver(page: FakePage): PlaywrightSheetsUiDriver {
  return new PlaywrightSheetsUiDriver(page as unknown as PlaywrightPageLike, { timeoutMs: 100 });
}

describe("Google Sheets tab resolver", () => {
  it("selects an existing canonical tab without creating another", async () => {
    const page = new FakePage(["Лист1", "Ratings"]);
    await expect(driver(page).ensureTab("Ratings", ["Рейтинги"])).resolves.toBe("Ratings");
    expect(page.active).toBe("Ratings");
    expect(page.addClicks).toBe(0);
  });

  it("preserves an existing legacy ratings tab", async () => {
    const page = new FakePage(["Рейтинги"]);
    await expect(driver(page).ensureTab("Ratings", ["Рейтинги"])).resolves.toBe("Рейтинги");
    expect(page.tabs).toEqual(["Рейтинги"]);
    expect(page.addClicks).toBe(0);
  });

  it("creates and confirms one canonical Ratings tab when both names are absent", async () => {
    const page = new FakePage(["Лист1"]);
    const sheets = driver(page);
    await expect(sheets.ensureTab("Ratings", ["Рейтинги"])).resolves.toBe("Ratings");
    await expect(sheets.ensureTab("Ratings", ["Рейтинги"])).resolves.toBe("Ratings");
    expect(page.tabs).toEqual(["Лист1", "Ratings"]);
    expect(page.addClicks).toBe(1);
  });
});
