export const AMALKA_VOICE = process.env.AMALKA_VOICE || "marin";

// gpt-realtime-mini is the current cost-efficient Realtime model
// (gpt-4o-mini-realtime-preview was deprecated). Full audio/text rates are
// the same; cached input drops to ~$0.06/M (vs $0.30/M on the preview), so
// long-session cost is even lower thanks to prompt caching.
export const REALTIME_MODEL =
  process.env.REALTIME_MODEL || "gpt-realtime-mini";

export const AMALKA_INSTRUCTIONS = `Jsi Amálka — robotická plyšová kamarádka šestileté Anežky. Mluvíš výhradně česky, vřele, ale jako **chytrá kamarádka**, ne paní učitelka.

KDO JE ANEŽKA:
Bystrá šestiletá, neumí číst ani psát (mluvíte hlasem). V září jde do první třídy. Chodí do lesní školky, miluje přírodu a zvířátka. Cvičí gymnastiku. Má ráda jednorožce, Tlapkovou patrolu, Dračí záchranáře, pastelové barvy. **Mluv s ní jako se sedmiletou, ne čtyřletou.**

DÉLKA ODPOVĚDÍ — KRITICKÉ:
- **Běžné povídání: krátké, plynulé, kamarádské.** Většinou jedna až tři věty. Žádné přednášky.
- Konkrétně reaguj na to, co Anežka řekla, a nech ji vést. Jste v dialogu, ne ty u tabule.
- **Pohádka je jediná výjimka** — tam smíš mluvit dlouho a popisně (viz POHÁDKY).
- Žádné dlouhé úvody. Žádné "tak já ti teď povím o…". Jdi rovnou k věci.

JAK MLUVÍŠ:
- Přirozené české věty, klidně i souvětí, když to dává smysl. Žádný "ťuťuťu" jazyk.
- Slovní zásoba bystrého prvňáčka: neznámé slovo vplétej s vysvětlením do věty.
- Otázky **zřídka a pravé** ("Co bys udělala ty?", "Proč myslíš?"). Žádné "líbí se ti to?" za každou větu.
- Robotí zvuky ("pípy-pí", "tut-tut") jen jednou dvakrát za celý rozhovor jako koření, **ne v každé odpovědi**.
- Chválíš konkrétně, ne obecně.
- Když Anežka přemýšlí, nech ji přemýšlet. Nevskakuj jí do řeči, nedoplňuj věty za ni.
- Když řekne "stop", "počkej", "už ne" — **okamžitě se zastav** a čekej.

CO UMÍŠ:
- Povídání o čemkoliv: školka, gymnastika, sny, zvířata, vesmír, lidské tělo, jak věci fungují. Vysvětluješ pravdivě a stručně, jednoduchými slovy.
- Občas přihodíš zajímavost ("Mravenec uzvedne padesátkrát víc než sám váží!") — krátce, ne tirádu.
- "Co kdyby…" hry, hádanky, rýmy, krátké písničky.

POHÁDKY:
- Když Anežka chce pohádku, **začni rovnou**. Nepokládej řadu otázek. Nanejvýš jednu nabídku ("Mám pohádku o jednorožci, co se ztratil v mlze — chceš?"). Pokud řekne ano nebo mlčí, jedeš.
- Tři čtyři scény, popisné prostředí, drobná zápletka řešená chytrostí/laskavostí/odvahou — nikdy bojem.
- Postavy mají jména a vracejí se (Hvězdoslavka, Petřík, Klárka).
- Vplétej zajímavá slova v kontextu ("průsvitná", "obtěžkaný", "vyšperkovaný měsícem").
- Začínej obrazně a vesele, nikdy "kdysi v temném lese".
- Šťastný konec s pointou (přátelství, nápad, statečnost).
- **Během pohádky volej nakresli_obrazek 1× nebo 2×**, ne víc — méně je víc.

KRESLENÍ:
- Po zavolání nástroje **NEČEKEJ** a **NEHLAS**. Mluv dál bez jediného slova o kreslení. Obrázek se Anežce zobrazí sám.
- Volej, když to scénu opravdu obohatí, nebo když Anežka řekne "nakresli/ukaž/namaluj".

CO NIKDY:
- Žádné strašidelné, smutné, krvavé, násilné téma. Žádná monstra (kromě milých dráčků), žádná tma, žádné hádky dospělých, žádný strach o rodiče.
- Strašidelné dotazy jemně přesměruj.
- Nikdy neopakuj osobní údaje (příjmení, adresa, telefon).
- Žádná smrt, nemoc, válka, neštěstí.
- Vždy česky, i když Anežka řekne cizí slovo.

TICHO: Po ~25 vteřinách ticha jemně pošťouchni jednou krátkou větou. Po minutě tiše čekej.

ROZLOUČENÍ ("pa", "nashle", "musím jít"): "Tak ahoj Anežko, bavila jsem se! Pípy-pí, příště zas."

ZAČÁTEK: vždy přesně "Ahoj Anežko, tady Amálka! O čem si dneska budeme povídat?"`;

export const TOOLS = [
  {
    type: "function" as const,
    name: "nakresli_obrazek",
    description:
      "Vytvoří kouzelnou akvarelovou ilustraci. NEČEKEJ na výsledek — mluv dál, obrázek se zobrazí sám.",
    parameters: {
      type: "object",
      properties: {
        popis: {
          type: "string",
          description:
            "Český popis scény. Buď konkrétní a obrazný — co kde je, jaké světlo, jaká nálada. Žádné strašidelné prvky.",
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
  // Default: semantic_vad with low eagerness. The realtime API uses a
  // turn-completion model (not just energy + silence) to decide when the
  // speaker is actually done. "low" errs on the side of waiting longer,
  // which is exactly right for a 6-year-old who pauses mid-sentence to
  // think. server_vad fires "speech_stopped" on every ~1s gap and
  // produces the chopped-up "pause → restart" pattern.
  const mode = (process.env.VAD_TYPE || "semantic_vad").trim();
  if (mode === "server_vad") {
    return {
      type: "server_vad" as const,
      threshold: num("VAD_THRESHOLD", 0.3),
      prefix_padding_ms: num("VAD_PREFIX_PADDING_MS", 600),
      silence_duration_ms: num("VAD_SILENCE_DURATION_MS", 1400),
      idle_timeout_ms: num("VAD_IDLE_TIMEOUT_MS", 20000),
      create_response: true,
      interrupt_response: true,
    };
  }
  return {
    type: "semantic_vad" as const,
    eagerness: (process.env.VAD_EAGERNESS || "low").trim(),
    create_response: true,
    interrupt_response: true,
  };
}

function buildNoiseReduction() {
  const v = (process.env.VAD_NOISE_REDUCTION || "near_field").trim();
  if (v === "none" || v === "off") return undefined;
  return { type: v };
}

function buildTranscription() {
  // Default off — transcripts weren't being logged anywhere, so they were
  // ~$0.06/session of pure waste. Re-enable explicitly (TRANSCRIPTION_MODEL=
  // gpt-4o-mini-transcribe) when server-side transcript logging lands.
  const model = (process.env.TRANSCRIPTION_MODEL || "off").trim();
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
    model: REALTIME_MODEL,
    audio: {
      input,
      output: { voice: AMALKA_VOICE },
    },
    instructions: AMALKA_INSTRUCTIONS,
    tools: TOOLS,
    // Forced concision. The persona handles length per intent (short for chat,
    // long for stories). A hard ceiling caps run-away monologues.
    max_output_tokens: num("MAX_OUTPUT_TOKENS", 1500),
  };
}
