import { Hono } from "hono";
import { cors } from "hono/cors";
import { resolve, sep } from "node:path";
import { log } from "./lib/redact.ts";
import { cache, s3 } from "./storage.ts";
import { getDailyUsd } from "./lib/ratelimit.ts";
import sessionRoutes from "./routes/session.ts";
import imageRoutes from "./routes/image.ts";
import { inspectConfig, assertConfigOrExit } from "./config.ts";

const configReport = inspectConfig();
assertConfigOrExit(configReport);

const app = new Hono();

const APP_URL = process.env.APP_URL ?? "";
const PORT = Number(process.env.PORT) || 3000;

const ALLOWED_ORIGINS = new Set<string>(
  [APP_URL, "http://localhost:3000", "http://localhost:5173"].filter(Boolean),
);

app.use(
  "/api/*",
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : null),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    credentials: false,
  }),
);

app.use("/*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "microphone=(self), camera=()");
  c.header(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' https://api.openai.com https://*.openai.com wss://*.openai.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join("; "),
  );
  await next();
});

app.get("/api/health", async (c) => {
  let cacheOk = false;
  try {
    if (cache) {
      const pong = await cache.send("PING", []);
      cacheOk = typeof pong === "string" && pong.toUpperCase() === "PONG";
    }
  } catch {
    cacheOk = false;
  }
  return c.json({
    ok: true,
    ts: Date.now(),
    cache: cacheOk,
    appUrl: APP_URL || null,
  });
});

app.route("/", sessionRoutes);
app.route("/", imageRoutes);

app.get("/api/debug/usage", async (c) => {
  const key = c.req.query("key");
  if (!key || key !== process.env.DEBUG_KEY) {
    return c.json({ ok: false }, 401);
  }
  const today = new Date().toISOString().slice(0, 10);
  const usd = await getDailyUsd();
  return c.json({ ok: true, date: today, usd });
});

// Deep health surfaces the exact set of things that caused recent regressions:
// empty OPENAI_API_KEY, unknown voice/model, Valkey unreachable, S3 unreachable.
// Gated by DEBUG_KEY so it can't be scraped for inventory. Returns 200 with
// per-check status even when degraded — caller decides what to do.
app.get("/api/health/deep", async (c) => {
  const key = c.req.query("key");
  if (!key || key !== process.env.DEBUG_KEY) {
    return c.json({ ok: false }, 401);
  }
  const report = inspectConfig();
  let cacheStatus: "ok" | "error" | "disabled" = "disabled";
  if (cache) {
    try {
      const pong = await cache.send("PING", []);
      cacheStatus =
        typeof pong === "string" && pong.toUpperCase() === "PONG"
          ? "ok"
          : "error";
    } catch {
      cacheStatus = "error";
    }
  }
  let storageStatus: "ok" | "error" | "disabled" = "disabled";
  if (s3) {
    try {
      await s3.file(".healthprobe").exists();
      storageStatus = "ok";
    } catch {
      storageStatus = "error";
    }
  }
  return c.json({
    ok: report.ok && cacheStatus !== "error" && storageStatus !== "error",
    config: report,
    cache: cacheStatus,
    storage: storageStatus,
  });
});

const PUBLIC_DIR = resolve("./public");

async function tryServeStatic(path: string): Promise<Response | null> {
  const cleaned = path.replace(/^\/+/, "") || "index.html";
  const target = resolve(PUBLIC_DIR, cleaned);
  // Reject anything resolving outside PUBLIC_DIR (defense against ../ tricks).
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    return null;
  }
  const file = Bun.file(target);
  if (await file.exists()) {
    return new Response(file);
  }
  return null;
}

const LANDING_FALLBACK = `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>Amálka</title>
<style>
  html,body{margin:0;background:linear-gradient(180deg,#FFF6EC,#FCE7E0);font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:#5C8FA8;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
  h1{font-size:32px;margin:0 0 8px;color:#F4B5C1}
  p{margin:4px 0}
</style>
</head>
<body>
<div>
<h1>Amálka se připravuje 🤖</h1>
<p>Backend běží.</p>
<p style="font-size:13px;opacity:.7">API health: <code>/api/health</code></p>
</div>
</body>
</html>`;

app.get("/", async (c) => {
  const r = await tryServeStatic("index.html");
  if (r) return r;
  return c.html(LANDING_FALLBACK);
});

app.get("/assets/*", async (c) => {
  const r = await tryServeStatic(c.req.path);
  return r ?? c.notFound();
});

app.get("/manifest.webmanifest", async (c) => {
  const r = await tryServeStatic("manifest.webmanifest");
  return r ?? c.notFound();
});

app.get("/sw.js", async (c) => {
  const r = await tryServeStatic("sw.js");
  return r ?? c.notFound();
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ ok: false }, 404);
  return c.html(LANDING_FALLBACK);
});

log.info(`Amálka API booting on 0.0.0.0:${PORT}`);

export default {
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
};
