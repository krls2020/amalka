import { Hono } from "hono";
import { generateImage, buildImagePrompt } from "../openai.ts";
import { cacheGet, cacheSet, putImage, getImageBytes } from "../storage.ts";
import { consumeNonce } from "../lib/nonces.ts";
import { rateLimit, recordUsageUsd } from "../lib/ratelimit.ts";
import { log } from "../lib/redact.ts";

const r = new Hono();

const VALID_MOODS = new Set(["veselá", "tajemná", "klidná", "dobrodružná"]);

function hashKey(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex");
}

function normalize(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

r.post("/api/image/generate", async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  const rl = await rateLimit("image", ip, 30, 60);
  if (!rl.allowed) {
    return c.json({ ok: false, reason: "rate_limited" }, 429);
  }

  let body: { popis?: string; nalada?: string; nonce?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, reason: "bad_request" }, 400);
  }

  const popis = (body.popis ?? "").slice(0, 400).trim();
  const nalada = (body.nalada ?? "veselá").trim();
  const nonce = body.nonce ?? "";

  if (!popis || !VALID_MOODS.has(nalada)) {
    return c.json({ ok: false, reason: "bad_input" }, 400);
  }

  const nonceOk = await consumeNonce(nonce);
  if (!nonceOk) {
    return c.json({ ok: false, reason: "invalid_nonce" }, 403);
  }

  const cacheKey = `imghash:v1:${hashKey(normalize(popis) + "|" + nalada)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    log.info(`image cache HIT key=${cacheKey}`);
    return c.json({ ok: true, url: `/api/image/${cached}`, cached: true });
  }

  log.info(`image cache MISS key=${cacheKey} popis="${popis.slice(0, 60)}"`);
  let bytes: Uint8Array;
  try {
    bytes = await generateImage(buildImagePrompt(popis, nalada));
  } catch (e) {
    log.error("generateImage failed", String(e));
    return c.json({ ok: false, reason: "image_failed" }, 502);
  }

  const objectName = `${cacheKey.slice("imghash:v1:".length)}.png`;
  try {
    await putImage(objectName, bytes);
  } catch (e) {
    log.error("putImage failed", String(e));
    return c.json({ ok: false, reason: "storage_failed" }, 500);
  }

  // 60 days — long enough for repeated story themes, short enough to bound S3 growth.
  await cacheSet(cacheKey, objectName, 60 * 60 * 24 * 60);
  // gpt-image-1 1024x1024: low ~$0.011, medium ~$0.042, high ~$0.167.
  const qualityCost: Record<string, number> = {
    low: 0.011,
    medium: 0.042,
    high: 0.167,
  };
  const q = (process.env.IMAGE_QUALITY || "low").toLowerCase();
  await recordUsageUsd(qualityCost[q] ?? 0.011);

  return c.json({
    ok: true,
    url: `/api/image/${objectName}`,
    cached: false,
  });
});

r.get("/api/image/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[a-f0-9]{32,}\.png$/.test(name)) {
    return c.json({ ok: false }, 400);
  }
  const bytes = await getImageBytes(name);
  if (!bytes) {
    return c.json({ ok: false, reason: "not_found" }, 404);
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

export default r;
