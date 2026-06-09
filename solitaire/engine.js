// Klondike Solitaire engine — the pure game core. No DOM, no rendering, no
// input: it owns the deck, the 7 tableau piles, the 4 foundations, the stock and
// the waste, plus all move-legality rules and win detection. app.js drives it
// from the intent stream and renders its state.
//
// DRAW MODE: this is DRAW-1 Klondike (turn one card from the stock to the waste
// per click). Draw-1 is simpler to reason about and the deal is (almost) always
// winnable, which makes for a friendlier game than the classic draw-3 variant.

// A card is { rank, suit, faceUp }. rank is 1..13 (1=A, 11=J, 12=Q, 13=K); suit
// is one of "S","H","D","C". Foundations build UP A→K within a suit; tableau
// piles build DOWN by alternating colour.

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

export const FOUNDATION_COUNT = 4;
export const TABLEAU_COUNT = 7;

// Build a fresh ordered 52-card deck (all face-down).
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit, faceUp: false });
  }
  return deck;
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

  // Deal a fresh game: shuffle 52 cards, lay the 7 tableau piles (pile i gets
  // i+1 cards, only the top face-up), and pile the remaining 24 into the stock.
  reset(rng = Math.random) {
    const deck = shuffle(makeDeck(), rng);

    this.tableau = [];
    for (let i = 0; i < TABLEAU_COUNT; i++) {
      const pile = [];
      for (let j = 0; j <= i; j++) {
        const card = deck.pop();
        card.faceUp = j === i; // only the top card of each pile starts face-up
        pile.push(card);
      }
      this.tableau.push(pile);
    }

    // Foundations: one (initially empty) pile per suit, indexed 0..3.
    this.foundations = [[], [], [], []];

    // Remaining 24 cards form the stock (face-down); the waste starts empty.
    this.stock = deck.map((c) => ({ ...c, faceUp: false }));
    this.waste = [];

    this.moves = 0;
    this.score = 0;
  }

  // ---- Stock / waste -------------------------------------------------------
  // Draw one card from the stock to the waste (face-up). When the stock is
  // empty, recycle the whole waste back into the stock (face-down, order
  // reset). Returns "draw", "recycle", or null when nothing happened.
  drawFromStock() {
    if (this.stock.length > 0) {
      const card = this.stock.pop();
      card.faceUp = true;
      this.waste.push(card);
      this.moves += 1;
      return "draw";
    }
    if (this.waste.length > 0) {
      // Recycle: the waste flips back to a face-down stock, oldest-on-top so the
      // next draw repeats the same sequence.
      while (this.waste.length > 0) {
        const card = this.waste.pop();
        card.faceUp = false;
        this.stock.push(card);
      }
      this.moves += 1;
      return "recycle";
    }
    return null;
  }

  // ---- Move legality (pure predicates) -------------------------------------
  // A card may go on a tableau pile if the pile is empty and the card is a King,
  // or the pile's top card is one rank higher and the opposite colour.
  canPlaceOnTableau(card, pileIndex) {
    const pile = this.tableau[pileIndex];
    if (!pile) return false;
    if (pile.length === 0) return card.rank === 13; // only a King on an empty pile
    const top = pile[pile.length - 1];
    if (!top.faceUp) return false;
    return top.rank === card.rank + 1 && isRed(top) !== isRed(card);
  }

  // A card may go on a foundation if it's an Ace onto an empty foundation, or
  // the next rank up of the same suit.
  canPlaceOnFoundation(card, foundationIndex) {
    const f = this.foundations[foundationIndex];
    if (!f) return false;
    if (f.length === 0) return card.rank === 1; // Aces start a foundation
    const top = f[f.length - 1];
    return top.suit === card.suit && card.rank === top.rank + 1;
  }

  // True if the face-up cards from `cardIndex` to the top of tableau `pileIndex`
  // form a valid descending, alternating-colour sequence (so they can move as a
  // group). A single face-up card is trivially a valid sequence.
  isValidSequence(pileIndex, cardIndex) {
    const pile = this.tableau[pileIndex];
    if (!pile || cardIndex < 0 || cardIndex >= pile.length) return false;
    if (!pile[cardIndex].faceUp) return false;
    for (let i = cardIndex; i < pile.length - 1; i++) {
      const upper = pile[i];
      const lower = pile[i + 1];
      if (upper.rank !== lower.rank + 1 || isRed(upper) === isRed(lower)) return false;
    }
    return true;
  }

  // ---- Moves (mutating) ----------------------------------------------------
  // Move the sequence starting at `cardIndex` of tableau `fromPile` onto tableau
  // `toPile`. Validates the source is a legal sequence and the destination
  // accepts the bottom (moving) card. Flips the newly exposed card. Returns
  // true on success.
  moveTableauToTableau(fromPile, cardIndex, toPile) {
    if (fromPile === toPile) return false;
    if (!this.isValidSequence(fromPile, cardIndex)) return false;
    const src = this.tableau[fromPile];
    const moving = src[cardIndex]; // the card actually landing on the destination
    if (!this.canPlaceOnTableau(moving, toPile)) return false;

    const group = src.splice(cardIndex);
    this.tableau[toPile].push(...group);
    this._flipExposed(src);
    this.moves += 1;
    return true;
  }

  // Move the single top card of tableau `fromPile` to foundation `toFoundation`.
  moveTableauToFoundation(fromPile, toFoundation) {
    const src = this.tableau[fromPile];
    if (!src || src.length === 0) return false;
    const card = src[src.length - 1];
    if (!card.faceUp) return false;
    if (!this.canPlaceOnFoundation(card, toFoundation)) return false;
    this.foundations[toFoundation].push(src.pop());
    this._flipExposed(src);
    this.score += 10;
    this.moves += 1;
    return true;
  }

  // Move the top of the waste onto a tableau pile.
  moveWasteToTableau(toPile) {
    if (this.waste.length === 0) return false;
    const card = this.waste[this.waste.length - 1];
    if (!this.canPlaceOnTableau(card, toPile)) return false;
    this.tableau[toPile].push(this.waste.pop());
    this.moves += 1;
    return true;
  }

  // Move the top of the waste onto a foundation.
  moveWasteToFoundation(toFoundation) {
    if (this.waste.length === 0) return false;
    const card = this.waste[this.waste.length - 1];
    if (!this.canPlaceOnFoundation(card, toFoundation)) return false;
    this.foundations[toFoundation].push(this.waste.pop());
    this.score += 10;
    this.moves += 1;
    return true;
  }

  // Move the top of a foundation back down onto a tableau pile (allowed in
  // Klondike — sometimes needed to free a card for a longer sequence).
  moveFoundationToTableau(fromFoundation, toPile) {
    const f = this.foundations[fromFoundation];
    if (!f || f.length === 0) return false;
    const card = f[f.length - 1];
    if (!this.canPlaceOnTableau(card, toPile)) return false;
    this.tableau[toPile].push(f.pop());
    this.score -= 10;
    this.moves += 1;
    return true;
  }

  // After removing cards from a tableau pile, flip its new top card face-up.
  _flipExposed(pile) {
    if (pile.length > 0) {
      const top = pile[pile.length - 1];
      if (!top.faceUp) {
        top.faceUp = true;
        this.score += 5; // small reward for exposing a hidden card
      }
    }
  }

  // ---- Win detection -------------------------------------------------------
  // The game is won when all 52 cards have reached the foundations.
  isWon() {
    return this.foundations.reduce((n, f) => n + f.length, 0) === 52;
  }
}
