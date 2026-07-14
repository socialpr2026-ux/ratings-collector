import { describe, expect, it } from "vitest";
import { readerMarkdownToHtml, readerProxyUrl } from "../src/server/utils/reader-proxy.js";

describe("review-site reader proxy", () => {
  it("renders only inert text and absolute HTTPS links", () => {
    const html = readerMarkdownToHtml(
      'Title: Анвифен | отзывы\n[Читать все отзывы 42](https://irecommend.ru/content/anvifen)\n<script>alert(1)</script>',
      "https://irecommend.ru/srch?query=Анвифен"
    );

    expect(html).toContain("<title>Анвифен | отзывы</title>");
    expect(html).toContain('<a href="https://irecommend.ru/content/anvifen">Читать все отзывы 42</a>');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("builds a fixed reader URL around the validated source URL", () => {
    expect(readerProxyUrl(new URL("https://megapteka.ru/product/anvifen/reviews")).toString())
      .toBe("https://r.jina.ai/https://megapteka.ru/product/anvifen/reviews");
  });
});
