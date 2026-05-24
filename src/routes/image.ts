import { Hono } from "hono";
import { generateImage, buildImagePrompt, estimateImageUsd } from "../openai.ts";
import { cacheGet, cacheSet, putImage, getImageBytes } from "../storage.ts";
import { consumeNonce } from "../lib/nonces.ts";
import { dailyBudgetCheck, rateLimit, recordUsageUsd } from "../lib/ratelimit.ts";
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

function imageVariant(): string {
  return [
    process.env.IMAGE_MODEL || "gpt-image-2",
    process.env.IMAGE_SIZE || "1024x1024",
    process.env.IMAGE_QUALITY || "low",
    process.env.IMAGE_FORMAT || "jpeg",
  ].join("|");
}

function contentTypeForName(name: string): string {
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  return "image/png";
}

r.post("/api/image/generate", async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  const rl = await rateLimit("image", ip, 8, 60);
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

  const cacheKey = `imghash:v2:${hashKey(imageVariant() + "|" + normalize(popis) + "|" + nalada)}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    log.info(`image cache HIT key=${cacheKey}`);
    return c.json({ ok: true, url: `/api/image/${cached}`, cached: true });
  }

  const estimatedUsd = estimateImageUsd();
  const budget = await dailyBudgetCheck(estimatedUsd);
  if (!budget.allowed) {
    log.warn(
      `Image budget blocked: ${budget.usd.toFixed(3)} + ${estimatedUsd.toFixed(3)}/${budget.cap}`,
    );
    return c.json(
      { ok: false, reason: "budget_exceeded", usd: budget.usd, cap: budget.cap },
      429,
    );
  }

  log.info(`image cache MISS key=${cacheKey} popis="${popis.slice(0, 60)}"`);
  let image;
  try {
    image = await generateImage(buildImagePrompt(popis, nalada));
  } catch (e) {
    log.error("generateImage failed", String(e));
    return c.json({ ok: false, reason: "image_failed" }, 502);
  }

  const objectName = `${cacheKey.slice("imghash:v2:".length)}.${image.extension}`;
  try {
    await putImage(objectName, image.bytes, image.contentType);
  } catch (e) {
    log.error("putImage failed", String(e));
    return c.json({ ok: false, reason: "storage_failed" }, 500);
  }

  // 60 days — long enough for repeated story themes, short enough to bound S3 growth.
  await cacheSet(cacheKey, objectName, 60 * 60 * 24 * 60);
  await recordUsageUsd(image.estimatedUsd);

  return c.json({
    ok: true,
    url: `/api/image/${objectName}`,
    cached: false,
    model: image.model,
  });
});

r.get("/api/image/:name", async (c) => {
  const name = c.req.param("name");
  if (!/^[a-f0-9]{32,}\.(png|jpe?g|webp)$/.test(name)) {
    return c.json({ ok: false }, 400);
  }
  const bytes = await getImageBytes(name);
  if (!bytes) {
    return c.json({ ok: false, reason: "not_found" }, 404);
  }
  const body = (bytes.buffer as ArrayBuffer).slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  return new Response(body, {
    headers: {
      "Content-Type": contentTypeForName(name),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

export default r;
