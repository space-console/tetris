// Slot machine engine — the pure game core. No DOM, no rendering, no input: it
// owns the reel symbols + weighted rarity, the paytable, the credits/bet
// bookkeeping, the seedable RNG, and the win evaluator. app.js drives it and
// renders its state.
//
// A classic 3-reel machine with a single centre payline. spin() picks one
// symbol per reel using the weighted table; evaluate() scores the three-symbol
// result for the current bet.

// ---- Symbols + weights -----------------------------------------------------
// Each symbol has a stable `key`, a display `glyph`, and a `weight` (higher =
// more common). Rarer symbols carry the bigger three-of-a-kind payouts. The
// fruit (🍒 🍋 🍊) are deliberately the common, low-paying faces; 💎 is the
// rare jackpot.
export const SYMBOLS = [
  { key: "cherry", glyph: "🍒", name: "Cherry", weight: 28 },
  { key: "lemon", glyph: "🍋", name: "Lemon", weight: 24 },
  { key: "orange", glyph: "🍊", name: "Orange", weight: 20 },
  { key: "bell", glyph: "🔔", name: "Bell", weight: 12 },
  { key: "star", glyph: "⭐", name: "Star", weight: 8 },
  { key: "seven", glyph: "7️⃣", name: "Seven", weight: 5 },
  { key: "diamond", glyph: "💎", name: "Diamond", weight: 3 },
];

// Quick lookups by key.
export const SYMBOL_BY_KEY = Object.fromEntries(SYMBOLS.map((s) => [s.key, s]));

// The set of "fruit" keys — used by the partial "any three fruit" rule.
export const FRUIT_KEYS = new Set(["cherry", "lemon", "orange"]);

// ---- Paytable --------------------------------------------------------------
// Three-of-a-kind payout PER COIN bet, keyed by symbol. Final payout is this
// value × bet. Rarer symbol → bigger prize; 💎 is the jackpot.
export const PAYTABLE = {
  diamond: 200, // JACKPOT
  seven: 100,
  star: 40,
  bell: 20,
  orange: 12,
  lemon: 8,
  cherry: 5,
};

// The single biggest line — landing three of this symbol fires the JACKPOT
// celebration in the UI.
export const JACKPOT_KEY = "diamond";

// Partial (non three-of-a-kind) wins, checked in order, first match wins. These
// pay PER COIN bet too (× bet at evaluation time).
//  - twoSevens:  any two 7️⃣ on the line.
//  - threeFruit: three matching… no — three fruit of *mixed* kinds (e.g.
//                🍒🍋🍊). A pure three-of-a-kind already pays more via the
//                paytable, so this only fires when the line is all-fruit but
//                not all-identical.
export const PARTIAL_WINS = [
  { key: "twoSevens", name: "Two Sevens", pay: 3 },
  { key: "threeFruit", name: "Mixed Fruit", pay: 2 },
];
export const PARTIAL_BY_KEY = Object.fromEntries(PARTIAL_WINS.map((p) => [p.key, p]));

export const MIN_BET = 1;
export const MAX_BET = 5;
export const START_CREDITS = 100;
export const REELS = 3;

// ---- Seedable RNG ----------------------------------------------------------
// Mulberry32: a tiny, fast, deterministic 32-bit PRNG. Seed it for tests;
// leave it unseeded (seeded from Math.random) for real play.
export function makeRng(seed) {
  let s = (seed >>> 0) || (Math.floor(Math.random() * 0xffffffff) >>> 0);
  return function next() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Total weight across all symbols (constant — precomputed once).
const TOTAL_WEIGHT = SYMBOLS.reduce((sum, s) => sum + s.weight, 0);

// Pick one symbol key by weighted rarity using rng() ∈ [0, 1).
export function pickSymbol(rng) {
  let roll = rng() * TOTAL_WEIGHT;
  for (const s of SYMBOLS) {
    roll -= s.weight;
    if (roll < 0) return s.key;
  }
  // Floating-point fallthrough guard — return the last symbol.
  return SYMBOLS[SYMBOLS.length - 1].key;
}

// ---- Win evaluation (pure) -------------------------------------------------
// Score a three-symbol line for a given bet. Returns { key, name, win, jackpot }
// where `key` is the symbol key for a three-of-a-kind, a partial-win key, or
// null for no win.
export function evaluate(result, bet) {
  if (result.length !== REELS) {
    throw new Error(`evaluate expects exactly ${REELS} symbols`);
  }
  const [a, b, c] = result;

  // Three of a kind — the headline wins, scored from the paytable.
  if (a === b && b === c) {
    const pay = PAYTABLE[a] * bet;
    return {
      key: a,
      name: `Three ${SYMBOL_BY_KEY[a].name}s`,
      win: pay,
      jackpot: a === JACKPOT_KEY,
    };
  }

  // Partial: any two sevens on the line.
  const sevens = result.filter((k) => k === "seven").length;
  if (sevens === 2) {
    const p = PARTIAL_BY_KEY.twoSevens;
    return { key: p.key, name: p.name, win: p.pay * bet, jackpot: false };
  }

  // Partial: all three are fruit (but mixed kinds — identical is handled above).
  if (result.every((k) => FRUIT_KEYS.has(k))) {
    const p = PARTIAL_BY_KEY.threeFruit;
    return { key: p.key, name: p.name, win: p.pay * bet, jackpot: false };
  }

  return { key: null, name: "No win", win: 0, jackpot: false };
}

export class Engine {
  constructor(seed) {
    this._rng = makeRng(seed);
    this.credits = START_CREDITS;
    this.bet = MIN_BET;
    this.reset();
  }

  // Full reset: back to the starting bankroll and a clean idle machine. Keeps
  // the existing RNG stream so a reset mid-session stays unpredictable.
  reset() {
    this.credits = START_CREDITS;
    this.bet = MIN_BET;
    this.reels = [SYMBOLS[0].key, SYMBOLS[0].key, SYMBOLS[0].key];
    this.lastWin = 0;
    this.lastResult = null; // last evaluate() result, or null before any spin
  }

  // Cycle the bet 1→2→…→5→1.
  betOne() {
    this.bet = this.bet >= MAX_BET ? MIN_BET : this.bet + 1;
    return true;
  }

  // Jump straight to the maximum affordable bet (never above the bankroll, never
  // below MIN_BET so a near-broke player can still attempt the last spin).
  betMax() {
    this.bet = Math.max(MIN_BET, Math.min(MAX_BET, this.credits));
    return true;
  }

  // True if the player can afford a spin at the current bet.
  canSpin() {
    return this.credits >= this.bet && this.bet >= MIN_BET;
  }

  // Spin: deduct the bet, roll three weighted symbols, store them, and return
  // the resulting reel keys. Does NOT evaluate — call settle() once the reels
  // have visually stopped so the animation and the payout stay in sync. Returns
  // the reel keys, or null if the player can't afford the spin.
  spin() {
    if (!this.canSpin()) return null;
    this.credits -= this.bet;
    this.reels = [
      pickSymbol(this._rng),
      pickSymbol(this._rng),
      pickSymbol(this._rng),
    ];
    this.lastWin = 0;
    this.lastResult = null;
    return this.reels.slice();
  }

  // Evaluate the current reels for the current bet, credit any win, and return
  // the result. Call this after spin() once the reels have settled.
  settle() {
    const result = evaluate(this.reels, this.bet);
    this.credits += result.win;
    this.lastWin = result.win;
    this.lastResult = result;
    return result;
  }

  // True once the bankroll can no longer fund even the minimum bet.
  isBroke() {
    return this.credits < MIN_BET;
  }
}
