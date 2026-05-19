import { cache } from "../storage.ts";
import { log } from "./redact.ts";

const NONCE_TTL_SECONDS = 60 * 35;

export async function issueNonce(maxImages: number): Promise<string> {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  if (!cache) return nonce;
  try {
    await cache.send("SET", [
      `nonce:${nonce}`,
      String(maxImages),
      "EX",
      String(NONCE_TTL_SECONDS),
    ]);
  } catch (e) {
    log.warn("issueNonce failed", String(e));
  }
  return nonce;
}

export async function consumeNonce(nonce: string): Promise<boolean> {
  // Fail closed: nonce gates paid image-gen. No cache = no nonce verification = reject.
  if (!cache) return false;
  if (!nonce || !/^[a-f0-9]{32}$/i.test(nonce)) return false;
  try {
    const key = `nonce:${nonce}`;
    // Atomic: only decrement if key exists AND value > 0.
    // EVAL avoids a TOCTOU between EXISTS/GET and DECR.
    const script = `
      local v = redis.call('GET', KEYS[1])
      if not v then return -1 end
      local n = tonumber(v)
      if n <= 0 then return -2 end
      return redis.call('DECR', KEYS[1])
    `;
    const raw = await cache.send("EVAL", [script, "1", key]);
    const remaining = typeof raw === "number" ? raw : Number(raw);
    return remaining >= 0;
  } catch (e) {
    log.warn("consumeNonce failed", String(e));
    return false;
  }
}
