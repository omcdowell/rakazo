import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureHostPi,
  hostPi,
  hostPiDir,
  hostPiExtensionAllowlist,
  resetHostPiForTests,
} from "./pi-host-models.js";

/**
 * Offline fixtures: a temp pi agent dir with settings/auth/models files and
 * loose extensions that register fake providers with literal API keys, so
 * getAvailable() sees them as authed without any network or real credential.
 */

const EXTENSION_TEMPLATE = (provider: string, model: string) => `
export default function (pi) {
  pi.registerProvider("${provider}", {
    name: "${provider} name",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "fixture-test-key",
    api: "openai-completions",
    models: [
      {
        id: "${model}",
        name: "${model} label",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1024,
        maxTokens: 128,
      },
    ],
  });
}
`;

let dir: string;

async function writeAgentDir(settings: Record<string, unknown>): Promise<void> {
  await writeFile(join(dir, "settings.json"), JSON.stringify(settings));
  await writeFile(join(dir, "auth.json"), "{}");
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(
    join(dir, "extensions", "allowed-fixture.js"),
    EXTENSION_TEMPLATE("fixture-prov", "fixture-model"),
  );
  await writeFile(
    join(dir, "extensions", "blocked-fixture.js"),
    EXTENSION_TEMPLATE("blocked-prov", "blocked-model"),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rakazo-host-pi-"));
  resetHostPiForTests();
  vi.stubEnv("PI_OFFLINE", "1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetHostPiForTests();
  await rm(dir, { recursive: true, force: true });
});

describe("host pi env parsing", () => {
  it("is disabled without RAKAZO_HOST_PI_DIR", async () => {
    vi.stubEnv("RAKAZO_HOST_PI_DIR", "");
    expect(hostPiDir()).toBeUndefined();
    expect(await ensureHostPi()).toBeUndefined();
    expect(hostPi()).toBeUndefined();
  });

  it("expands ~ and parses the extension allowlist", () => {
    vi.stubEnv("RAKAZO_HOST_PI_DIR", "~/.pi/agent");
    expect(hostPiDir()).not.toContain("~");
    vi.stubEnv("RAKAZO_HOST_PI_EXTENSIONS", " pi-black , ,pi-cursor-sdk ");
    expect(hostPiExtensionAllowlist()).toEqual(["pi-black", "pi-cursor-sdk"]);
  });
});

describe("host pi bootstrap", () => {
  it("adopts allowlisted extension providers and prunes the rest", async () => {
    await writeAgentDir({});
    vi.stubEnv("RAKAZO_HOST_PI_DIR", dir);
    vi.stubEnv("RAKAZO_HOST_PI_EXTENSIONS", "allowed-fixture");
    const host = await ensureHostPi();
    expect(host).toBeDefined();
    expect(host!.providerIds.has("fixture-prov")).toBe(true);
    expect(host!.providerIds.has("blocked-prov")).toBe(false);
    const entry = host!.catalog.find((model) => model.provider === "fixture-prov");
    expect(entry).toMatchObject({
      id: "fixture-model",
      label: "fixture-model label",
      providerName: "fixture-prov name",
    });
    expect(host!.diagnostics.join("\n")).toContain("blocked-fixture");
    expect(host!.models.getModel("fixture-prov", "fixture-model")).toBeDefined();
  });

  it("loads no extensions when the allowlist is empty", async () => {
    await writeAgentDir({});
    vi.stubEnv("RAKAZO_HOST_PI_DIR", dir);
    vi.stubEnv("RAKAZO_HOST_PI_EXTENSIONS", "");
    const host = await ensureHostPi();
    expect(host!.providerIds.has("fixture-prov")).toBe(false);
    expect(host!.providerIds.has("blocked-prov")).toBe(false);
  });

  it("applies pi enabledModels scoping to the catalog", async () => {
    await writeAgentDir({
      enabledModels: ["fixture-prov/fixture-model"],
    });
    vi.stubEnv("RAKAZO_HOST_PI_DIR", dir);
    // Both fixtures allowlisted; scoping (not the allowlist) must narrow the catalog.
    vi.stubEnv("RAKAZO_HOST_PI_EXTENSIONS", "fixture");
    const host = await ensureHostPi();
    expect(host!.catalog.map((entry) => `${entry.provider}/${entry.id}`)).toEqual([
      "fixture-prov/fixture-model",
    ]);
  });

  it("resolves the pi default model, falling back to the first scoped model", async () => {
    await writeAgentDir({
      defaultModel: "fixture-prov/fixture-model",
    });
    vi.stubEnv("RAKAZO_HOST_PI_DIR", dir);
    vi.stubEnv("RAKAZO_HOST_PI_EXTENSIONS", "fixture");
    const host = await ensureHostPi();
    expect(host!.defaultModel).toEqual({ provider: "fixture-prov", id: "fixture-model" });

    resetHostPiForTests();
    await writeAgentDir({ defaultModel: "missing/never-was", enabledModels: ["fixture-prov/*"] });
    const fallback = await ensureHostPi();
    expect(fallback!.defaultModel).toEqual({ provider: "fixture-prov", id: "fixture-model" });
    expect(fallback!.diagnostics.length).toBeGreaterThan(0);
  });

  it("keeps a stable snapshot after ensure", async () => {
    await writeAgentDir({});
    vi.stubEnv("RAKAZO_HOST_PI_DIR", dir);
    vi.stubEnv("RAKAZO_HOST_PI_EXTENSIONS", "allowed-fixture");
    const host = await ensureHostPi();
    expect(hostPi()).toBe(host);
    expect(await ensureHostPi()).toBe(host);
  });
});
