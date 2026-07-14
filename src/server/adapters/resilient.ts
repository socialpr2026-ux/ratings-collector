import type {
  AdapterContext,
  AdapterHealth,
  Observation,
  ProductRef,
  SiteAdapter
} from "../../shared/types.js";
import { AdapterBlockedError, AdapterQuotaError, ParserChangedError } from "./errors.js";

export type ResilientAdapterOptions = {
  isFallbackRef: (ref: ProductRef) => boolean;
};

/**
 * Keeps a first-party collector as the free primary path while routing around
 * an IP block or parser drift through a deterministic, capped fallback.
 */
export class ResilientAdapter implements SiteAdapter {
  readonly id: string;
  readonly supportedDomains: readonly string[];
  private primaryFailure?: AdapterBlockedError | ParserChangedError;
  private fallbackParserFailure?: ParserChangedError;
  private readonly fallbackDiscoveries = new Map<string, Promise<ProductRef[]>>();

  constructor(
    private readonly primary: SiteAdapter,
    private readonly fallback: SiteAdapter,
    private readonly options: ResilientAdapterOptions
  ) {
    if (primary.id !== fallback.id) throw new Error("Primary and fallback adapters must expose the same id");
    this.id = primary.id;
    this.supportedDomains = primary.supportedDomains;
  }

  async healthCheck(context: AdapterContext): Promise<AdapterHealth> {
    const primary = await this.primary.healthCheck(context);
    if (primary.ok) return primary;
    const fallback = await this.fallback.healthCheck(context);
    if (fallback.ok) {
      return {
        ok: true,
        checkedAt: fallback.checkedAt,
        message: `${this.id} primary unavailable (${primary.message ?? "unknown error"}); capped fallback is ready`
      };
    }
    return {
      ok: false,
      checkedAt: fallback.checkedAt,
      message: `${this.id} primary: ${primary.message ?? "failed"}; fallback: ${fallback.message ?? "failed"}`
    };
  }

  async discover(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    if (!this.primaryFailure) {
      try {
        return await this.primary.discover(brand, context);
      } catch (error) {
        if (!(error instanceof AdapterBlockedError) && !(error instanceof ParserChangedError)) throw error;
        this.primaryFailure = error;
      }
    }

    return this.discoverFallback(brand, context);
  }

  async collect(ref: ProductRef, context: AdapterContext): Promise<Observation> {
    if (this.options.isFallbackRef(ref)) return this.fallback.collect(ref, context);

    try {
      return await this.primary.collect(ref, context);
    } catch (error) {
      if (!(error instanceof AdapterBlockedError) && !(error instanceof ParserChangedError)) throw error;
      // Some marketplaces expose discovery from one public endpoint while the
      // per-card endpoint is blocked on cloud IPs. Re-discover once through the
      // capped fallback and route the same stable listing ID through it.
      this.primaryFailure ??= error;
      const fallbackRefs = await this.discoverFallback(ref.brand, context);
      const replacement = fallbackRefs.find((candidate) => candidate.listingId === ref.listingId);
      if (!replacement) {
        throw new ParserChangedError(
          `${this.id} primary card ${ref.listingId} failed (${error.message}); fallback did not return the same listing ID`
        );
      }
      return this.fallback.collect(replacement, context);
    }
  }

  private discoverFallback(brand: string, context: AdapterContext): Promise<ProductRef[]> {
    if (this.fallbackParserFailure) return Promise.reject(this.fallbackParserFailure);
    const cached = this.fallbackDiscoveries.get(brand);
    if (cached) return cached;
    const discovery = this.fallback.discover(brand, context).catch((error) => {
      if (error instanceof ParserChangedError) {
        this.fallbackParserFailure = new ParserChangedError(
          `${this.id} primary: ${this.primaryFailure?.message ?? "unavailable"}; fallback: ${error.message}`
        );
        throw this.fallbackParserFailure;
      }
      if (error instanceof AdapterQuotaError) {
        throw new AdapterQuotaError(
          `${this.id} free collector failed: ${this.primaryFailure?.message ?? "unavailable"}; capped fallback: ${error.message}`
        );
      }
      throw error;
    });
    this.fallbackDiscoveries.set(brand, discovery);
    return discovery;
  }

}
