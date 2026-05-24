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

export async function issueClientSecret(
  safetyIdentifier?: string,
): Promise<ClientSecretResponse> {
  const headers: Record<string, string> = {};
  if (safetyIdentifier) headers["OpenAI-Safety-Identifier"] = safetyIdentifier;
  const res = await openaiFetch("/realtime/client_secrets", {
    method: "POST",
    headers,
    body: JSON.stringify({
      session: buildSessionConfig(),
    }),
  });
  return (await res.json()) as ClientSecretResponse;
}

const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-2";
const IMAGE_SIZE = process.env.IMAGE_SIZE || "1024x1024";
const IMAGE_QUALITY = process.env.IMAGE_QUALITY || "low";
const IMAGE_FORMAT = (process.env.IMAGE_FORMAT || "jpeg").toLowerCase();
const IMAGE_COMPRESSION = Number(process.env.IMAGE_COMPRESSION ?? "72");

function normalizedImageFormat(): "jpeg" | "webp" | "png" {
  if (IMAGE_FORMAT === "jpg" || IMAGE_FORMAT === "jpeg") return "jpeg";
  if (IMAGE_FORMAT === "webp") return "webp";
  return "png";
}

export type GeneratedImage = {
  bytes: Uint8Array;
  contentType: string;
  extension: "jpg" | "webp" | "png";
  estimatedUsd: number;
  model: string;
  quality: string;
  size: string;
  format: "jpeg" | "webp" | "png";
};

export function estimateImageUsd(
  model = IMAGE_MODEL,
  quality = IMAGE_QUALITY,
  size = IMAGE_SIZE,
): number {
  const key = `${model}|${quality}|${size}`.toLowerCase();
  const costs: Record<string, number> = {
    "gpt-image-2|low|1024x1024": 0.006,
    "gpt-image-2|medium|1024x1024": 0.053,
    "gpt-image-2|high|1024x1024": 0.211,
    "gpt-image-1.5|low|1024x1024": 0.009,
    "gpt-image-1.5|medium|1024x1024": 0.034,
    "gpt-image-1.5|high|1024x1024": 0.133,
    "gpt-image-1|low|1024x1024": 0.011,
    "gpt-image-1|medium|1024x1024": 0.042,
    "gpt-image-1|high|1024x1024": 0.167,
    "gpt-image-1-mini|low|1024x1024": 0.005,
    "gpt-image-1-mini|medium|1024x1024": 0.011,
    "gpt-image-1-mini|high|1024x1024": 0.036,
  };
  return costs[key] ?? (quality === "high" ? 0.211 : quality === "medium" ? 0.053 : 0.006);
}

export async function generateImage(prompt: string): Promise<GeneratedImage> {
  const format = normalizedImageFormat();
  const body: Record<string, unknown> = {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    size: IMAGE_SIZE,
    quality: IMAGE_QUALITY,
  };
  if (format !== "png") {
    body.output_format = format;
    if (Number.isFinite(IMAGE_COMPRESSION)) {
      body.output_compression = Math.min(100, Math.max(0, IMAGE_COMPRESSION));
    }
  }
  const res = await openaiFetch("/images/generations", {
    method: "POST",
    body: JSON.stringify(body),
    retries: 1,
    timeoutMs: 90_000,
  });
  const data = (await res.json()) as { data: Array<{ b64_json: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI images: missing b64_json in response");
  return {
    bytes: Buffer.from(b64, "base64"),
    contentType: format === "png" ? "image/png" : `image/${format}`,
    extension: format === "jpeg" ? "jpg" : format,
    estimatedUsd: estimateImageUsd(IMAGE_MODEL, IMAGE_QUALITY, IMAGE_SIZE),
    model: IMAGE_MODEL,
    quality: IMAGE_QUALITY,
    size: IMAGE_SIZE,
    format,
  };
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
    "Warm hand-painted Czech picture-book illustration, watercolor washes, fine ink linework, textured paper, clear simple composition.",
    "Palette: resonant but gentle, jewel-tone accents with warm neutrals, atmospheric light and depth without clutter.",
    "Suggested rather than over-detailed: leave painterly space for imagination. Characters are warm and individual, not big-eyed, not flat vector style.",
    "Avoid: flat vector cartoon, big-eyed saccharine character design, candy pastel uniformity, soft-lit safe sweetness, Pixar/Disney styling, generic kids'-book art, photoreal rendering, 3D look.",
    "Wholesome and safe: never scary, violent, or unsettling; all characters kind and inviting. No text, no letters, no captions, no signage anywhere in the image.",
    `Subject: ${popis}.`,
    `Mood and light: ${moodTag}.`,
  ].join(" ");
}
