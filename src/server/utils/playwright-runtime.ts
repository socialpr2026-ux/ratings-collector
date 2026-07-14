type LegacyModuleGlobals = typeof globalThis & {
  __dirname?: string;
  __filename?: string;
};

let playwright: Promise<typeof import("playwright-core")> | undefined;

/**
 * EdgeOne bundles Agent entrypoints as ESM. A transitive Playwright helper
 * still reads the CommonJS globals while its module is initialised, so a
 * static import crashes the whole Agent before the request handler starts.
 * Install the compatibility globals first and only then initialise the
 * bundled Playwright module.
 */
export function loadPlaywright(): Promise<typeof import("playwright-core")> {
  const scope = globalThis as LegacyModuleGlobals;
  scope.__dirname ??= process.cwd();
  scope.__filename ??= process.argv[1] || `${process.cwd()}/agent.mjs`;
  return playwright ??= import("playwright-core");
}
