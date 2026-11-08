/** The LLM providers: a vault credential → the provider type and endpoint (the Worker's task.json, the Planner, the judge). */
import { coreFetch } from "../proxy/index.ts";
import { read as readVault } from "./vault.ts";

/**
 * A vault credential's transform → core's provider type and the API base on the credential's host.
 * Any other transform name is used as the type itself with no endpoint (tests: `fake`).
 */
const PROVIDERS: Record<string, { type: string; host: string; path: string }> = {
  anthropic: { type: "anthropic", host: "api.anthropic.com", path: "" },
  openai: { type: "openai", host: "api.openai.com", path: "/v1" },
  openrouter: { type: "openai", host: "openrouter.ai", path: "/api/v1" },
  ollama: { type: "openai", host: "ollama.com", path: "/v1" },
};

export function providerSecret(name: string): { type: string; apiKey: string; endpoint?: string } {
  const entry = readVault()[name];
  if (!entry) throw new Error(`worker.provider ${name} is not a credential in vault.json`);
  const tf = entry.transform ?? name;
  const p = PROVIDERS[tf];
  const apiKey = `hortus-secret-${name}`;
  if (!p) return { type: tf, apiKey };
  return { type: p.type, apiKey, endpoint: `https://${entry.hosts?.[0] ?? p.host}${p.path}` };
}

const MODELS_TIMEOUT_MS = 10_000;
const MODELS_MAX_BYTES = 8 * 1024 * 1024;
const MODEL_ID_MAX = 200;

/**
 * The model ids a provider lists, for the owner to pick from. Through the proxy with its placeholder, as the judge's calls
 * go, so hortusd never holds the key here. What comes back is the upstream's: strings of a sane length, and no more of
 * them than a selector can hold. Throws what the owner should see.
 */
export async function listModels(name: string): Promise<string[]> {
  const p = providerSecret(name);
  if (!p.endpoint) throw new Error(`${name} has no known API to list models from`);
  const anthropic = p.type === "anthropic";
  const res = await coreFetch(`${p.endpoint}${anthropic ? "/v1/models?limit=1000" : "/models"}`, {
    headers: anthropic
      ? { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${p.apiKey}` },
    signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MODELS_MAX_BYTES) throw new Error("its list is too long");
  const data = (JSON.parse(text) as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("its answer has no list of models");
  const ids = data
    .map((m: { id?: unknown } | null) => m?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= MODEL_ID_MAX);
  return [...new Set(ids)].sort().slice(0, 2000);
}
