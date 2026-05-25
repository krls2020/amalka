import { expect, test, describe } from "bun:test";
import { buildImagePrompt, estimateImageUsd } from "../src/openai.ts";

describe("buildImagePrompt", () => {
  test("includes the subject from popis", () => {
    const p = buildImagePrompt(
      "jednorožec na louce s duhou",
      "veselá",
    );
    expect(p).toContain("jednorožec na louce s duhou");
  });

  test("maps each known mood to its own light/palette tag", () => {
    const moods = ["veselá", "tajemná", "klidná", "dobrodružná"];
    const tags = moods.map((m) => buildImagePrompt("test", m));
    const uniqueTags = new Set(tags);
    expect(uniqueTags.size).toBe(moods.length);
  });

  test("unknown mood falls back to veselá (no crash)", () => {
    const p = buildImagePrompt("test", "neznámá nálada");
    const veselá = buildImagePrompt("test", "veselá");
    expect(p).toBe(veselá);
  });

  test("forbids text/letters in image (safety invariant for child UI)", () => {
    const p = buildImagePrompt("test", "veselá");
    expect(p.toLowerCase()).toContain("no text");
  });

  test("rejects scary/violent rendering (safety invariant)", () => {
    const p = buildImagePrompt("test", "veselá");
    expect(p.toLowerCase()).toContain("never scary");
  });
});

describe("estimateImageUsd", () => {
  test("known models return non-zero positive cost", () => {
    const combos = [
      ["gpt-image-2", "low"],
      ["gpt-image-2", "medium"],
      ["gpt-image-2", "high"],
      ["gpt-image-1.5", "low"],
      ["gpt-image-1.5", "medium"],
      ["gpt-image-1.5", "high"],
      ["gpt-image-1", "low"],
      ["gpt-image-1", "medium"],
      ["gpt-image-1", "high"],
      ["gpt-image-1-mini", "low"],
      ["gpt-image-1-mini", "medium"],
      ["gpt-image-1-mini", "high"],
    ];
    for (const [model, quality] of combos) {
      const usd = estimateImageUsd(model, quality, "1024x1024");
      expect(usd).toBeGreaterThan(0);
    }
  });

  test("gpt-image-1-mini low is the cheapest among low qualities", () => {
    const mini = estimateImageUsd("gpt-image-1-mini", "low", "1024x1024");
    const two = estimateImageUsd("gpt-image-2", "low", "1024x1024");
    const one5 = estimateImageUsd("gpt-image-1.5", "low", "1024x1024");
    const one = estimateImageUsd("gpt-image-1", "low", "1024x1024");
    expect(mini).toBeLessThanOrEqual(two);
    expect(mini).toBeLessThanOrEqual(one5);
    expect(mini).toBeLessThanOrEqual(one);
  });

  test("higher quality is more expensive within a model", () => {
    for (const model of [
      "gpt-image-2",
      "gpt-image-1.5",
      "gpt-image-1",
      "gpt-image-1-mini",
    ]) {
      const lo = estimateImageUsd(model, "low", "1024x1024");
      const mid = estimateImageUsd(model, "medium", "1024x1024");
      const hi = estimateImageUsd(model, "high", "1024x1024");
      expect(mid).toBeGreaterThanOrEqual(lo);
      expect(hi).toBeGreaterThanOrEqual(mid);
    }
  });

  test("unknown model falls back to a sensible price", () => {
    const usd = estimateImageUsd("gpt-image-unreleased", "low", "1024x1024");
    expect(usd).toBeGreaterThan(0);
  });
});
