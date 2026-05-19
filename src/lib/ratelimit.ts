import { cache } from "../storage.ts";
import { log } from "./redact.ts";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
};

// Buckets that must fail CLOSED when cache is unreachable — they gate spend.
// `session` may stay permissive (UX), but `image` and nonce checks must not.
const FAIL_CLOSED_BUCKETS = new Set(["image"]);

export async function rateLimit(
  bucket: string,
  identifier: string,
  capacity: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (!cache) {
    const allowed = !FAIL_CLOSED_BUCKETS.has(bucket);
    return { allowed, remaining: 0, resetSeconds: windowSeconds };
  }
  const key = `rl:${bucket}:${identifier}`;
  try {
    const raw = await cache.send("INCR", [key]);
    const count = typeof raw === "number" ? raw : Number(raw);
    if (count === 1) {
      await cache.send("EXPIRE", [key, String(windowSeconds)]);
    }
    const ttlRaw = await cache.send("TTL", [key]);
    const ttl = typeof ttlRaw === "number" ? ttlRaw : Number(ttlRaw);
    return {
      allowed: count <= capacity,
      remaining: Math.max(0, capacity - count),
      resetSeconds: ttl > 0 ? ttl : windowSeconds,
    };
  } catch (e) {
    log.warn(`rateLimit ${bucket} failed`, String(e));
    const allowed = !FAIL_CLOSED_BUCKETS.has(bucket);
    return { allowed, remaining: 0, resetSeconds: windowSeconds };
  }
}

export async function getDailyUsd(): Promise<number> {
  if (!cache) return 0;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = await cache.send("GET", [`usage:${today}`]);
    return raw ? parseFloat(String(raw)) : 0;
  } catch (e) {
    log.warn("getDailyUsd failed", String(e));
    return 0;
  }
}

export async function dailyBudgetCheck(): Promise<{
  allowed: boolean;
  usd: number;
  cap: number;
}> {
  const cap = parseFloat(process.env.DAILY_USD_BUDGET ?? "5");
  // Fail closed: if cache is down we can't track spend, so don't issue new sessions.
  if (!cache) return { allowed: false, usd: 0, cap };
  const usd = await getDailyUsd();
  return { allowed: usd < cap, usd, cap };
}

export async function recordUsageUsd(delta: number): Promise<number> {
  if (!cache || delta <= 0) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const key = `usage:${today}`;
  try {
    const raw = await cache.send("INCRBYFLOAT", [key, delta.toFixed(6)]);
    const next = typeof raw === "number" ? raw : parseFloat(String(raw));
    // Refresh TTL each write — Valkey doesn't auto-set on INCRBYFLOAT.
    await cache.send("EXPIRE", [key, String(60 * 60 * 26)]);
    return Number.isFinite(next) ? next : 0;
  } catch (e) {
    log.warn("recordUsageUsd failed", String(e));
    return 0;
  }
}
