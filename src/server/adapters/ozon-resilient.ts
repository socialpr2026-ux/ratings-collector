import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./errors.js";
import { isOzonComposerRef, OzonBrowserAdapter } from "./ozon-browser.js";

/**
 * Uses the free first-party composer endpoint in EdgeOne Chromium and falls
 * back to the capped Apify adapter only when the browser route is unavailable.
 */
export class ResilientOzonAdapter implements SiteAdapter {
  readonly id = "ozon";
  readonly supportedDomains = ["ozon.ru", "www.ozon.ru"] as const;
  private browserFailure?: AdapterBlockedError | ParserChangedError;
  private fallbackParserFailure?: ParserChangedError;

  constructor(
    private readonly browser: OzonBrowserAdapter,
    private readonly apify: SiteAdapter
  ) {}

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const browser = await this.browser.healthCheck(context);
    if (browser.ok) return browser;
    const apify = await this.apify.healthCheck(context);
    if (apify.ok) {
      return {
        ok: true,
        checkedAt: apify.checkedAt,
        message: `Ozon browser collector unavailable (${browser.message ?? "unknown error"}); capped Apify fallback is ready`
      };
    }
    return {
      ok: false,
      checkedAt: apify.checkedAt,
      message: `Ozon browser collector: ${browser.message ?? "failed"}; Apify fallback: ${apify.message ?? "failed"}`
    };
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    if (!this.browserFailure) {
      try {
        return await this.browser.discover(brand, context);
      } catch (error) {
        if (!(error instanceof AdapterBlockedError) && !(error instanceof ParserChangedError)) throw error;
        // A cloud-IP block is stable for the lifetime of one run. Retrying the
        // same Ozon browser challenge for every brand only wastes Sandbox time.
        this.browserFailure = error;
      }
    }

    // A schema failure is deterministic for the current Actor version. Do
    // not spend the monthly allowance repeatedly after the fallback has
    // already proved that its dataset is incomplete.
    if (this.fallbackParserFailure) throw this.fallbackParserFailure;
    try {
      return await this.apify.discover(brand, context);
    } catch (fallbackError) {
      if (fallbackError instanceof ParserChangedError) {
        this.fallbackParserFailure = new ParserChangedError(
          `Ozon browser collector: ${this.browserFailure.message}; Apify fallback: ${fallbackError.message}`
        );
        throw this.fallbackParserFailure;
      }
      if (fallbackError instanceof AdapterQuotaError) {
        throw new AdapterQuotaError(
          `Ozon browser collector: ${this.browserFailure.message}; capped Apify fallback: ${fallbackError.message}`
        );
      }
      throw fallbackError;
    }
  }

  collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    return isOzonComposerRef(ref)
      ? this.browser.collect(ref, context)
      : this.apify.collect(ref, context);
  }
}
