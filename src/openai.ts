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
      // low ($0.011) carries the new magical prompt well enough. Bump to
      // medium ($0.042) per-deploy via IMAGE_QUALITY=medium if Anežka wants
      // crisper detail on a particular run.
      quality: process.env.IMAGE_QUALITY || "low",
    }),
    retries: 1,
    timeoutMs: 90_000,
  });
  const data = (await res.json()) as { data: Array<{ b64_json: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI images: missing b64_json in response");
  return Buffer.from(b64, "base64");
}

export function buildImagePrompt(popis: string, nalada: string): string {
  const moodMap: Record<string, string> = {
    veselá:
      "warm late-afternoon sun, resonant saturated colors (not sugary), a single bold light source casting long gentle shadows",
    tajemná:
      "deep moonlit blues with warm amber accents from a lantern or firefly, painterly mist, a sense of quiet wonder",
    klidná:
      "predawn or dusk, low contrast, muted painterly palette, peaceful stillness, breath of mist",
    dobrodružná:
      "cinematic golden hour from a low angle, dynamic composition, distant horizon, a feeling of being on the cusp of something",
  };
  const moodTag = moodMap[nalada] ?? moodMap["veselá"];
  return [
    "Painterly art-book illustration — closer to a fine-art picture book for older readers than a cute kids' cartoon. Hand-painted feel: visible watercolor washes, fine ink linework, painterly texture, slight imperfection of brush strokes.",
    "Style references: the poetic atmospheric illustrations of Pavel Čech (Czech), Carson Ellis's folk-tale palette, Lorenzo Mattotti's softer color work, Pascal Campion's small-moment cinematography, Studio Ghibli background paintings. Composition is confident and simple, painted with rich texture.",
    "Palette: restrained but resonant — jewel-tone accents grounded by warm neutrals, not generic pastel-uniform sweetness. Strong atmosphere and depth from layered light, not from heavy detail.",
    "Suggested rather than over-detailed: leave painterly space for imagination. Characters are warm and individual, not big-eyed Disney-cute, not flat vector style, not generic stock-illustration look.",
    "Avoid: flat vector cartoon, big-eyed saccharine character design, candy pastel uniformity, soft-lit safe sweetness, Pixar/Disney styling, generic kids'-book art, photoreal rendering, 3D look.",
    "Wholesome and safe: never scary, violent, or unsettling; all characters kind and inviting. No text, no letters, no captions, no signage anywhere in the image.",
    `Subject: ${popis}.`,
    `Mood and light: ${moodTag}.`,
  ].join(" ");
}
