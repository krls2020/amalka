import { Hono } from "hono";
import { issueClientSecret } from "../openai.ts";
import { rateLimit, dailyBudgetCheck } from "../lib/ratelimit.ts";
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

r.post("/api/session/end", async (c) => {
  let body: { sessionId?: string; usageUsd?: number } = {};
  try {
    body = await c.req.json();
  } catch {}
  if (body.sessionId) {
    log.info(`session end sessionId=${body.sessionId} usd=${body.usageUsd ?? 0}`);
  }
  return c.json({ ok: true });
});

export default r;
