import { log } from "./lib/redact.ts";
import { buildSessionConfig } from "./persona.ts";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const BASE = "https://api.openai.com/v1";

if (!OPENAI_KEY) {
  log.error("OPENAI_API_KEY not set");
}

async function openaiFetch(
  path: string,
  init: RequestInit & { retries?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const retries = init.retries ?? 2;
  const timeoutMs = init.timeoutMs ?? 15_000;
  const { retries: _r, timeoutMs: _t, signal: userSignal, ...rest } = init;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), timeoutMs);
    if (userSignal) {
      if (userSignal.aborted) ctrl.abort(userSignal.reason);
      else userSignal.addEventListener("abort", () => ctrl.abort(userSignal.reason), { once: true });
    }
    try {
      const res = await fetch(`${BASE}${path}`, {
        ...rest,
        signal: ctrl.signal,
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
      clearTimeout(timer);
      if (res.ok) return res;
      if (res.status >= 500 || res.status === 429) {
        const wait = 500 * Math.pow(2, attempt);
        log.warn(`OpenAI ${path} status=${res.status}, retry in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const body = await res.text();
      log.error(`OpenAI ${path} non-retryable`, { status: res.status, body });
      throw new Error(`OpenAI ${res.status}`);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      log.warn(`OpenAI ${path} fetch error attempt=${attempt}`, String(e));
    }
  }
  throw new Error(`OpenAI ${path} failed after retries: ${String(lastErr)}`);
}

export type ClientSecretResponse = {
  value: string;
  expires_at: number;
  session: { id: string; [k: string]: unknown };
};

export async function issueClientSecret(): Promise<ClientSecretResponse> {
  const res = await openaiFetch("/realtime/client_secrets", {
    method: "POST",
    body: JSON.stringify({
      expires_after: { anchor: "created_at", seconds: 600 },
      session: buildSessionConfig(),
    }),
  });
  return (await res.json()) as ClientSecretResponse;
}

export async function generateImage(prompt: string): Promise<Uint8Array> {
  const res = await openaiFetch("/images/generations", {
    method: "POST",
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt,
      n: 1,
      size: "1024x1024",
      quality: "low",
    }),
    retries: 1,
    timeoutMs: 60_000,
  });
  const data = (await res.json()) as { data: Array<{ b64_json: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI images: missing b64_json in response");
  return Buffer.from(b64, "base64");
}

export function buildImagePrompt(popis: string, nalada: string): string {
  const moodMap: Record<string, string> = {
    veselá: "joyful, bright colors, sunny",
    tajemná: "soft mystery, gentle shadows, magical",
    klidná: "calm, peaceful, serene",
    dobrodružná: "adventurous, energetic, dynamic",
  };
  const moodTag = moodMap[nalada] ?? "joyful";
  return `Watercolor illustration in the style of a soft Czech children's book, pastel palette, gentle brush strokes, no scary or violent elements, no text in the image, age-appropriate for a 6-year-old child. Subject: ${popis}. Mood: ${moodTag}.`;
}
