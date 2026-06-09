// Video Poker engine — the pure game core (Jacks or Better). No DOM, no
// rendering, no input: it owns the deck, the dealt hand, the held mask, the
// credits/bet bookkeeping, and the hand evaluator + paytable. app.js drives it
// from the intent stream and renders its state.

// A card is { rank, suit }. rank is 2..14 (11=J, 12=Q, 13=K, 14=A); suit is one
// of "S","H","D","C". Aces are high for ranking, but also act low in the
// A-2-3-4-5 "wheel" straight (handled in the evaluator).

export const SUITS = ["S", "H", "D", "C"];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

// Display helpers (used by the renderer, but pure so they can be unit-tested).
export const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const RED_SUITS = new Set(["H", "D"]);
export function rankLabel(rank) {
  return { 11: "J", 12: "Q", 13: "K", 14: "A" }[rank] || String(rank);
}

// Hand ranks, best → worst. Each entry has a stable key (used as the paytable
// index and the highlighted row id) and a display name.
export const HAND_RANKS = [
  { key: "royal", name: "Royal Flush" },
  { key: "straightFlush", name: "Straight Flush" },
  { key: "four", name: "Four of a Kind" },
  { key: "fullHouse", name: "Full House" },
  { key: "flush", name: "Flush" },
  { key: "straight", name: "Straight" },
  { key: "three", name: "Three of a Kind" },
  { key: "twoPair", name: "Two Pair" },
  { key: "jacksOrBetter", name: "Jacks or Better" },
  { key: "nothing", name: "Nothing" },
];

// Payout PER COIN bet, for bets 1..4. Royal Flush gets a flat bonus at bet 5
// (4000 total instead of 5×250=1250), the classic full-pay 9/6 schedule.
export const PAYTABLE = {
  royal: 250,
  straightFlush: 50,
  four: 25,
  fullHouse: 9,
  flush: 6,
  straight: 4,
  three: 3,
  twoPair: 2,
  jacksOrBetter: 1,
  nothing: 0,
};

export const ROYAL_FLUSH_BET5_BONUS = 4000; // total payout for a royal at bet 5
export const MIN_BET = 1;
export const MAX_BET = 5;
export const START_CREDITS = 100;

// Build a fresh ordered 52-card deck.
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  return deck;
}

// ---- Hand evaluation (pure) ------------------------------------------------
// Returns the best hand-rank key for exactly five cards.
export function evaluate(cards) {
  if (cards.length !== 5) throw new Error("evaluate expects exactly 5 cards");

  const ranks = cards.map((c) => c.rank).sort((a, b) => a - b);
  const suits = cards.map((c) => c.suit);

  const isFlush = suits.every((s) => s === suits[0]);

  // Straight: five distinct, consecutive ranks. Treat A as low for the wheel
  // (A-2-3-4-5) by mapping the ace to 1 and re-checking.
  const distinct = [...new Set(ranks)];
  let isStraight = false;
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (ranks[4] - ranks[0] === 4) {
      isStraight = true;
      straightHigh = ranks[4];
    } else if (ranks[0] === 2 && ranks[1] === 3 && ranks[2] === 4 && ranks[3] === 5 && ranks[4] === 14) {
      // Wheel: A-2-3-4-5, the ace plays low so the high card is the 5.
      isStraight = true;
      straightHigh = 5;
    }
  }

  // Count rank multiplicities.
  const counts = {};
  for (const r of ranks) counts[r] = (counts[r] || 0) + 1;
  const groups = Object.entries(counts)
    .map(([rank, n]) => ({ rank: Number(rank), n }))
    // Sort by count desc, then rank desc — the highest group first.
    .sort((a, b) => b.n - a.n || b.rank - a.rank);
  const shape = groups.map((g) => g.n); // e.g. [4,1], [3,2], [3,1,1], [2,2,1]…

  if (isStraight && isFlush) {
    // Royal: a straight flush topped by the ace (high straight T-J-Q-K-A).
    return straightHigh === 14 ? "royal" : "straightFlush";
  }
  if (shape[0] === 4) return "four";
  if (shape[0] === 3 && shape[1] === 2) return "fullHouse";
  if (isFlush) return "flush";
  if (isStraight) return "straight";
  if (shape[0] === 3) return "three";
  if (shape[0] === 2 && shape[1] === 2) return "twoPair";
  if (shape[0] === 2) {
    // A single pair only pays if it's Jacks or better (J/Q/K/A).
    const pairRank = groups[0].rank;
    return pairRank >= 11 ? "jacksOrBetter" : "nothing";
  }
  return "nothing";
}

// Credits paid for a given hand-rank key at a given bet. Royal Flush at bet 5
// pays the flat jackpot; everything else is paytable[key] × bet.
export function payout(handKey, bet) {
  if (handKey === "royal" && bet === MAX_BET) return ROYAL_FLUSH_BET5_BONUS;
  return PAYTABLE[handKey] * bet;
}

export const handName = (key) => HAND_RANKS.find((h) => h.key === key).name;

export class Engine {
  constructor() {
    this.credits = START_CREDITS;
    this.bet = MIN_BET;
    this.reset();
  }

  // Full reset: back to the starting bankroll and a clean idle table.
  reset() {
    this.credits = START_CREDITS;
    this.bet = MIN_BET;
    this.deck = [];
    this.hand = [];                 // the five cards on the table (or empty)
    this.held = [false, false, false, false, false];
    this.phase = "bet";             // "bet" → "draw" → (back to "bet")
    this.lastWin = 0;
    this.lastHandKey = null;        // result of the most recent completed hand
  }

  // Cycle the bet 1→2→…→5→1. Only allowed before a deal.
  betOne() {
    if (this.phase !== "bet") return false;
    this.bet = this.bet >= MAX_BET ? MIN_BET : this.bet + 1;
    return true;
  }

  // Jump straight to the maximum bet (capped by available credits implicitly at
  // deal time). Only allowed before a deal.
  betMax() {
    if (this.phase !== "bet") return false;
    this.bet = MAX_BET;
    return true;
  }

  // True if the player can afford to deal at the current bet.
  canDeal() {
    return this.phase === "bet" && this.credits >= this.bet && this.bet >= MIN_BET;
  }

  // Deal a fresh five-card hand: shuffle, take the bet out of credits, reset the
  // held mask, and enter the draw phase. Returns true on success.
  deal() {
    if (!this.canDeal()) return false;
    this.deck = shuffle(makeDeck());
    this.credits -= this.bet;
    this.hand = this.deck.splice(0, 5);
    this.held = [false, false, false, false, false];
    this.phase = "draw";
    this.lastWin = 0;
    this.lastHandKey = null;
    return true;
  }

  // Toggle the held state of card index i (0..4) during the draw phase.
  toggleHold(i) {
    if (this.phase !== "draw") return false;
    if (i < 0 || i > 4) return false;
    this.held[i] = !this.held[i];
    return true;
  }

  // Replace every non-held card from the deck, evaluate the final hand, pay out,
  // and return to the bet phase. Returns the result { key, name, win }.
  draw() {
    if (this.phase !== "draw") return null;
    for (let i = 0; i < 5; i++) {
      if (!this.held[i]) this.hand[i] = this.deck.shift();
    }
    const key = evaluate(this.hand);
    const win = payout(key, this.bet);
    this.credits += win;
    this.lastWin = win;
    this.lastHandKey = key;
    this.phase = "bet";
    return { key, name: handName(key), win };
  }

  // True once the bankroll is empty and the player can no longer deal.
  isBroke() {
    return this.phase === "bet" && this.credits < MIN_BET;
  }
}

// Fisher–Yates shuffle (in place, returns the same array for chaining).
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
