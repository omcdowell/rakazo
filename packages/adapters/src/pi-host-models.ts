import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@rakazo/contracts";

/**
 * Host pi CLI as the model source of truth (opt-in, single-user deployments).
 *
 * When RAKAZO_HOST_PI_DIR points at a pi agent directory (usually ~/.pi/agent),
 * this deployment stops composing its own model catalog and instead adopts the
 * host pi installation's: builtin providers, extension-registered providers
 * (allowlisted via RAKAZO_HOST_PI_EXTENSIONS), models.json overrides, and
 * auth.json credentials — with pi's enabledModels scoping applied. OAuth
 * refreshes are written back to auth.json by pi's own runtime.
 *
 * Security: every workspace user on the deployment shares the host
 * credentials, and allowlisted extensions execute in this server process.
 * That is the point for a personal self-host and wrong everywhere else, which
 * is why both variables default to off and the allowlist defaults to empty.
 */

export type HostPiCatalogModel = {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  reasoning: boolean;
  thinkingLevels: ThinkingLevel[];
};

export type HostPi = {
  /** Structurally Models-compatible registry (pi's ModelRuntime). */
  models: Models;
  catalog: HostPiCatalogModel[];
  providerIds: ReadonlySet<string>;
  defaultModel?: { provider: string; id: string };
  diagnostics: string[];
};

export function hostPiDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.RAKAZO_HOST_PI_DIR?.trim();
  if (!raw) return undefined;
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return resolve(expanded);
}

export function hostPiExtensionAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.RAKAZO_HOST_PI_EXTENSIONS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

let bootstrapPromise: Promise<HostPi | undefined> | undefined;
let snapshot: HostPi | undefined;

/**
 * Load the host pi runtime once per process. Resolves undefined when the
 * feature is off. A misconfigured host dir rejects rather than silently
 * falling back to the built-in catalog: the operator asked for pi to be the
 * source of truth, so a partial answer would be worse than a loud failure.
 */
export function ensureHostPi(): Promise<HostPi | undefined> {
  bootstrapPromise ??= bootstrap().then((result) => {
    snapshot = result;
    return result;
  });
  return bootstrapPromise;
}

/** Synchronous view for call sites that already awaited ensureHostPi(). */
export function hostPi(): HostPi | undefined {
  return snapshot;
}

export function resetHostPiForTests(): void {
  bootstrapPromise = undefined;
  snapshot = undefined;
}

type HostSettings = {
  packages?: unknown[];
  enabledModels?: string[];
  defaultModel?: string;
  [key: string]: unknown;
};

function readHostSettings(dir: string): HostSettings {
  let raw: string;
  try {
    raw = readFileSync(join(dir, "settings.json"), "utf8");
  } catch {
    return {};
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Host pi settings.json must be a JSON object (${join(dir, "settings.json")})`);
  }
  return parsed as HostSettings;
}

function packageSource(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (
    entry &&
    typeof entry === "object" &&
    typeof (entry as { source?: unknown }).source === "string"
  ) {
    return (entry as { source: string }).source;
  }
  return "";
}

/**
 * Allowlist entries match by substring against the package source or the
 * extension file path. Substring keeps the config short ("pi-black" instead of
 * a full pinned git ref) and the operator controls both sides of the match.
 */
function matchesAllowlist(value: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => value.includes(entry));
}

type ExtensionLike = { path: string; resolvedPath: string };
type RegistrationLike = { extensionPath: string };
type ExtensionsResultLike = {
  extensions: ExtensionLike[];
  runtime: {
    pendingProviderRegistrations: RegistrationLike[];
    pendingNativeProviderRegistrations: RegistrationLike[];
  };
};

/**
 * Post-load gate: drop non-allowlisted extensions and, critically, the
 * provider registrations they queued while loading. The package filter above
 * keeps non-allowlisted package code from loading at all; this prunes loose
 * files from the agent dir's extensions/ directory, which are discovered
 * outside settings.json.
 */
function pruneExtensions<T extends ExtensionsResultLike>(
  base: T,
  allowlist: string[],
  diagnostics: string[],
): T {
  const allowed = (path: string) => matchesAllowlist(path, allowlist);
  for (const extension of base.extensions) {
    if (!allowed(extension.resolvedPath) && !allowed(extension.path)) {
      diagnostics.push(
        `Skipped host pi extension not in RAKAZO_HOST_PI_EXTENSIONS: ${extension.path}`,
      );
    }
  }
  base.extensions = base.extensions.filter(
    (extension) => allowed(extension.resolvedPath) || allowed(extension.path),
  );
  base.runtime.pendingProviderRegistrations = base.runtime.pendingProviderRegistrations.filter(
    (registration) => allowed(registration.extensionPath),
  );
  base.runtime.pendingNativeProviderRegistrations =
    base.runtime.pendingNativeProviderRegistrations.filter((registration) =>
      allowed(registration.extensionPath),
    );
  return base;
}

async function bootstrap(): Promise<HostPi | undefined> {
  const dir = hostPiDir();
  if (!dir) return undefined;
  const diagnostics: string[] = [];
  // Dynamic import: deployments without the flag never load the pi CLI package.
  const sdk = await import("@earendil-works/pi-coding-agent");
  const allowlist = hostPiExtensionAllowlist();
  const settings = readHostSettings(dir);
  const packages = (settings.packages ?? []).filter((entry) => {
    const source = packageSource(entry);
    if (matchesAllowlist(source, allowlist)) return true;
    if (source)
      diagnostics.push(`Skipped host pi package not in RAKAZO_HOST_PI_EXTENSIONS: ${source}`);
    return false;
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    ...settings,
    packages: packages as import("@earendil-works/pi-coding-agent").PackageSource[],
  });
  const services = await sdk.createAgentSessionServices({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    resourceLoaderOptions: {
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      ...(allowlist.length === 0 ? { noExtensions: true } : {}),
      extensionsOverride: (base) => pruneExtensions(base, allowlist, diagnostics),
    },
  });
  for (const diagnostic of services.diagnostics) {
    diagnostics.push(diagnostic.message);
  }

  const modelRuntime = services.modelRuntime;
  const available = await modelRuntime.getAvailable();
  let scoped: readonly Model<Api>[] = available;
  const enabledModels = settings.enabledModels;
  if (Array.isArray(enabledModels) && enabledModels.length > 0) {
    const resolved = await sdk.resolveModelScopeWithDiagnostics(enabledModels, modelRuntime);
    for (const diagnostic of resolved.diagnostics) diagnostics.push(diagnostic.message);
    const keys = new Set(
      resolved.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`),
    );
    scoped = available.filter((model) => keys.has(`${model.provider}/${model.id}`));
  }

  const providerNames = new Map(
    modelRuntime.getProviders().map((provider) => [provider.id, provider.name]),
  );
  const catalog: HostPiCatalogModel[] = scoped.map((model) => ({
    provider: model.provider,
    providerName: providerNames.get(model.provider) ?? model.provider,
    id: model.id,
    label: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    thinkingLevels: getSupportedThinkingLevels(model) as ThinkingLevel[],
  }));

  return {
    // ModelRuntime implements the Models surface the runtime consumes
    // (getModel/getProviders/streamSimple); pi's own sessions use it the same way.
    models: modelRuntime as unknown as Models,
    catalog,
    providerIds: new Set(catalog.map((entry) => entry.provider)),
    defaultModel: resolveDefaultModel(
      sdk,
      modelRuntime,
      settings.defaultModel,
      catalog,
      diagnostics,
    ),
    diagnostics,
  };
}

function resolveDefaultModel(
  sdk: typeof import("@earendil-works/pi-coding-agent"),
  modelRuntime: Awaited<
    ReturnType<typeof import("@earendil-works/pi-coding-agent")["ModelRuntime"]["create"]>
  >,
  configured: string | undefined,
  catalog: HostPiCatalogModel[],
  diagnostics: string[],
): { provider: string; id: string } | undefined {
  const inCatalog = (provider: string, id: string) =>
    catalog.some((entry) => entry.provider === provider && entry.id === id);
  if (configured?.trim()) {
    const resolved = sdk.resolveCliModel({ cliModel: configured.trim(), modelRuntime });
    const model = resolved.model;
    if (model && inCatalog(model.provider, model.id)) {
      return { provider: model.provider, id: model.id };
    }
    diagnostics.push(
      resolved.error ??
        `Host pi defaultModel "${configured.trim()}" is not in the scoped catalog; using the first scoped model.`,
    );
  }
  const first = catalog[0];
  return first ? { provider: first.provider, id: first.id } : undefined;
}
