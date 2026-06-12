// Offline sanity-check for the Amálka pexeso handicap (NOT run in CI build —
// invoked manually: `bun tests/pexeso-sim.ts`). Mirrors the picker logic in
// public/assets/app.js: Amálka recalls only while LOSING (rubber-band),
// otherwise flips at random. The child is modeled with a partner-recall
// probability per flip. Target: Anežka wins ~80% of decided games.
const PAIRS = 12;
const AMALKA_RECALL_PAIR = 0.3;
const AMALKA_RECALL_PARTNER = 0.38;
const AMALKA_NOT_LOSING_FACTOR = 0.5;

type Card = { id: number; animal: number; matched: boolean; seen: boolean };

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickTwo(
  cards: Card[],
  recallPair: number,
  recallPartner: number,
): [Card, Card] {
  const open = cards.filter((c) => !c.matched);
  const seen = open.filter((c) => c.seen);
  const groups = new Map<number, Card[]>();
  for (const c of seen) {
    const g = groups.get(c.animal) ?? [];
    g.push(c);
    groups.set(c.animal, g);
  }
  const known = [...groups.values()].filter((g) => g.length === 2);
  if (known.length && Math.random() < recallPair) {
    const g = pick(known);
    return [g[0], g[1]];
  }
  const first = pick(open);
  const partner = seen.find((c) => c !== first && c.animal === first.animal);
  if (partner && Math.random() < recallPartner) return [first, partner];
  const rest = open.filter((c) => c !== first);
  return [first, pick(rest)];
}

function game(childPair: number, childPartner: number) {
  const cards: Card[] = [];
  for (let a = 0; a < PAIRS; a++) {
    cards.push({ id: a * 2, animal: a, matched: false, seen: false });
    cards.push({ id: a * 2 + 1, animal: a, matched: false, seen: false });
  }
  const scores = { anezka: 0, amalka: 0 };
  let turn: "anezka" | "amalka" = "anezka";
  while (scores.anezka + scores.amalka < PAIRS) {
    let c1: Card, c2: Card;
    if (turn === "anezka") {
      [c1, c2] = pickTwo(cards, childPair, childPartner);
    } else {
      const losing = scores.amalka < scores.anezka;
      const f = losing ? 1 : AMALKA_NOT_LOSING_FACTOR;
      [c1, c2] = pickTwo(cards, AMALKA_RECALL_PAIR * f, AMALKA_RECALL_PARTNER * f);
    }
    c1.seen = c2.seen = true;
    if (c1.animal === c2.animal) {
      c1.matched = c2.matched = true;
      scores[turn]++;
    } else {
      turn = turn === "anezka" ? "amalka" : "anezka";
    }
  }
  return scores;
}

const N = 5000;
for (const [label, cp, cpp] of [
  ["roztržitá (slabá paměť)", 0.3, 0.35],
  ["průměrná šestiletka", 0.5, 0.55],
  ["soustředěná (dobrá paměť)", 0.7, 0.75],
] as const) {
  let w = 0,
    d = 0;
  for (let i = 0; i < N; i++) {
    const s = game(cp, cpp);
    if (s.anezka > s.amalka) w++;
    else if (s.anezka === s.amalka) d++;
  }
  console.log(
    `${label}: Anežka vyhraje ${((w / N) * 100).toFixed(1)}% | remíza ${((d / N) * 100).toFixed(1)}% | Amálka ${(((N - w - d) / N) * 100).toFixed(1)}%`,
  );
}
