/** The LLM providers: a vault credential → the provider type and endpoint (the Worker's task.json, the Planner, the judge). */
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
