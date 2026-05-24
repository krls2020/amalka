import { Hono } from "hono";
import { issueClientSecret } from "../openai.ts";
import { REALTIME_MODEL } from "../persona.ts";
import {
  rateLimit,
  dailyBudgetCheck,
  recordUsageUsd,
} from "../lib/ratelimit.ts";
import { issueNonce } from "../lib/nonces.ts";
import { log } from "../lib/redact.ts";

const r = new Hono();

const MAX_SESSIONS_PER_DAY = 30;
// Persona calls nakresli_obrazek 1-2× per story; 6 is generous headroom for
// a few stories per session while capping worst-case spend.
const MAX_IMAGES_PER_SESSION = Number(
  process.env.MAX_IMAGES_PER_SESSION ?? "6",
);

function hashIp(ip: string): string {
  return new Bun.CryptoHasher("sha256").update(ip).digest("hex").slice(0, 16);
}

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
    const secret = await issueClientSecret(`amalka-${hashIp(ip)}`);
    const nonce = await issueNonce(MAX_IMAGES_PER_SESSION);
    const sessionId = secret.session?.id ?? null;
    log.info(`session issued sessionId=${sessionId} ip=${ip} model=${REALTIME_MODEL}`);
    return c.json({
      ok: true,
      clientSecret: secret.value,
      expiresAt: secret.expires_at,
      sessionId,
      nonce,
      model: REALTIME_MODEL,
      maxImages: MAX_IMAGES_PER_SESSION,
      maxSessionMinutes: Number(process.env.MAX_SESSION_MINUTES ?? "30"),
    });
  } catch (e) {
    log.error("issueClientSecret failed", String(e));
    return c.json({ ok: false, reason: "openai_unavailable" }, 503);
  }
});

// Realtime pricing per 1M tokens (USD). Override via env if OpenAI changes rates.
// Defaults: gpt-realtime-mini (current GA cost-efficient model). Full audio/text
// rates match gpt-4o-mini-realtime-preview; cached_in drops from $0.30 to $0.06.
// Flagship gpt-realtime is roughly 3× higher — override via PRICE_REALTIME_* envs
// when REALTIME_MODEL points there.
const PRICE_PER_M = {
  inText: Number(process.env.PRICE_REALTIME_IN_TEXT ?? "0.6"),
  outText: Number(process.env.PRICE_REALTIME_OUT_TEXT ?? "2.4"),
  inAudio: Number(process.env.PRICE_REALTIME_IN_AUDIO ?? "10"),
  outAudio: Number(process.env.PRICE_REALTIME_OUT_AUDIO ?? "20"),
  cachedInText: Number(process.env.PRICE_REALTIME_CACHED_IN_TEXT ?? "0.06"),
  cachedInAudio: Number(process.env.PRICE_REALTIME_CACHED_IN_AUDIO ?? "0.3"),
};

type CachedDetails = {
  text_tokens?: number;
  audio_tokens?: number;
};
type UsageDetails = {
  text_tokens?: number;
  audio_tokens?: number;
  image_tokens?: number;
};
type UsageBody = {
  sessionId?: string;
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: UsageDetails & {
    cached_tokens?: number;
    cached_tokens_details?: CachedDetails;
  };
  output_token_details?: UsageDetails;
};

function usdFromUsage(u: UsageBody): number {
  const inDet = u.input_token_details ?? {};
  const outDet = u.output_token_details ?? {};
  const inText = Math.max(0, Number(inDet.text_tokens ?? 0));
  const inAudio = Math.max(0, Number(inDet.audio_tokens ?? 0));
  const outText = Math.max(0, Number(outDet.text_tokens ?? 0));
  const outAudio = Math.max(0, Number(outDet.audio_tokens ?? 0));
  // Per-modality cache split (new payload shape). Fall back to legacy
  // single cached_tokens applied to text bucket when details are missing.
  const cDet = inDet.cached_tokens_details ?? {};
  const cachedTotal = Math.max(0, Number(inDet.cached_tokens ?? 0));
  const cachedText = Math.max(0, Number(cDet.text_tokens ?? cachedTotal));
  const cachedAudio = Math.max(0, Number(cDet.audio_tokens ?? 0));
  const uncachedInText = Math.max(0, inText - cachedText);
  const uncachedInAudio = Math.max(0, inAudio - cachedAudio);
  const usd =
    (uncachedInText * PRICE_PER_M.inText +
      cachedText * PRICE_PER_M.cachedInText +
      uncachedInAudio * PRICE_PER_M.inAudio +
      cachedAudio * PRICE_PER_M.cachedInAudio +
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
  // NOTE: usage is already billed per-turn via /api/session/usage on every
  // response.done event. The end-of-session beacon used to re-bill the
  // accumulated total — that double-counted everything. Now end is just
  // a lifecycle marker; no recordUsageUsd call here.
  let body: UsageBody = {};
  try {
    body = await c.req.json();
  } catch {}
  if (body.sessionId) {
    log.info(`session end sessionId=${body.sessionId}`);
  }
  return c.json({ ok: true });
});

export default r;
