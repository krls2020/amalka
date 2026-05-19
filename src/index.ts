import { Hono } from "hono";
import { cors } from "hono/cors";
import { log } from "./lib/redact.ts";
import { cache, cacheIncrFloat } from "./storage.ts";
import sessionRoutes from "./routes/session.ts";
import imageRoutes from "./routes/image.ts";

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
  const usd = await cacheIncrFloat(`usage:${today}`, 0);
  return c.json({ ok: true, date: today, usd });
});

const PUBLIC_DIR = "./public";

async function tryServeStatic(path: string): Promise<Response | null> {
  const safe = path.replace(/\.\.+/g, "").replace(/^\/+/, "");
  const file = Bun.file(`${PUBLIC_DIR}/${safe || "index.html"}`);
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
