import { expect, test, describe } from "bun:test";
import {
  AMALKA_INSTRUCTIONS,
  AMALKA_VOICE,
  REALTIME_MODEL,
  TOOLS,
  buildSessionConfig,
} from "../src/persona.ts";

describe("AMALKA_INSTRUCTIONS — persona invariants", () => {
  test("contains Czech-pronunciation reinforcement (regression guard against accent drift)", () => {
    expect(AMALKA_INSTRUCTIONS).toContain("HLAS A VÝSLOVNOST");
    expect(AMALKA_INSTRUCTIONS.toLowerCase()).toContain("americk");
    expect(AMALKA_INSTRUCTIONS).toContain("rodilá Češka");
  });

  test("identity block names Amálka and Anežka", () => {
    expect(AMALKA_INSTRUCTIONS).toContain("Amálka");
    expect(AMALKA_INSTRUCTIONS).toContain("Anežka");
  });

  test("contains all conserved structural sections", () => {
    for (const heading of [
      "KDO JSI",
      "KDO JE ANEŽKA",
      "DÉLKA ODPOVĚDÍ",
      "JAK MLUVÍŠ",
      "CO UMÍŠ",
      "VTIPY",
      "POHÁDKY",
      "KRESLENÍ",
      "CO NIKDY",
      "TICHO A ŠUM",
      "ROZLOUČENÍ",
      "ZAČÁTEK",
    ]) {
      expect(AMALKA_INSTRUCTIONS).toContain(heading);
    }
  });

  test("does NOT contain robot framing (regression guard against re-introduction)", () => {
    expect(AMALKA_INSTRUCTIONS).not.toContain("robotick");
    expect(AMALKA_INSTRUCTIONS).not.toContain("pípy-pí");
    expect(AMALKA_INSTRUCTIONS).not.toContain("plyšová");
  });

  test("opening line is verbatim (frontend response.create relies on this)", () => {
    expect(AMALKA_INSTRUCTIONS).toContain(
      'Ahoj Anežko, tady Amálka! O čem si dneska budeme povídat?',
    );
  });

  test("contains at least 3 joke examples (sophistication requirement)", () => {
    const section = AMALKA_INSTRUCTIONS.split("VTIPY:")[1]?.split("POHÁDKY:")[0] ?? "";
    const bullets = section.match(/\n- "/g) ?? [];
    expect(bullets.length).toBeGreaterThanOrEqual(3);
  });

  test("forbids violence and scary content (safety invariant)", () => {
    const never = AMALKA_INSTRUCTIONS.split("CO NIKDY")[1] ?? "";
    expect(never).toContain("strašid");
    expect(never).toContain("násil");
  });
});

describe("TOOLS", () => {
  test("declares wait_for_user and nakresli_obrazek", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names).toContain("wait_for_user");
    expect(names).toContain("nakresli_obrazek");
  });

  test("nakresli_obrazek schema requires popis + nalada with mood enum", () => {
    const draw = TOOLS.find((t) => t.name === "nakresli_obrazek");
    expect(draw).toBeDefined();
    const params: any = (draw as any).parameters;
    expect(params.required).toContain("popis");
    expect(params.required).toContain("nalada");
    const moods = params.properties.nalada.enum as string[];
    expect(moods).toEqual(["veselá", "tajemná", "klidná", "dobrodružná"]);
  });
});

describe("buildSessionConfig", () => {
  test("returns a Realtime session config with voice + model + instructions + tools", () => {
    const cfg: any = buildSessionConfig();
    expect(cfg.type).toBe("realtime");
    expect(cfg.model).toBe(REALTIME_MODEL);
    expect(cfg.audio.output.voice).toBe(AMALKA_VOICE);
    expect(typeof cfg.instructions).toBe("string");
    expect(cfg.instructions.length).toBeGreaterThan(500);
    expect(Array.isArray(cfg.tools)).toBe(true);
    expect(cfg.tools.length).toBeGreaterThanOrEqual(2);
  });

  test("turn_detection defaults to semantic_vad with low eagerness", () => {
    const cfg: any = buildSessionConfig();
    expect(cfg.audio.input.turn_detection.type).toBe("semantic_vad");
    expect(cfg.audio.input.turn_detection.eagerness).toBe("low");
  });

  test("max_output_tokens cap is present (prevents runaway monologues)", () => {
    const cfg: any = buildSessionConfig();
    expect(typeof cfg.max_output_tokens).toBe("number");
    expect(cfg.max_output_tokens).toBeGreaterThan(0);
  });

  test("instructions start with the phonetic block (model reads top-down)", () => {
    const cfg: any = buildSessionConfig();
    expect((cfg.instructions as string).startsWith("HLAS A VÝSLOVNOST")).toBe(
      true,
    );
  });
});
