import { expect, test, describe } from "bun:test";
import { inspectConfig } from "../src/config.ts";

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    OPENAI_API_KEY: "sk-proj-" + "a".repeat(40),
    AMALKA_VOICE: "cedar",
    REALTIME_MODEL: "gpt-realtime-2",
    IMAGE_MODEL: "gpt-image-1-mini",
    IMAGE_QUALITY: "low",
    IMAGE_FORMAT: "jpeg",
    REDIS_URL: "redis://cache:6379",
    S3_ENDPOINT: "https://s3",
    S3_BUCKET: "imgstore",
    S3_ACCESS_KEY_ID: "AKIA",
    S3_SECRET_ACCESS_KEY: "secret",
    ...overrides,
  } as NodeJS.ProcessEnv;
}

describe("inspectConfig", () => {
  test("known-good config returns ok=true and no problems", () => {
    const r = inspectConfig(baseEnv());
    expect(r.ok).toBe(true);
    expect(r.problems).toHaveLength(0);
    expect(r.resolved.voice).toBe("cedar");
    expect(r.resolved.realtimeModel).toBe("gpt-realtime-2");
    expect(r.resolved.imageModel).toBe("gpt-image-1-mini");
  });

  test("empty OPENAI_API_KEY is fatal — this is the exact bug that wiped Amálka", () => {
    const r = inspectConfig(baseEnv({ OPENAI_API_KEY: "" }));
    expect(r.ok).toBe(false);
    const fatal = r.problems.find((p) => p.key === "OPENAI_API_KEY");
    expect(fatal?.level).toBe("fatal");
  });

  test("malformed OPENAI_API_KEY is fatal", () => {
    const r = inspectConfig(baseEnv({ OPENAI_API_KEY: "not-a-real-key" }));
    expect(r.ok).toBe(false);
    expect(
      r.problems.find((p) => p.key === "OPENAI_API_KEY")?.level,
    ).toBe("fatal");
  });

  test("unknown AMALKA_VOICE warns but does not block start", () => {
    const r = inspectConfig(baseEnv({ AMALKA_VOICE: "americanvoice" }));
    expect(r.ok).toBe(true);
    expect(
      r.problems.find((p) => p.key === "AMALKA_VOICE")?.level,
    ).toBe("warn");
  });

  test("unknown REALTIME_MODEL warns but does not block start", () => {
    const r = inspectConfig(baseEnv({ REALTIME_MODEL: "gpt-something-99" }));
    expect(r.ok).toBe(true);
    expect(
      r.problems.find((p) => p.key === "REALTIME_MODEL")?.level,
    ).toBe("warn");
  });

  test("unknown IMAGE_MODEL warns", () => {
    const r = inspectConfig(baseEnv({ IMAGE_MODEL: "gpt-image-future" }));
    expect(
      r.problems.find((p) => p.key === "IMAGE_MODEL")?.level,
    ).toBe("warn");
  });

  test("IMAGE_QUALITY outside low/medium/high warns", () => {
    const r = inspectConfig(baseEnv({ IMAGE_QUALITY: "ultra" }));
    expect(
      r.problems.find((p) => p.key === "IMAGE_QUALITY")?.level,
    ).toBe("warn");
  });

  test("missing REDIS_URL warns but is not fatal", () => {
    const r = inspectConfig(baseEnv({ REDIS_URL: "" }));
    expect(r.ok).toBe(true);
    expect(r.resolved.redis).toBe(false);
  });

  test("partial S3 credentials produce s3=false", () => {
    const r = inspectConfig(baseEnv({ S3_SECRET_ACCESS_KEY: "" }));
    expect(r.resolved.s3).toBe(false);
  });

  test("AMALKA_VOICE defaults to marin when unset", () => {
    const e = baseEnv();
    delete e.AMALKA_VOICE;
    const r = inspectConfig(e);
    expect(r.resolved.voice).toBe("marin");
  });

  test("voice cedar is in the known set (regression guard against accidental removal)", () => {
    const r = inspectConfig(baseEnv({ AMALKA_VOICE: "cedar" }));
    expect(r.problems.find((p) => p.key === "AMALKA_VOICE")).toBeUndefined();
  });

  test("voice marin is in the known set (so swap-back-and-forth doesn't fatal)", () => {
    const r = inspectConfig(baseEnv({ AMALKA_VOICE: "marin" }));
    expect(r.problems.find((p) => p.key === "AMALKA_VOICE")).toBeUndefined();
  });
});
