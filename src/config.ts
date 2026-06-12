// Startup config validator. Catches the exact regression that produced
// "amálka má potíže" — env batch-set wiped OPENAI_API_KEY because it wasn't
// included in the snapshot. With this validator the service refuses to boot
// when a critical key is missing, so the failure is loud at deploy time
// instead of silent at first user click.

export const KNOWN_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;

export const KNOWN_REALTIME_MODELS = [
  "gpt-realtime",
  "gpt-realtime-2",
  "gpt-realtime-mini",
  "gpt-realtime-mini-2",
] as const;

export const KNOWN_IMAGE_MODELS = [
  "gpt-image-1",
  "gpt-image-1-mini",
  "gpt-image-1.5",
  "gpt-image-2",
] as const;

export const KNOWN_IMAGE_QUALITIES = ["low", "medium", "high"] as const;
export const KNOWN_IMAGE_FORMATS = ["jpeg", "jpg", "webp", "png"] as const;

export type ConfigProblem = {
  level: "fatal" | "warn";
  key: string;
  message: string;
};

export type ConfigReport = {
  ok: boolean;
  problems: ConfigProblem[];
  resolved: {
    realtimeModel: string;
    voice: string;
    imageModel: string;
    imageQuality: string;
    imageFormat: string;
    redis: boolean;
    s3: boolean;
  };
};

export function inspectConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConfigReport {
  const problems: ConfigProblem[] = [];

  const key = (env.OPENAI_API_KEY ?? "").trim();
  if (!key) {
    problems.push({
      level: "fatal",
      key: "OPENAI_API_KEY",
      message:
        "OPENAI_API_KEY is empty. Live service WILL return openai_unavailable on every session. Recovery: zerops_env action=set must include OPENAI_API_KEY in the FULL snapshot — set replaces, not upserts.",
    });
  } else if (!/^sk-[A-Za-z0-9_\-]{20,}$/.test(key)) {
    problems.push({
      level: "fatal",
      key: "OPENAI_API_KEY",
      message:
        "OPENAI_API_KEY does not match sk-* shape. Likely truncated or corrupted.",
    });
  }

  const voice = (env.AMALKA_VOICE ?? "marin").trim();
  if (!KNOWN_VOICES.includes(voice as (typeof KNOWN_VOICES)[number])) {
    problems.push({
      level: "warn",
      key: "AMALKA_VOICE",
      message: `AMALKA_VOICE='${voice}' is not in the known voice list (${KNOWN_VOICES.join(", ")}). OpenAI will reject the session if it isn't a real voice.`,
    });
  }

  const realtimeModel = (env.REALTIME_MODEL ?? "gpt-realtime-2").trim();
  if (
    !KNOWN_REALTIME_MODELS.includes(
      realtimeModel as (typeof KNOWN_REALTIME_MODELS)[number],
    )
  ) {
    problems.push({
      level: "warn",
      key: "REALTIME_MODEL",
      message: `REALTIME_MODEL='${realtimeModel}' is not in the known model list (${KNOWN_REALTIME_MODELS.join(", ")}). May be valid if OpenAI added a model — verify before alarming.`,
    });
  }

  const imageModel = (env.IMAGE_MODEL ?? "gpt-image-1-mini").trim();
  if (
    !KNOWN_IMAGE_MODELS.includes(
      imageModel as (typeof KNOWN_IMAGE_MODELS)[number],
    )
  ) {
    problems.push({
      level: "warn",
      key: "IMAGE_MODEL",
      message: `IMAGE_MODEL='${imageModel}' is not in the known image model list.`,
    });
  }

  const imageQuality = (env.IMAGE_QUALITY ?? "low").trim();
  if (
    !KNOWN_IMAGE_QUALITIES.includes(
      imageQuality as (typeof KNOWN_IMAGE_QUALITIES)[number],
    )
  ) {
    problems.push({
      level: "warn",
      key: "IMAGE_QUALITY",
      message: `IMAGE_QUALITY='${imageQuality}' is not low/medium/high.`,
    });
  }

  const imageFormat = (env.IMAGE_FORMAT ?? "jpeg").trim().toLowerCase();
  if (
    !KNOWN_IMAGE_FORMATS.includes(
      imageFormat as (typeof KNOWN_IMAGE_FORMATS)[number],
    )
  ) {
    problems.push({
      level: "warn",
      key: "IMAGE_FORMAT",
      message: `IMAGE_FORMAT='${imageFormat}' is not jpeg/webp/png.`,
    });
  }

  const redis = Boolean((env.REDIS_URL ?? "").trim());
  if (!redis) {
    problems.push({
      level: "warn",
      key: "REDIS_URL",
      message: "REDIS_URL not set — cache + rate-limit + nonce features are no-ops.",
    });
  }

  const s3 = Boolean(
    (env.S3_ENDPOINT ?? "").trim() &&
      (env.S3_BUCKET ?? "").trim() &&
      (env.S3_ACCESS_KEY_ID ?? "").trim() &&
      (env.S3_SECRET_ACCESS_KEY ?? "").trim(),
  );
  if (!s3) {
    problems.push({
      level: "warn",
      key: "S3",
      message: "S3 credentials incomplete — image storage will fail.",
    });
  }

  const ok = problems.every((p) => p.level !== "fatal");
  return {
    ok,
    problems,
    resolved: {
      realtimeModel,
      voice,
      imageModel,
      imageQuality,
      imageFormat,
      redis,
      s3,
    },
  };
}

export function assertConfigOrExit(
  report: ConfigReport,
  exitFn: (code: number) => never = (code) => process.exit(code) as never,
): void {
  for (const p of report.problems) {
    const prefix = p.level === "fatal" ? "[FATAL CONFIG]" : "[WARN CONFIG]";
    const line = `${prefix} ${p.key}: ${p.message}`;
    if (p.level === "fatal") console.error(line);
    else console.warn(line);
  }
  if (!report.ok) {
    console.error(
      "[FATAL CONFIG] refusing to start. Fix the fatal problems above and redeploy.",
    );
    exitFn(1);
  }
}
