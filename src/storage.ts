import { RedisClient, S3Client } from "bun";
import { log } from "./lib/redact.ts";

const REDIS_URL = process.env.REDIS_URL;
const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_BUCKET = process.env.S3_BUCKET;
const S3_KEY = process.env.S3_ACCESS_KEY_ID;
const S3_SECRET = process.env.S3_SECRET_ACCESS_KEY;

if (!REDIS_URL) log.warn("REDIS_URL not set — cache features will be no-ops");
if (!S3_ENDPOINT || !S3_BUCKET) log.warn("S3 env not fully set");

export const cache: RedisClient | null = REDIS_URL
  ? new RedisClient(REDIS_URL)
  : null;

export const s3: S3Client | null =
  S3_ENDPOINT && S3_BUCKET && S3_KEY && S3_SECRET
    ? new S3Client({
        endpoint: S3_ENDPOINT,
        accessKeyId: S3_KEY,
        secretAccessKey: S3_SECRET,
        bucket: S3_BUCKET,
        region: "us-east-1",
      })
    : null;

export async function cacheGet(key: string): Promise<string | null> {
  if (!cache) return null;
  try {
    return await cache.get(key);
  } catch (e) {
    log.warn(`cacheGet ${key} failed`, String(e));
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<void> {
  if (!cache) return;
  try {
    if (ttlSeconds && ttlSeconds > 0) {
      await cache.set(key, value, "EX", ttlSeconds);
    } else {
      await cache.set(key, value);
    }
  } catch (e) {
    log.warn(`cacheSet ${key} failed`, String(e));
  }
}

export async function cacheIncrFloat(
  key: string,
  delta: number,
  ttlSeconds?: number,
): Promise<number> {
  if (!cache) return 0;
  try {
    const cur = (await cache.get(key)) ?? "0";
    const next = parseFloat(cur) + delta;
    if (ttlSeconds && ttlSeconds > 0) {
      await cache.set(key, next.toString(), "EX", ttlSeconds);
    } else {
      await cache.set(key, next.toString());
    }
    return next;
  } catch (e) {
    log.warn(`cacheIncrFloat ${key} failed`, String(e));
    return 0;
  }
}

export async function putImage(
  key: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<void> {
  if (!s3) throw new Error("S3 not configured");
  const file = s3.file(key);
  await file.write(bytes, { type: contentType });
}

export async function getImageBytes(key: string): Promise<Uint8Array | null> {
  if (!s3) return null;
  try {
    const file = s3.file(key);
    const exists = await file.exists();
    if (!exists) return null;
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  } catch (e) {
    log.warn(`getImageBytes ${key} failed`, String(e));
    return null;
  }
}
