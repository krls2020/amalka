import { Hono } from "hono";
import { issueClientSecret } from "../openai.ts";
import {
  rateLimit,
  dailyBudgetCheck,
  recordUsageUsd,
} from "../lib/ratelimit.ts";
import { issueNonce } from "../lib/nonces.ts";
import { log } from "../lib/redact.ts";

const r = new Hono();

const MAX_SESSIONS_PER_DAY = 30;
const MAX_IMAGES_PER_SESSION = Number(
  process.env.MAX_IMAGES_PER_SESSION ?? "30",
);

r.post("/api/realtime/session", async (c) => {
  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  const rl = await rateLimit("session", ip, MAX_SESSIONS_PER_DAY, 60 * 60 * 24);
  if (!rl.allowed) {
    return c.json(
      { ok: false, reason: "rate_limited", resetSeconds: rl.resetSeconds },
      429,
    );
  }

  const budget = await dailyBudgetCheck();
  if (!budget.allowed) {
    log.warn(`Daily budget exceeded: ${budget.usd.toFixed(2)}/${budget.cap}`);
    return c.json(
      { ok: false, reason: "budget_exceeded", usd: budget.usd, cap: budget.cap },
      429,
    );
  }

  try {
    const secret = await issueClientSecret();
    const nonce = await issueNonce(MAX_IMAGES_PER_SESSION);
    const sessionId = secret.session?.id ?? null;
    log.info(`session issued sessionId=${sessionId} ip=${ip}`);
    return c.json({
      ok: true,
      clientSecret: secret.value,
      expiresAt: secret.expires_at,
      sessionId,
      nonce,
      maxImages: MAX_IMAGES_PER_SESSION,
      maxSessionMinutes: Number(process.env.MAX_SESSION_MINUTES ?? "30"),
    });
  } catch (e) {
    log.error("issueClientSecret failed", String(e));
    return c.json({ ok: false, reason: "openai_unavailable" }, 503);
  }
});

// Realtime pricing per 1M tokens (USD). Override via env if OpenAI changes rates.
// Defaults track gpt-realtime public pricing as of 2026-05.
const PRICE_PER_M = {
  inText: Number(process.env.PRICE_REALTIME_IN_TEXT ?? "4"),
  outText: Number(process.env.PRICE_REALTIME_OUT_TEXT ?? "16"),
  inAudio: Number(process.env.PRICE_REALTIME_IN_AUDIO ?? "32"),
  outAudio: Number(process.env.PRICE_REALTIME_OUT_AUDIO ?? "64"),
  cachedIn: Number(process.env.PRICE_REALTIME_CACHED_IN ?? "0.4"),
};

type UsageDetails = {
  text_tokens?: number;
  audio_tokens?: number;
};
type UsageBody = {
  sessionId?: string;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: UsageDetails & { cached_tokens?: number };
  output_token_details?: UsageDetails;
};

function usdFromUsage(u: UsageBody): number {
  const inDet = u.input_token_details ?? {};
  const outDet = u.output_token_details ?? {};
  const cachedIn = Math.max(0, Number(inDet.cached_tokens ?? 0));
  const inText = Math.max(0, Number(inDet.text_tokens ?? 0));
  const inAudio = Math.max(0, Number(inDet.audio_tokens ?? 0));
  const outText = Math.max(0, Number(outDet.text_tokens ?? 0));
  const outAudio = Math.max(0, Number(outDet.audio_tokens ?? 0));
  // Cached tokens replace text-input for the cached portion at a lower rate.
  const uncachedInText = Math.max(0, inText - cachedIn);
  const usd =
    (uncachedInText * PRICE_PER_M.inText +
      cachedIn * PRICE_PER_M.cachedIn +
      inAudio * PRICE_PER_M.inAudio +
      outText * PRICE_PER_M.outText +
      outAudio * PRICE_PER_M.outAudio) /
    1_000_000;
  return Number.isFinite(usd) ? usd : 0;
}

// Hard ceiling per-call to prevent a malicious client from inflating the meter.
// Even a worst-case 1-min Realtime turn at full volume is well under $1.
const USAGE_CALL_CEILING_USD = 1.0;

r.post("/api/session/usage", async (c) => {
  let body: UsageBody = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, reason: "bad_request" }, 400);
  }
  const usd = Math.min(USAGE_CALL_CEILING_USD, usdFromUsage(body));
  if (usd <= 0) return c.json({ ok: true, usd: 0 });
  const total = await recordUsageUsd(usd);
  const budget = await dailyBudgetCheck();
  return c.json({
    ok: true,
    usd,
    total,
    overBudget: !budget.allowed,
    cap: budget.cap,
  });
});

r.post("/api/session/end", async (c) => {
  let body: UsageBody = {};
  try {
    body = await c.req.json();
  } catch {}
  if (body.sessionId) {
    const finalUsd = Math.min(USAGE_CALL_CEILING_USD, usdFromUsage(body));
    if (finalUsd > 0) await recordUsageUsd(finalUsd);
    log.info(`session end sessionId=${body.sessionId} finalUsd=${finalUsd.toFixed(4)}`);
  }
  return c.json({ ok: true });
});

export default r;
