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
  if (!cache) return true;
  if (!nonce || !/^[a-f0-9]{32}$/i.test(nonce)) return false;
  try {
    const raw = await cache.send("DECR", [`nonce:${nonce}`]);
    const remaining = typeof raw === "number" ? raw : Number(raw);
    if (remaining < 0) {
      await cache.send("SET", [`nonce:${nonce}`, "0", "EX", "60"]);
      return false;
    }
    return true;
  } catch (e) {
    log.warn("consumeNonce failed", String(e));
    return false;
  }
}
