// Uno engine — the pure game core. No DOM, no rendering, no input, no timers:
// it owns the deck (stock), the discard pile, the four hands, the play
// direction, whose turn it is, the pending colour for wilds, and all the rules
// (legal-play matching, action-card effects, reshuffle when stock empties, and
// win detection). app.js drives it from the intent stream / AI and renders it.
//
// A card is { color, value }:
//   color: "red" | "yellow" | "green" | "blue" | "wild"
//   value: "0".."9" | "skip" | "reverse" | "draw2"          (coloured)
//          "wild" | "wild4"                                  (wild, color "wild")
// The discard's *effective* colour for matching is `this.activeColor`, which a
// wild sets explicitly (the discarded wild card keeps color "wild").

export const COLORS = ["red", "yellow", "green", "blue"];
export const NUMBERS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
export const ACTIONS = ["skip", "reverse", "draw2"];

// Player names. Seat 0 is the human ("You"); 1..3 are the AI bots, seated
// around the table (left → across → right in turn order).
export const PLAYER_NAMES = ["You", "West", "North", "East"];

// Human-readable label for a card's value (used by the renderer + status line).
export const VALUE_LABEL = {
  skip: "Skip",
  reverse: "Reverse",
  draw2: "Draw Two",
  wild: "Wild",
  wild4: "Wild Draw Four",
};

// Symbol/glyph drawn on the chip for non-number cards.
export const VALUE_GLYPH = {
  skip: "⊘",
  reverse: "⇄",
  draw2: "+2",
  wild: "★",
  wild4: "+4",
};

/** A card's short display label, e.g. "Red 7", "Green Skip", "Wild". */
export function cardName(card) {
  if (card.color === "wild") return VALUE_LABEL[card.value];
  const color = card.color[0].toUpperCase() + card.color.slice(1);
  const v = VALUE_LABEL[card.value] || card.value;
  return `${color} ${v}`;
}

// Build a fresh, ordered 108-card Uno deck:
//   per colour (×4): one 0, two each of 1..9, two Skip, two Reverse, two Draw Two
//   plus 4 Wild and 4 Wild Draw Four.
// Total = 4 × (1 + 18 + 2 + 2 + 2) + 8 = 4 × 25 + 8 = 108.
export function makeDeck() {
  const deck = [];
  for (const color of COLORS) {
    deck.push({ color, value: "0" }); // a single 0 per colour
    for (const n of NUMBERS.slice(1)) {
      deck.push({ color, value: n }); // two of each 1..9
      deck.push({ color, value: n });
    }
    for (const a of ACTIONS) {
      deck.push({ color, value: a }); // two of each action
      deck.push({ color, value: a });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ color: "wild", value: "wild" });
    deck.push({ color: "wild", value: "wild4" });
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

// Legal-play test (pure): is `card` playable on a discard whose effective colour
// is `activeColor` and whose face value is `topValue`?
//   - Wilds are always playable (we deliberately drop the "Wild Draw Four only
//     if you hold no matching colour" challenge rule — see README in app.js).
//   - Otherwise match on colour OR value (number/symbol).
export function isPlayable(card, activeColor, topValue) {
  if (card.color === "wild") return true;
  return card.color === activeColor || card.value === topValue;
}

export class Engine {
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  // Deal a fresh round. Each player gets 7 cards; the first number card off the
  // stock starts the discard. Starting-card choice (documented): if the turned
  // card is a Wild or any action card we simply bury it and turn another, so the
  // round always opens on a plain number with no immediate effect to resolve.
  reset() {
    this.stock = shuffle(makeDeck(), this.rng);
    this.discard = [];
    this.hands = [[], [], [], []];
    this.direction = 1;            // +1 clockwise, -1 counter-clockwise
    this.turn = 0;                 // seat index whose turn it is
    this.activeColor = null;       // effective colour to match (wilds set this)
    this.winner = null;            // seat index of the round winner, or null
    this.pendingWild = null;       // seat that must choose a colour, or null
    this.lastDrawn = null;         // card just drawn by the current player (or null)

    for (let i = 0; i < 7; i++) {
      for (let p = 0; p < 4; p++) this.hands[p].push(this._draw());
    }

    // Turn up a starting card; re-draw until it's a plain number. _draw() pops
    // from the END of the stock, so bury rejects at the FRONT (the bottom of the
    // pile) — otherwise we'd immediately redraw the same card forever.
    let start = this._draw();
    while (start.color === "wild" || ACTIONS.includes(start.value)) {
      this.stock.unshift(start);  // bury it at the bottom of the stock
      start = this._draw();
    }
    this.discard.push(start);
    this.activeColor = start.color;
  }

  // The current top of the discard pile.
  get top() {
    return this.discard[this.discard.length - 1];
  }

  // Draw one card from the stock, reshuffling the discard (minus its top) back
  // into the stock if the stock has run dry.
  _draw() {
    if (this.stock.length === 0) this._reshuffle();
    return this.stock.pop();
  }

  // Reshuffle: keep the current top of the discard, shuffle everything beneath
  // it back into the stock. If somehow both are empty, synthesise a fresh deck
  // (defensive; shouldn't happen in a normal 4-hand game).
  _reshuffle() {
    if (this.discard.length > 1) {
      const top = this.discard.pop();
      this.stock = shuffle(this.discard, this.rng);
      this.discard = [top];
    } else {
      this.stock = shuffle(makeDeck(), this.rng);
    }
  }

  // Seat that plays `steps` turns after `from` in the current direction.
  _nextSeat(from = this.turn, steps = 1) {
    return (from + this.direction * steps + 4 * steps) % 4;
  }

  // Indices (into the current player's hand) of every legal play right now.
  playableIndices(seat = this.turn) {
    const top = this.top;
    const out = [];
    this.hands[seat].forEach((card, i) => {
      if (isPlayable(card, this.activeColor, top.value)) out.push(i);
    });
    return out;
  }

  hasPlayable(seat = this.turn) {
    return this.playableIndices(seat).length > 0;
  }

  // Play the card at hand index `i` for the current player. For a Wild you must
  // pass `chosenColor` (one of COLORS); for coloured cards it is ignored.
  // Returns a result describing what happened, or null if the move was illegal:
  //   { card, effect, drewSeat, drawCount, skipped, reversed, won }
  // `effect` ∈ "none" | "skip" | "reverse" | "draw2" | "wild" | "wild4".
  play(i, chosenColor = null) {
    if (this.winner !== null || this.pendingWild !== null) return null;
    const hand = this.hands[this.turn];
    const card = hand[i];
    if (!card) return null;
    if (!isPlayable(card, this.activeColor, this.top.value)) return null;

    // Commit the card to the discard pile.
    hand.splice(i, 1);
    this.discard.push(card);
    this.lastDrawn = null;

    // Set the active colour: a wild needs the caller's choice; otherwise the
    // card's own colour governs.
    if (card.color === "wild") {
      const color = COLORS.includes(chosenColor) ? chosenColor : COLORS[0];
      this.activeColor = color;
    } else {
      this.activeColor = card.color;
    }

    const result = {
      card,
      effect: "none",
      drewSeat: null,
      drawCount: 0,
      skipped: false,
      reversed: false,
      won: false,
    };

    // Win check: emptying your hand ends the round immediately.
    if (hand.length === 0) {
      this.winner = this.turn;
      result.won = true;
      // Still record the card's nominal effect for the status line.
      result.effect = this._nominalEffect(card);
      return result;
    }

    // Resolve action effects.
    switch (card.value) {
      case "skip": {
        result.effect = "skip";
        const skipped = this._nextSeat();
        result.skipped = true;
        result.skippedSeat = skipped;
        this.turn = this._nextSeat(this.turn, 2); // skip the next player
        break;
      }
      case "reverse": {
        result.effect = "reverse";
        result.reversed = true;
        this.direction *= -1;
        this.turn = this._nextSeat(); // next in the new direction
        break;
      }
      case "draw2": {
        result.effect = "draw2";
        const victim = this._nextSeat();
        for (let k = 0; k < 2; k++) this.hands[victim].push(this._draw());
        result.drewSeat = victim;
        result.drawCount = 2;
        result.skipped = true;
        this.turn = this._nextSeat(this.turn, 2); // victim is also skipped
        break;
      }
      case "wild": {
        result.effect = "wild";
        this.turn = this._nextSeat();
        break;
      }
      case "wild4": {
        result.effect = "wild4";
        const victim = this._nextSeat();
        for (let k = 0; k < 4; k++) this.hands[victim].push(this._draw());
        result.drewSeat = victim;
        result.drawCount = 4;
        result.skipped = true;
        this.turn = this._nextSeat(this.turn, 2); // victim draws 4 and is skipped
        break;
      }
      default: {
        // Plain number: advance to the next seat.
        this.turn = this._nextSeat();
      }
    }
    return result;
  }

  // The nominal effect label for a winning card (no state change needed).
  _nominalEffect(card) {
    if (card.value === "skip") return "skip";
    if (card.value === "reverse") return "reverse";
    if (card.value === "draw2") return "draw2";
    if (card.value === "wild") return "wild";
    if (card.value === "wild4") return "wild4";
    return "none";
  }

  // Current player draws one card from stock. Records it as `lastDrawn` so the
  // UI can offer to play it if it's legal. Returns the drawn card (or null if
  // the round is over / a wild colour is pending).
  drawCard() {
    if (this.winner !== null || this.pendingWild !== null) return null;
    const card = this._draw();
    this.hands[this.turn].push(card);
    this.lastDrawn = card;
    return card;
  }

  // After drawing, the player either plays the drawn card (if legal) or passes.
  // `passTurn` advances to the next seat without playing.
  passTurn() {
    if (this.winner !== null) return;
    this.lastDrawn = null;
    this.turn = this._nextSeat();
  }

  // Is the just-drawn card playable right now?
  canPlayDrawn() {
    return (
      this.lastDrawn != null &&
      isPlayable(this.lastDrawn, this.activeColor, this.top.value)
    );
  }
}
