import { cache } from "../storage.ts";
import { log } from "./redact.ts";

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  resetSeconds: number;
};

export async function rateLimit(
  bucket: string,
  identifier: string,
  capacity: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (!cache) {
    return { allowed: true, remaining: capacity, resetSeconds: windowSeconds };
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
    return { allowed: true, remaining: capacity, resetSeconds: windowSeconds };
  }
}

export async function dailyBudgetCheck(): Promise<{
  allowed: boolean;
  usd: number;
  cap: number;
}> {
  const cap = parseFloat(process.env.DAILY_USD_BUDGET ?? "5");
  if (!cache) return { allowed: true, usd: 0, cap };
  const today = new Date().toISOString().slice(0, 10);
  try {
    const raw = await cache.send("GET", [`usage:${today}`]);
    const usd = raw ? parseFloat(String(raw)) : 0;
    return { allowed: usd < cap, usd, cap };
  } catch (e) {
    log.warn("dailyBudgetCheck failed", String(e));
    return { allowed: true, usd: 0, cap };
  }
}

export async function recordUsageUsd(delta: number): Promise<void> {
  if (!cache) return;
  const today = new Date().toISOString().slice(0, 10);
  try {
    const cur = (await cache.send("GET", [`usage:${today}`])) as string | null;
    const next = (cur ? parseFloat(cur) : 0) + delta;
    await cache.send("SET", [
      `usage:${today}`,
      next.toFixed(6),
      "EX",
      String(60 * 60 * 26),
    ]);
  } catch (e) {
    log.warn("recordUsageUsd failed", String(e));
  }
}
