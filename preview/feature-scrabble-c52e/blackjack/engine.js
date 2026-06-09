// Blackjack engine — the pure game core (you vs the dealer). No DOM, no
// rendering, no input: it owns the shoe, the player/dealer hands, the
// credits/bet bookkeeping, the hand-value math (soft/hard aces), the dealer
// auto-play, and the payout resolution. app.js drives it from the intent
// stream and renders its state.
//
// RULE CHOICES (documented):
//   - One standard 52-card deck, freshly shuffled for every round ("shoe"
//     reshuffled each hand). Keeps it simple and card-counting-proof.
//   - Dealer STANDS on all 17s, including soft 17 (S17).
//   - Blackjack (natural 21 on the first two cards) pays 3:2.
//   - DOUBLE allowed on any first two cards (doubles the bet, exactly one card).
//   - SPLIT allowed when the first two cards share the same RANK (so K+Q etc.
//     do NOT split here — same rank only, the stricter variant; documented).
//     Splitting creates two hands played left→right. No re-splitting (one split
//     per round). Split Aces receive exactly one card each and cannot hit.
//     A 21 made after a split counts as an ordinary 21, NOT a natural blackjack.
//   - Dealer checks for blackjack on reveal; a dealer natural beats everything
//     except a player natural (which pushes).

// A card is { rank, suit }. rank is 2..14 (11=J, 12=Q, 13=K, 14=A); suit is one
// of "S","H","D","C".

export const SUITS = ["S", "H", "D", "C"];
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

// Display helpers (pure, so they can be unit-tested).
export const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
export const RED_SUITS = new Set(["H", "D"]);
export function rankLabel(rank) {
  return { 11: "J", 12: "Q", 13: "K", 14: "A" }[rank] || String(rank);
}

export const MIN_BET = 5;
export const BET_STEP = 5;
export const MAX_BET = 100;
export const START_CREDITS = 100;
export const DEALER_STANDS_ON = 17; // dealer hits below this, stands on/above
export const BLACKJACK_PAYS = 1.5;  // 3:2

// Build a fresh ordered 52-card deck.
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) deck.push({ rank, suit });
  }
  return deck;
}

// Fisher–Yates shuffle (in place, returns the same array for chaining).
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---- Hand value (pure) -----------------------------------------------------
// A card's base point value: number cards face value, J/Q/K = 10, Ace = 11
// (counted down to 1 later if the hand would bust).
export function cardValue(card) {
  if (card.rank >= 11 && card.rank <= 13) return 10; // J, Q, K
  if (card.rank === 14) return 11;                   // Ace high (may drop to 1)
  return card.rank;                                  // 2..10
}

// Evaluate a set of cards. Returns { total, soft } where `total` is the best
// (highest not-busting if possible) total, and `soft` is true when an ace is
// still counted as 11 in that total. Aces start at 11 and each is demoted to 1
// while the total exceeds 21.
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c);
    if (c.rank === 14) aces++;
  }
  // Demote aces from 11→1 (subtract 10) until we stop busting or run out.
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  // The hand is "soft" if at least one ace is still valued at 11.
  const soft = aces > 0 && total <= 21;
  return { total, soft };
}

// A natural blackjack: exactly two cards totalling 21 (an ace + a ten-value).
export function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21;
}

export function isBust(cards) {
  return handValue(cards).total > 21;
}

// Play out the dealer's hand from a starting set of cards, drawing from `deck`
// (mutated) until reaching DEALER_STANDS_ON. Stands on all 17s incl. soft 17.
// Returns the final array of dealer cards.
export function playDealer(cards, deck) {
  const hand = cards.slice();
  while (true) {
    const { total } = handValue(hand);
    if (total >= DEALER_STANDS_ON) break; // S17: stand on 17+, soft or hard
    hand.push(deck.shift());
  }
  return hand;
}

// Resolve one player hand against the dealer's final hand. Returns a result:
//   { outcome, payout } where outcome ∈ "blackjack"|"win"|"push"|"lose"|"bust"
//   and `payout` is the TOTAL credits returned to the player for this hand
//   (i.e. including the original stake on a win/push; 0 on a loss/bust).
// `bet` is the amount staked on this hand. `playerNatural`/`dealerNatural`
// flag two-card 21s (split hands are never naturals — pass false).
export function resolveHand(playerCards, dealerCards, bet, playerNatural, dealerNatural) {
  const p = handValue(playerCards).total;
  const d = handValue(dealerCards).total;

  if (p > 21) return { outcome: "bust", payout: 0 };

  // Naturals settle first.
  if (playerNatural && dealerNatural) return { outcome: "push", payout: bet };
  if (playerNatural) {
    return { outcome: "blackjack", payout: bet + Math.round(bet * BLACKJACK_PAYS) };
  }
  if (dealerNatural) return { outcome: "lose", payout: 0 };

  if (d > 21) return { outcome: "win", payout: bet * 2 };
  if (p > d) return { outcome: "win", payout: bet * 2 };
  if (p < d) return { outcome: "lose", payout: 0 };
  return { outcome: "push", payout: bet };
}

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
    this._clearTable();
  }

  _clearTable() {
    this.deck = [];
    this.dealer = [];
    this.dealerNatural = false;
    this.hands = [];        // array of { cards, bet, done, result, doubled, isSplitAce }
    this.active = 0;        // index of the hand currently being played
    this.phase = "bet";     // "bet" → "player" → "dealer" → "done" → ("bet")
    this.message = "";      // last round result summary
  }

  // ---- Betting (only in the bet phase) -------------------------------------
  // Cycle the bet up by one step, wrapping past the max back to the minimum.
  betOne() {
    if (this.phase !== "bet") return false;
    let next = this.bet + BET_STEP;
    if (next > MAX_BET || next > this.credits) next = MIN_BET;
    this.bet = next;
    return true;
  }

  // Jump to the largest bet the player can afford (capped at MAX_BET).
  betMax() {
    if (this.phase !== "bet") return false;
    const affordable = Math.floor(this.credits / BET_STEP) * BET_STEP;
    this.bet = Math.max(MIN_BET, Math.min(MAX_BET, affordable));
    return true;
  }

  canDeal() {
    return this.phase === "bet" && this.bet >= MIN_BET && this.credits >= this.bet;
  }

  // ---- Deal ----------------------------------------------------------------
  // Shuffle a fresh deck, take the bet, deal two to player and two to dealer
  // (dealer's second card is the face-down hole card), and enter the player
  // phase. If either side has a natural, settle immediately.
  deal() {
    if (!this.canDeal()) return false;
    this.deck = shuffle(makeDeck());
    this.credits -= this.bet;

    const playerCards = [this.deck.shift(), this.deck.shift()];
    this.dealer = [this.deck.shift(), this.deck.shift()];

    this.hands = [{
      cards: playerCards,
      bet: this.bet,
      done: false,
      result: null,
      doubled: false,
      isSplitAce: false,
    }];
    this.active = 0;
    this.dealerNatural = isBlackjack(this.dealer);
    this.message = "";

    // Natural on either side ends the player phase before any decision.
    if (isBlackjack(playerCards) || this.dealerNatural) {
      this.phase = "dealer";
      this._settle();
      return true;
    }

    this.phase = "player";
    return true;
  }

  // ---- Legality checks for the active hand ---------------------------------
  current() {
    return this.hands[this.active] || null;
  }

  // First-decision = the active hand still has exactly its two dealt cards.
  _isFirstDecision() {
    const h = this.current();
    return !!h && !h.done && h.cards.length === 2;
  }

  canHit() {
    const h = this.current();
    if (this.phase !== "player" || !h || h.done) return false;
    if (h.isSplitAce) return false; // split aces get one card only
    return true;
  }

  canStand() {
    const h = this.current();
    return this.phase === "player" && !!h && !h.done;
  }

  canDouble() {
    if (this.phase !== "player" || !this._isFirstDecision()) return false;
    const h = this.current();
    if (h.isSplitAce) return false;
    return this.credits >= h.bet; // need a matching stake
  }

  canSplit() {
    if (this.phase !== "player" || !this._isFirstDecision()) return false;
    if (this.hands.length >= 2) return false; // one split per round (no re-split)
    const h = this.current();
    if (h.cards[0].rank !== h.cards[1].rank) return false; // same rank only
    return this.credits >= h.bet; // need a matching stake for the new hand
  }

  // ---- Player actions ------------------------------------------------------
  // Returns a small descriptor of what happened, or null if the action was
  // illegal. app.js uses it for sounds/status.
  hit() {
    if (!this.canHit()) return null;
    const h = this.current();
    h.cards.push(this.deck.shift());
    if (isBust(h.cards)) {
      h.done = true;
      this._advance();
      return { event: "bust" };
    }
    if (handValue(h.cards).total === 21) {
      // Auto-stand the hand on a 21 — no reason to hit.
      h.done = true;
      this._advance();
      return { event: "twentyOne" };
    }
    return { event: "hit" };
  }

  stand() {
    if (!this.canStand()) return null;
    this.current().done = true;
    this._advance();
    return { event: "stand" };
  }

  double() {
    if (!this.canDouble()) return null;
    const h = this.current();
    this.credits -= h.bet; // match the original stake
    h.bet *= 2;
    h.doubled = true;
    h.cards.push(this.deck.shift()); // exactly one card
    h.done = true;
    const busted = isBust(h.cards);
    this._advance();
    return { event: busted ? "doubleBust" : "double" };
  }

  split() {
    if (!this.canSplit()) return null;
    const h = this.current();
    const splittingAces = h.cards[0].rank === 14;
    this.credits -= h.bet; // stake the second hand

    const moved = h.cards.pop();
    const second = {
      cards: [moved],
      bet: h.bet,
      done: false,
      result: null,
      doubled: false,
      isSplitAce: splittingAces,
    };
    h.isSplitAce = splittingAces;

    // Deal one fresh card to each split hand.
    h.cards.push(this.deck.shift());
    second.cards.push(this.deck.shift());

    // Insert the new hand right after the active one.
    this.hands.splice(this.active + 1, 0, second);

    // Split aces auto-stand (one card each, already dealt). Otherwise the
    // current hand stays active for further decisions.
    if (splittingAces) {
      h.done = true;
      second.done = true;
      this._advance();
    } else if (handValue(h.cards).total === 21) {
      // A split hand that lands on 21 auto-stands (it's not a natural).
      h.done = true;
      this._advance();
    }
    return { event: "split" };
  }

  // Move to the next undone hand; when all hands are done, hand off to the
  // dealer and settle the round.
  _advance() {
    let i = this.active + 1;
    while (i < this.hands.length && this.hands[i].done) i++;
    if (i < this.hands.length) {
      this.active = i;
      // A freshly-reached split hand that already shows 21 auto-stands.
      const h = this.hands[i];
      if (!h.isSplitAce && handValue(h.cards).total === 21) {
        h.done = true;
        this._advance();
      }
      return;
    }
    this.phase = "dealer";
    this._settle();
  }

  // ---- Dealer + settlement -------------------------------------------------
  _settle() {
    // If every player hand busted (or it was a natural showdown), the dealer
    // still reveals but only draws when at least one live hand can win.
    const anyLive = this.hands.some((h) => !isBust(h.cards));
    if (anyLive && !this.dealerNatural) {
      this.dealer = playDealer(this.dealer, this.deck);
    }

    let net = 0; // credits returned to bankroll across all hands
    for (const h of this.hands) {
      const playerNatural = this.hands.length === 1 && isBlackjack(h.cards);
      const r = resolveHand(h.cards, this.dealer, h.bet, playerNatural, this.dealerNatural);
      h.result = r.outcome;
      this.credits += r.payout;
      net += r.payout - h.bet; // profit/loss on this hand
    }

    this.phase = "done";
    this.lastNet = net;
    this.message = this._summary(net);
  }

  _summary(net) {
    if (this.hands.length === 1) {
      const o = this.hands[0].result;
      const map = {
        blackjack: "Blackjack! ",
        win: "You win ",
        push: "Push — bet returned",
        lose: "Dealer wins",
        bust: "Bust — you lose",
      };
      const base = map[o] || "";
      if (o === "push") return base;
      if (o === "lose" || o === "bust") return base;
      return `${base}+${net}`;
    }
    // Split: report the net across both hands.
    if (net > 0) return `Split resolved +${net}`;
    if (net < 0) return `Split resolved ${net}`;
    return "Split resolved — even";
  }

  // True once the bankroll can no longer cover the minimum bet.
  isBroke() {
    return this.phase !== "player" && this.credits < MIN_BET;
  }

  // Ready the table for the next round (keep credits, snap bet to affordable).
  nextRound() {
    if (this.bet > this.credits) {
      this.bet = Math.max(MIN_BET, Math.floor(this.credits / BET_STEP) * BET_STEP);
    }
    this._clearTable();
  }
}
