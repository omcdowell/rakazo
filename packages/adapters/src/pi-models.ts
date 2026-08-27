import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelOAuthSignInMode, ThinkingLevel } from "@rakazo/contracts";
import { type HostPi, hostPi } from "./pi-host-models.js";
import { LOCAL_PROVIDER_ID, registerLocalProvider } from "./pi-local-provider.js";
import { SUBSCRIPTION_SIGN_IN_PROVIDERS } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
  OPENAI_COMPATIBLE_PROVIDER_ID,
  registerOpenAiCompatibleCatalog,
} from "./pi-openai-compatible-provider.js";

export type PiCatalogAuth = "api-key" | "oauth" | "both";

export type PiCatalogEntry = {
  provider: string;
  providerName: string;
  id: string;
  label: string;
  billing: string;
  auth: PiCatalogAuth;
  oauthLabel?: string;
  authHint?: string;
  subscription: boolean;
  signIn?: ModelOAuthSignInMode;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
  placeholder?: boolean;
  hostAuthed?: boolean;
};

export function listPiCatalog(): PiCatalogEntry[] {
  // Host pi mode replaces the catalog wholesale: pi (builtins + allowlisted
  // extensions + models.json + enabledModels scoping) is the source of truth.
  const host = hostPi();
  if (host) return hostCatalogEntries(host);
  cachedCatalog ??= buildPiCatalog();
  return cachedCatalog;
}

function hostCatalogEntries(host: HostPi): PiCatalogEntry[] {
  return host.catalog.map((model) => ({
    provider: model.provider,
    providerName: model.providerName,
    id: model.id,
    label: model.label,
    billing: "Signed in on this server's pi CLI. Managed by the deployment owner.",
    auth: "api-key" as const,
    subscription: false,
    reasoning: model.reasoning,
    thinkingLevels: model.thinkingLevels,
    hostAuthed: true,
  }));
}

let cachedCatalog: PiCatalogEntry[] | undefined;

function buildPiCatalog(): PiCatalogEntry[] {
  const models = registerOpenAiCompatibleCatalog(registerLocalProvider(builtinModels()));
  const entries: PiCatalogEntry[] = [];
  for (const provider of models.getProviders()) {
    const apiKey = Boolean(provider.auth.apiKey);
    const oauth = Boolean(provider.auth.oauth);
    const auth: PiCatalogAuth = apiKey && oauth ? "both" : oauth ? "oauth" : "api-key";
    const signInMeta = SUBSCRIPTION_SIGN_IN_PROVIDERS[provider.id];
    const oauthLabel =
      signInMeta?.loginLabel ?? provider.auth.oauth?.loginLabel ?? provider.auth.oauth?.name;
    const subscription = Boolean(provider.auth.oauth?.isSubscription);
    const billing = catalogBilling(provider.id, provider.name, {
      apiKey,
      oauth,
    });
    for (const model of provider.getModels()) {
      const thinkingLevels = getSupportedThinkingLevels(model) as ThinkingLevel[];
      entries.push({
        provider: provider.id,
        providerName: provider.name,
        id: model.id,
        label: model.name || model.id,
        billing,
        auth,
        oauthLabel,
        authHint:
          provider.id === OPENAI_COMPATIBLE_PROVIDER_ID ? "Custom server" : signInMeta?.hint,
        subscription,
        signIn: signInMeta?.mode,
        reasoning: Boolean(model.reasoning),
        thinkingLevels,
        ...(model.id === OPENAI_COMPATIBLE_CATALOG_MODEL_ID ? { placeholder: true } : {}),
      });
    }
  }

  const envDefaultModel = process.env.PI_DEFAULT_MODEL?.trim();
  const envDefaultProvider = process.env.PI_DEFAULT_PROVIDER?.trim() || "openrouter";
  if (
    envDefaultProvider === "openrouter" &&
    envDefaultModel &&
    !models.getModel("openrouter", envDefaultModel)
  ) {
    entries.unshift({
      provider: "openrouter",
      providerName: "OpenRouter",
      id: envDefaultModel,
      label: envDefaultModel,
      billing: `Configured via PI_DEFAULT_MODEL (${envDefaultModel}).`,
      auth: "api-key",
      subscription: false,
      reasoning: true,
      thinkingLevels: ["off", "minimal", "low", "medium", "high"],
    });
  }

  return entries;
}

function catalogBilling(
  providerId: string,
  name: string,
  opts: { apiKey: boolean; oauth: boolean },
) {
  const signInMeta = SUBSCRIPTION_SIGN_IN_PROVIDERS[providerId];
  if (signInMeta) return signInMeta.billing;
  if (providerId === LOCAL_PROVIDER_ID) {
    return "Runs on infrastructure configured by the deployment owner. No model charges from Rakazo.";
  }
  if (providerId === OPENAI_COMPATIBLE_PROVIDER_ID) {
    return "Runs on a URL you control. Rakazo does not pay for model usage.";
  }
  if (opts.oauth && !opts.apiKey) {
    return `${name} subscription login is not in the Rakazo UI yet. Skip if this deployment already has credentials.`;
  }
  if (opts.apiKey) {
    return `Uses your ${name} API key. Rakazo does not pay for model usage.`;
  }
  return `Uses your ${name} key. Rakazo does not pay for model usage.`;
}

export const scriptedCatalogEntry: PiCatalogEntry = {
  provider: "scripted",
  providerName: "Scripted",
  id: "scripted",
  label: "Scripted runtime (local verification)",
  billing: "No model charges. Deterministic fixture for tests.",
  auth: "api-key",
  subscription: false,
};
