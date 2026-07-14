import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("employee Ozon companion launcher", () => {
  it("is downloadable from the web app and installs outside the source checkout", async () => {
    const [launcher, repositoryShortcut, app] = await Promise.all([
      readFile(new URL("../public/ratings-ozon-helper.cmd", import.meta.url), "utf8"),
      readFile(new URL("../companion/Установить и запустить.cmd", import.meta.url), "utf8"),
      readFile(new URL("../src/client/App.tsx", import.meta.url), "utf8")
    ]);

    expect(app).toContain('href="/ratings-ozon-helper.cmd"');
    expect(app).toContain("Скачать помощник");
    expect(launcher).toContain("codeload.github.com/socialpr2026-ux/ratings-collector");
    expect(launcher).toContain("%LOCALAPPDATA%\\RatingsCollector\\app");
    expect(launcher).toContain("corepack pnpm exec tsx companion/start.ts");
    expect(launcher).not.toContain('cd /d "%~dp0.."');
    expect(Buffer.from(launcher).some((byte) => byte > 0x7f)).toBe(false);
    expect(Buffer.from(repositoryShortcut).some((byte) => byte > 0x7f)).toBe(false);
    expect(repositoryShortcut).toContain("public\\ratings-ozon-helper.cmd");
  });
});
