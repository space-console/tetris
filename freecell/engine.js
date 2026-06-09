// FreeCell engine — the pure game core. No DOM, no rendering, no input: it owns
// the deck, the 8 tableau columns, the 4 free cells and the 4 foundations, plus
// all move-legality rules, the supermove math and win detection. app.js drives
// it from the intent stream and renders its state.
//
// FreeCell is an open-information solitaire: all 52 cards are dealt FACE-UP, so
// the game is one of pure planning. The four free cells each park a single card;
// the four foundations build UP by suit (A→K); the eight tableau columns build
// DOWN by alternating colour. Almost every deal is solvable.
//
// A card is { rank, suit }. rank is 1..13 (1=A, 11=J, 12=Q, 13=K); suit is one
// of "S","H","D","C". There is no faceUp flag — every card is always visible.

export const SUITS = ["S", "H", "D", "C"];
export const RANKS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

// Display helpers (pure, so they can be unit-tested and reused by the renderer).
export const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const RED_SUITS = new Set(["H", "D"]);
export function rankLabel(rank) {
  return { 1: "A", 11: "J", 12: "Q", 13: "K" }[rank] || String(rank);
}
export function isRed(card) {
  return RED_SUITS.has(card.suit);
}

export const FREE_COUNT = 4;
export const FOUNDATION_COUNT = 4;
export const TABLEAU_COUNT = 8;

// Build a fresh ordered 52-card deck.
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  return deck;
}

// A small seedable PRNG (mulberry32) so tests can reproduce deals. Returns a
// function in [0, 1). Falls back to Math.random when no seed is given.
export function makeRng(seed) {
  if (seed === undefined) return Math.random;
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates shuffle (in place, returns the same array for chaining).
export function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export class Engine {
  constructor() {
    this.reset();
  }

  // Deal a fresh game. Standard FreeCell deal: all 52 cards face-up across 8
  // columns dealt round-robin, so columns 0–3 get 7 cards and columns 4–7 get 6.
  // Accepts a seed (number) or an rng function for reproducible deals.
  reset(seedOrRng) {
    const rng = typeof seedOrRng === "function" ? seedOrRng : makeRng(seedOrRng);
    const deck = shuffle(makeDeck(), rng);

    this.cols = Array.from({ length: TABLEAU_COUNT }, () => []);
    // Round-robin deal: card k goes to column (k % 8). With 52 cards this gives
    // 7,7,7,7,6,6,6,6 — the canonical FreeCell layout.
    for (let k = 0; k < deck.length; k++) {
      this.cols[k % TABLEAU_COUNT].push(deck[k]);
    }

    this.free = [null, null, null, null];        // one card each (or null)
    this.foundations = [[], [], [], []];          // build UP by suit, indexed 0..3
    this.moves = 0;
  }

  // ---- Move legality (pure predicates) -------------------------------------
  // A card may land on a tableau column if the column is empty (any card), or
  // the column's bottom (exposed) card is one rank higher and the opposite
  // colour (build down, alternating colour).
  canToTableau(card, colIndex) {
    const col = this.cols[colIndex];
    if (!col) return false;
    if (col.length === 0) return true; // any single card may move to an empty column
    const bottom = col[col.length - 1];
    return bottom.rank === card.rank + 1 && isRed(bottom) !== isRed(card);
  }

  // A card may go to a foundation if it's an Ace onto an empty foundation, or the
  // next rank up of the same suit. colIndex is the foundation slot index.
  canToFoundation(card, foundationIndex) {
    const f = this.foundations[foundationIndex];
    if (!f) return false;
    if (f.length === 0) return card.rank === 1; // Aces start a foundation
    const top = f[f.length - 1];
    return top.suit === card.suit && card.rank === top.rank + 1;
  }

  // A card may go to a free cell if that cell is empty.
  canToFree(cellIndex) {
    return this.free[cellIndex] === null || this.free[cellIndex] === undefined;
  }

  // ---- Sequence / supermove helpers ----------------------------------------
  // True if the cards from `cardIndex` to the bottom of column `colIndex` form a
  // valid descending, alternating-colour run (so they can move as a group). A
  // single card is trivially a valid run.
  isValidRun(colIndex, cardIndex) {
    const col = this.cols[colIndex];
    if (!col || cardIndex < 0 || cardIndex >= col.length) return false;
    for (let i = cardIndex; i < col.length - 1; i++) {
      const upper = col[i];
      const lower = col[i + 1];
      if (upper.rank !== lower.rank + 1 || isRed(upper) === isRed(lower)) return false;
    }
    return true;
  }

  // Find the start index of the largest valid descending alternating run at the
  // bottom of a column (the deepest card from which the run down is still legal).
  largestRunStart(colIndex) {
    const col = this.cols[colIndex];
    if (!col || col.length === 0) return -1;
    let start = col.length - 1;
    while (start > 0) {
      const upper = col[start - 1];
      const lower = col[start];
      if (upper.rank === lower.rank + 1 && isRed(upper) !== isRed(lower)) start--;
      else break;
    }
    return start;
  }

  // Count empty free cells and empty columns (the resources that power a
  // supermove — each empty cell holds one staged card, each empty column doubles
  // the staging capacity).
  freeCellsEmpty() {
    return this.free.reduce((n, c) => n + (c === null || c === undefined ? 1 : 0), 0);
  }
  emptyColumnsCount() {
    return this.cols.reduce((n, col) => n + (col.length === 0 ? 1 : 0), 0);
  }

  // Maximum number of cards movable as one tableau→tableau supermove:
  //   (1 + freeCellsEmpty) × 2^(emptyColumns)
  // When the DESTINATION is an empty column, that column can't double as an
  // intermediary, so the exponent drops by one: 2^(emptyColumns − 1).
  maxSupermove(toEmpty = false) {
    const empties = this.emptyColumnsCount();
    const usableEmpties = toEmpty ? Math.max(0, empties - 1) : empties;
    return (1 + this.freeCellsEmpty()) * Math.pow(2, usableEmpties);
  }

  // ---- Moves (mutating) ----------------------------------------------------
  // Move the run starting at `cardIndex` of column `fromCol` onto column `toCol`.
  // Validates: distinct columns, the source is a legal run, the destination
  // accepts the top (moving) card, and the run length is within the supermove
  // limit. Returns true on success.
  moveTableauToTableau(fromCol, cardIndex, toCol) {
    if (fromCol === toCol) return false;
    const src = this.cols[fromCol];
    if (!src || cardIndex < 0 || cardIndex >= src.length) return false;
    if (!this.isValidRun(fromCol, cardIndex)) return false;
    const moving = src[cardIndex]; // the card actually landing on the destination
    if (!this.canToTableau(moving, toCol)) return false;

    const runLen = src.length - cardIndex;
    const toEmpty = this.cols[toCol].length === 0;
    if (runLen > this.maxSupermove(toEmpty)) return false;

    const group = src.splice(cardIndex);
    this.cols[toCol].push(...group);
    this.moves += 1;
    return true;
  }

  // Move the bottom card of column `fromCol` to foundation `toFoundation`.
  moveTableauToFoundation(fromCol, toFoundation) {
    const src = this.cols[fromCol];
    if (!src || src.length === 0) return false;
    const card = src[src.length - 1];
    if (!this.canToFoundation(card, toFoundation)) return false;
    this.foundations[toFoundation].push(src.pop());
    this.moves += 1;
    return true;
  }

  // Move the bottom card of column `fromCol` to free cell `toCell`.
  moveTableauToFree(fromCol, toCell) {
    const src = this.cols[fromCol];
    if (!src || src.length === 0) return false;
    if (!this.canToFree(toCell)) return false;
    this.free[toCell] = src.pop();
    this.moves += 1;
    return true;
  }

  // Move a free-cell card to a foundation.
  moveFreeToFoundation(fromCell, toFoundation) {
    const card = this.free[fromCell];
    if (!card) return false;
    if (!this.canToFoundation(card, toFoundation)) return false;
    this.foundations[toFoundation].push(card);
    this.free[fromCell] = null;
    this.moves += 1;
    return true;
  }

  // Move a free-cell card to a tableau column.
  moveFreeToTableau(fromCell, toCol) {
    const card = this.free[fromCell];
    if (!card) return false;
    if (!this.canToTableau(card, toCol)) return false;
    this.cols[toCol].push(card);
    this.free[fromCell] = null;
    this.moves += 1;
    return true;
  }

  // Move a free-cell card to another empty free cell (rarely useful, but cheap).
  moveFreeToFree(fromCell, toCell) {
    if (fromCell === toCell) return false;
    const card = this.free[fromCell];
    if (!card) return false;
    if (!this.canToFree(toCell)) return false;
    this.free[toCell] = card;
    this.free[fromCell] = null;
    this.moves += 1;
    return true;
  }

  // Move the top of a foundation back down onto a tableau column (optional but
  // sometimes needed to free a card for a longer run).
  moveFoundationToTableau(fromFoundation, toCol) {
    const f = this.foundations[fromFoundation];
    if (!f || f.length === 0) return false;
    const card = f[f.length - 1];
    if (!this.canToTableau(card, toCol)) return false;
    this.cols[toCol].push(f.pop());
    this.moves += 1;
    return true;
  }

  // Move the top of a foundation back to a free cell.
  moveFoundationToFree(fromFoundation, toCell) {
    const f = this.foundations[fromFoundation];
    if (!f || f.length === 0) return false;
    if (!this.canToFree(toCell)) return false;
    this.free[toCell] = f.pop();
    this.moves += 1;
    return true;
  }

  // ---- Win detection -------------------------------------------------------
  // The game is won when all 52 cards have reached the foundations.
  isWon() {
    return this.foundations.reduce((n, f) => n + f.length, 0) === 52;
  }
}
