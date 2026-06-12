import { Hono } from "hono";
import { issueClientSecret } from "../openai.ts";
import {
  REALTIME_MODEL,
  responsePatienceMs,
  vadCreatesResponse,
} from "../persona.ts";
import {
  rateLimit,
  dailyBudgetCheck,
  recordUsageUsd,
} from "../lib/ratelimit.ts";
import { issueNonce, issueUsageKey, validateUsageKey } from "../lib/nonces.ts";
import { log } from "../lib/redact.ts";

const r = new Hono();

const MAX_SESSIONS_PER_DAY = 30;
// The persona now draws at most once per story. Three images is enough for a
// normal child session and caps accidental tool loops.
const MAX_IMAGES_PER_SESSION = Number(
  process.env.MAX_IMAGES_PER_SESSION ?? "3",
);
const CLIENT_SECRET_SAFETY_SECONDS = 30;

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
    const usageKey = sessionId ? await issueUsageKey(sessionId) : null;
    // Realtime WebRTC sessions can run up to ~60 min; the client_secret
    // is only needed for the initial SDP handshake. Don't cap the
    // session at token TTL — that's what was hard-cutting Anežka at 9.5 min
    // mid-story. Cap only at the configured MAX_SESSION_MINUTES (default 30).
    const configuredMaxSeconds = Math.max(
      60,
      Number(process.env.MAX_SESSION_MINUTES ?? "30") * 60,
    );
    const maxSessionSeconds = configuredMaxSeconds;
    log.info(`session issued sessionId=${sessionId} ip=${ip} model=${REALTIME_MODEL}`);
    return c.json({
      ok: true,
      clientSecret: secret.value,
      expiresAt: secret.expires_at,
      sessionId,
      usageKey,
      nonce,
      model: REALTIME_MODEL,
      maxImages: MAX_IMAGES_PER_SESSION,
      maxSessionSeconds,
      maxSessionMinutes: Math.max(1, Math.floor(maxSessionSeconds / 60)),
      // Turn-taking contract: when serverCreatesResponse is false the client
      // owns response.create and waits patienceMs after speech_stopped, so a
      // mid-sentence thinking pause doesn't trigger an answer.
      patienceMs: responsePatienceMs(),
      serverCreatesResponse: vadCreatesResponse(),
    });
  } catch (e) {
    log.error("issueClientSecret failed", String(e));
    return c.json({ ok: false, reason: "openai_unavailable" }, 503);
  }
});

// Realtime pricing per 1M tokens (USD). Override via env if OpenAI changes rates.
function defaultRealtimePrices(model: string) {
  const m = model.toLowerCase();
  if (m.includes("mini")) {
    return {
      inText: 0.6,
      outText: 2.4,
      inAudio: 10,
      outAudio: 20,
      cachedInText: 0.06,
      cachedInAudio: 0.3,
    };
  }
  if (m.includes("1.5")) {
    return {
      inText: 4,
      outText: 16,
      inAudio: 32,
      outAudio: 64,
      cachedInText: 0.4,
      cachedInAudio: 0.4,
    };
  }
  return {
    inText: 4,
    outText: 24,
    inAudio: 32,
    outAudio: 64,
    cachedInText: 0.4,
    cachedInAudio: 0.4,
  };
}

const DEFAULT_PRICE_PER_M = defaultRealtimePrices(REALTIME_MODEL);
const PRICE_PER_M = {
  inText: Number(process.env.PRICE_REALTIME_IN_TEXT ?? DEFAULT_PRICE_PER_M.inText),
  outText: Number(process.env.PRICE_REALTIME_OUT_TEXT ?? DEFAULT_PRICE_PER_M.outText),
  inAudio: Number(process.env.PRICE_REALTIME_IN_AUDIO ?? DEFAULT_PRICE_PER_M.inAudio),
  outAudio: Number(process.env.PRICE_REALTIME_OUT_AUDIO ?? DEFAULT_PRICE_PER_M.outAudio),
  cachedInText: Number(
    process.env.PRICE_REALTIME_CACHED_IN_TEXT ?? DEFAULT_PRICE_PER_M.cachedInText,
  ),
  cachedInAudio: Number(
    process.env.PRICE_REALTIME_CACHED_IN_AUDIO ?? DEFAULT_PRICE_PER_M.cachedInAudio,
  ),
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
  usageKey?: string;
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
  const cachedText = Math.min(
    inText,
    Math.max(0, Number(cDet.text_tokens ?? cachedTotal)),
  );
  const cachedAudio = Math.min(
    inAudio,
    Math.max(0, Number(cDet.audio_tokens ?? Math.max(0, cachedTotal - cachedText))),
  );
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
const USAGE_CALL_CEILING_USD = Number(process.env.USAGE_CALL_CEILING_USD ?? "0.25");

r.post("/api/session/usage", async (c) => {
  let body: UsageBody = {};
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, reason: "bad_request" }, 400);
  }
  if (!(await validateUsageKey(body.sessionId, body.usageKey))) {
    return c.json({ ok: false, reason: "invalid_usage_key" }, 403);
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
