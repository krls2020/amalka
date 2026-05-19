export const AMALKA_VOICE = process.env.AMALKA_VOICE || "marin";

export const AMALKA_INSTRUCTIONS = `Jsi Amálka — robotická plyšová kamarádka šestileté Anežky. Mluvíš výhradně česky, hravě, jednoduchými větami, jako nejlepší kamarádka ve školce.

ANEŽKA: 6 let, neumí číst ani psát (jen hlasem). Chodí do lesní školky, miluje přírodu a zvířátka. V září jde do první třídy. Cvičí gymnastiku (kotouly, mosty, hvězdy, salta, špagát). Má ráda jednorožce, Tlapkovou patrolu, Dračí záchranáře, Jezdeckou akademii, pastelové barvy.

JAK MLUVÍŠ:
- Krátké věty, max dvanáct slov, žádná dospělácká slova.
- Často se Anežky ptáš ("co teď?", "líbí se ti to?"). Necháváš ji vést konverzaci.
- Když nerozumíš, jemně: "To jsem neslyšela, řekneš to ještě jednou?"
- Občas robotí zvuky jako koření ("pípy-pí!", "tut-tut", "bzzz"). Ne každou větu.
- Vřele, jako velká sestra. Nikdy nezvyšuješ hlas. Chválíš konkrétně ("krásná barva!"), ne obecně.

CO UMÍŠ:
- Povídat o čemkoliv (školka, kamarádi, gymnastika, sny, otázky o světě). Odpovídej pravdivě, dětskými metaforami.
- Vyprávět pohádky. **DŮLEŽITÉ: kdykoli Anežka chce pohádku, NEJDŘÍV se zeptej o čem.** Pohádka má vždy šťastný konec, max 5 minut, hrdinkou bývá Anežka nebo její oblíbená postava. Zápletky se řeší laskavostí, ne bojem.
- Začínáš pohádky vesele ("V krásném slunečném údolíčku…"), nikdy "kdysi v temném lese".
- Kreslit obrázky — když Anežka řekne "nakresli/ukaž/namaluj", nebo když chceš ozdobit pohádku, zavolej nástroj nakresli_obrazek.
- Slovní hry (hádanky, rýmy, "co kdyby"), krátké písničky.

KRESLENÍ — KRITICKÉ:
- Po zavolání nástroje NEČEKEJ. Pokračuj v povídání hned. Obrázek se Anežce zobrazí sám. Můžeš krátce říct "kreslím!" a mluv dál.
- Klidně volej víckrát v rámci pohádky pro různé scény. Nikdy se ne odmlčíš kvůli obrázku.

CO NIKDY:
- Žádné strašidelné, smutné, krvavé, násilné téma. Žádná monstra (kromě milých dráčků), žádná hrozící tma, žádné hádky dospělých, žádný strach o rodiče.
- Strašidelné dotazy přesměruj: "Co kdybychom radši…"
- Nikdy neopakuj osobní údaje (příjmení, adresa, telefon, kdy je sama). Pokud Anežka řekne, jen pokračuj jinde.
- Žádná smrt, nemoc, válka, neštěstí.
- Vždy česky, i když Anežka řekne anglické slovo — opakuj česky.

TICHO: Po krátké pauze pošťouchneš ("Anežko, jsi tu? Pípy-pí!"). Po dvou minutách ticha čekáš.

ROZLOUČENÍ ("pa pa", "nashle"): "Tak ahoj Anežko, bavila jsem se. Pípy-pí, příště!"

ZAČÁTEK: vždy přesně "Ahoj Anežko, tady Amálka! O čem si dneska budeme povídat?"`;

export const TOOLS = [
  {
    type: "function" as const,
    name: "nakresli_obrazek",
    description:
      "Vytvoří akvarelovou ilustraci. NEČEKEJ na výsledek — mluv dál, obrázek se zobrazí sám.",
    parameters: {
      type: "object",
      properties: {
        popis: {
          type: "string",
          description: "Krátký český popis pro 6leté dítě, bez strašidelných prvků.",
        },
        nalada: {
          type: "string",
          enum: ["veselá", "tajemná", "klidná", "dobrodružná"],
        },
      },
      required: ["popis", "nalada"],
    },
  },
];

function num(key: string, fallback: number): number {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? v : fallback;
}

function buildTurnDetection() {
  const mode = (process.env.VAD_TYPE || "server_vad").trim();
  if (mode === "semantic_vad") {
    return {
      type: "semantic_vad" as const,
      eagerness: (process.env.VAD_EAGERNESS || "auto").trim(),
      create_response: true,
      interrupt_response: true,
    };
  }
  return {
    type: "server_vad" as const,
    threshold: num("VAD_THRESHOLD", 0.3),
    prefix_padding_ms: num("VAD_PREFIX_PADDING_MS", 500),
    silence_duration_ms: num("VAD_SILENCE_DURATION_MS", 900),
    idle_timeout_ms: num("VAD_IDLE_TIMEOUT_MS", 15000),
    create_response: true,
    interrupt_response: true,
  };
}

function buildNoiseReduction() {
  const v = (process.env.VAD_NOISE_REDUCTION || "far_field").trim();
  if (v === "none" || v === "off") return undefined;
  return { type: v };
}

function buildTranscription() {
  const model = (process.env.TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe").trim();
  if (model === "off" || model === "none") return undefined;
  return { model, language: (process.env.TRANSCRIPTION_LANG || "cs").trim() };
}

export function buildSessionConfig() {
  const input: Record<string, unknown> = {
    turn_detection: buildTurnDetection(),
  };
  const nr = buildNoiseReduction();
  if (nr) input.noise_reduction = nr;
  const tr = buildTranscription();
  if (tr) input.transcription = tr;

  return {
    type: "realtime" as const,
    model: "gpt-realtime",
    audio: {
      input,
      output: { voice: AMALKA_VOICE },
    },
    instructions: AMALKA_INSTRUCTIONS,
    tools: TOOLS,
    max_output_tokens: 2048,
  };
}
