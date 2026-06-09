// Texas Hold'em engine — the pure game core. No DOM, no rendering, no input.
// It owns the deck, the four seats, the betting state machine, the pot, hand
// evaluation, and showdown. app.js drives it from the intent stream / buttons,
// renders its state, and supplies the AI decisions.
//
// BETTING MODEL (deliberately simple, to be bug-free):
//   - 4 seats, fixed blinds, rotating dealer button.
//   - A betting round runs until every still-in player has either matched the
//     current bet or is all-in. We use standard no-limit-style actions
//     (fold / check / call / raise / all-in).
//   - SIDE POTS: fully implemented. When players are all-in for different
//     amounts, contributions are split into a main pot + side pots and each pot
//     is awarded only to eligible (contributing, non-folded) players. This keeps
//     all-in handling correct and chips conserved.
//   - Min-raise: the raise increment must be at least the size of the previous
//     bet/raise (defaults to the big blind preflop). A short all-in for less
//     than a full raise is allowed but does NOT reopen the betting for players
//     who have already acted (standard rule).
//
// HAND EVALUATION: best 5-card hand out of up to 7 cards, returned as a
// comparable score array [category, ...tiebreakers] where higher is better.

// ---- Cards ----------------------------------------------------------------
// A card is { rank, suit } where rank is 2..14 (11=J,12=Q,13=K,14=A) and suit
// is one of "s","h","d","c".
export const SUITS = ["s", "h", "d", "c"];
export const SUIT_SYMBOL = { s: "♠", h: "♥", d: "♦", c: "♣" };
export const RANK_LABEL = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9",
  10: "10", 11: "J", 12: "Q", 13: "K", 14: "A",
};

// Hand category constants (higher = stronger).
export const CAT = {
  HIGH_CARD: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};
export const CAT_NAME = [
  "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
  "Flush", "Full House", "Four of a Kind", "Straight Flush",
];

export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (let rank = 2; rank <= 14; rank++) deck.push({ rank, suit });
  }
  return deck;
}

// Fisher–Yates shuffle (in place); accepts an optional rng for deterministic tests.
export function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// ---- Hand evaluation ------------------------------------------------------

// Evaluate exactly five cards. Returns a comparable score array
// [category, tiebreaker...]; compare two scores with compareScore().
function eval5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  // Count occurrences of each rank.
  const counts = new Map();
  for (const r of ranks) counts.set(r, (counts.get(r) || 0) + 1);
  // Sort ranks by (count desc, rank desc) — the canonical tiebreaker order.
  const byCount = [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || b[0] - a[0]
  );
  const countShape = byCount.map((e) => e[1]); // e.g. [3,2] for a full house
  const orderedRanks = byCount.map((e) => e[0]);

  // Straight detection, including the wheel (A-2-3-4-5 where A counts low).
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[4] === 2) straightHigh = 5; // wheel
  }

  if (isFlush && straightHigh) return [CAT.STRAIGHT_FLUSH, straightHigh];
  if (countShape[0] === 4) return [CAT.QUADS, orderedRanks[0], orderedRanks[1]];
  if (countShape[0] === 3 && countShape[1] === 2)
    return [CAT.FULL_HOUSE, orderedRanks[0], orderedRanks[1]];
  if (isFlush) return [CAT.FLUSH, ...ranks];
  if (straightHigh) return [CAT.STRAIGHT, straightHigh];
  if (countShape[0] === 3) return [CAT.TRIPS, ...orderedRanks]; // trip rank, then 2 kickers
  if (countShape[0] === 2 && countShape[1] === 2)
    return [CAT.TWO_PAIR, orderedRanks[0], orderedRanks[1], orderedRanks[2]];
  if (countShape[0] === 2) return [CAT.PAIR, ...orderedRanks]; // pair rank, then 3 kickers
  return [CAT.HIGH_CARD, ...ranks];
}

// Compare two score arrays. >0 if a is the stronger hand, <0 if b, 0 if tie.
export function compareScore(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// Best 5-card score out of up to 7 cards. Returns { score, name }.
export function evaluate(cards) {
  if (cards.length < 5) throw new Error("need at least 5 cards");
  let best = null;
  // Choose 5 of N (N <= 7 → at most 21 combos).
  const n = cards.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const score = eval5([cards[a], cards[b], cards[c], cards[d], cards[e]]);
            if (!best || compareScore(score, best) > 0) best = score;
          }
  return { score: best, name: CAT_NAME[best[0]] };
}

// ---- Engine ---------------------------------------------------------------

export const STREET = ["preflop", "flop", "turn", "river", "showdown"];

export class Engine {
  /**
   * @param {object} [opts]
   * @param {number} [opts.startingChips=1000]
   * @param {number} [opts.smallBlind=10]
   * @param {number} [opts.bigBlind=20]
   * @param {string[]} [opts.names]
   * @param {() => number} [opts.rng]
   */
  constructor(opts = {}) {
    this.startingChips = opts.startingChips ?? 1000;
    this.smallBlind = opts.smallBlind ?? 10;
    this.bigBlind = opts.bigBlind ?? 20;
    this.rng = opts.rng ?? Math.random;
    const names = opts.names ?? ["You", "Bot West", "Bot North", "Bot East"];
    // Seat 0 is always the human.
    this.players = names.map((name, i) => ({
      name,
      isHuman: i === 0,
      chips: this.startingChips,
      hole: [],         // two hole cards
      bet: 0,           // chips committed in the current betting round
      committed: 0,     // total chips committed across the whole hand (for side pots)
      folded: false,
      allIn: false,
      out: false,       // eliminated from the game (0 chips, between hands)
      acted: false,     // has acted since the last raise this round
      lastAction: "",   // human-readable last action label
    }));
    this.button = 0;            // dealer button seat index
    this.handNumber = 0;
    this.pots = [];             // resolved side pots, only used at showdown
    this.community = [];
    this.deck = [];
    this.street = "idle";       // idle | preflop | flop | turn | river | showdown
    this.toAct = -1;            // seat whose turn it is, or -1
    this.currentBet = 0;        // highest bet in the current round
    this.minRaise = this.bigBlind; // minimum raise increment
    this.lastAggressor = -1;
    this.results = null;        // showdown result once the hand is over
  }

  // ---- Helpers ------------------------------------------------------------
  activePlayers() {
    // Players still in the game (not eliminated).
    return this.players.filter((p) => !p.out);
  }

  // Seats still contesting the pot this hand (not folded, not eliminated).
  inHand() {
    return this.players.filter((p) => !p.folded && !p.out);
  }

  // Seats that can still make a betting decision (in hand and not all-in).
  canAct() {
    return this.players.filter((p) => !p.folded && !p.out && !p.allIn);
  }

  // Total of all chips committed this hand (current round bets are part of
  // committed only after a round resolves; pot() sums both safely).
  pot() {
    let total = this.pots.reduce((s, p) => s + p.amount, 0);
    for (const p of this.players) total += p.committed + p.bet;
    return total;
  }

  // Sum of every chip in play (stacks + everything in the pot). Constant across
  // a hand — used by the self-test to verify conservation.
  totalChips() {
    let total = this.pots.reduce((s, p) => s + p.amount, 0);
    for (const p of this.players) total += p.chips + p.committed + p.bet;
    return total;
  }

  // Next non-eliminated seat clockwise from `seat`.
  nextSeat(seat) {
    let i = seat;
    for (let n = 0; n < this.players.length; n++) {
      i = (i + 1) % this.players.length;
      if (!this.players[i].out) return i;
    }
    return seat;
  }

  // ---- Hand setup ---------------------------------------------------------
  startHand() {
    const alive = this.activePlayers();
    if (alive.length < 2) return false; // game over

    this.handNumber += 1;
    this.results = null;
    this.pots = [];
    this.community = [];
    this.deck = shuffle(makeDeck(), this.rng);

    for (const p of this.players) {
      p.hole = [];
      p.bet = 0;
      p.committed = 0;
      p.folded = p.out; // eliminated players sit out
      p.allIn = false;
      p.acted = false;
      p.lastAction = p.out ? "Out" : "";
    }

    // Move the button to the next live seat (first hand keeps seat 0's choice).
    if (this.handNumber > 1) this.button = this.nextSeat(this.button);

    // Blinds. Heads-up uses the standard rule (button is small blind); with 3+
    // players the small blind is left of the button.
    const liveCount = alive.length;
    let sbSeat, bbSeat;
    if (liveCount === 2) {
      sbSeat = this.button;
      bbSeat = this.nextSeat(this.button);
    } else {
      sbSeat = this.nextSeat(this.button);
      bbSeat = this.nextSeat(sbSeat);
    }

    this._postBlind(sbSeat, this.smallBlind);
    this._postBlind(bbSeat, this.bigBlind);
    this.players[sbSeat].lastAction = "Small blind";
    this.players[bbSeat].lastAction = "Big blind";

    // Deal two hole cards to each live player (one at a time, like a real deal).
    for (let round = 0; round < 2; round++) {
      let seat = sbSeat;
      for (let n = 0; n < liveCount; n++) {
        const p = this.players[seat];
        p.hole.push(this.deck.pop());
        seat = this.nextSeat(seat);
      }
    }

    this.street = "preflop";
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;
    this.lastAggressor = bbSeat; // betting reopens up to the big blind
    // First to act preflop is left of the big blind.
    this.toAct = this.nextSeat(bbSeat);
    this._skipToActable();
    return true;
  }

  _postBlind(seat, amount) {
    const p = this.players[seat];
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    if (p.chips === 0) p.allIn = true;
  }

  // ---- Legal-action queries -----------------------------------------------
  // The amount the player to act must add to call.
  callAmount(seat = this.toAct) {
    const p = this.players[seat];
    return Math.max(0, Math.min(this.currentBet - p.bet, p.chips));
  }

  // Can the seat to act check (no chips owed)?
  canCheck(seat = this.toAct) {
    return this.players[seat].bet === this.currentBet;
  }

  // Minimum total bet the seat would have to reach to make a legal raise.
  // Returns null if the player can't make a full raise (they may still go
  // all-in for less, which is handled by act("allin")).
  minRaiseTo(seat = this.toAct) {
    const p = this.players[seat];
    const target = this.currentBet + this.minRaise;
    if (p.bet + p.chips <= this.currentBet) return null; // can't even call fully
    return Math.min(target, p.bet + p.chips);
  }

  // Total chips a seat can put in if shoving all-in.
  allInTo(seat = this.toAct) {
    const p = this.players[seat];
    return p.bet + p.chips;
  }

  // ---- Player actions -----------------------------------------------------
  // action: "fold" | "check" | "call" | "raise" | "allin"
  // For "raise", `raiseTo` is the total bet to reach this round (defaults to the
  // minimum legal raise). Returns true if the action was applied.
  act(action, raiseTo) {
    const seat = this.toAct;
    if (seat < 0) return false;
    const p = this.players[seat];
    if (p.folded || p.allIn || p.out) return false;

    switch (action) {
      case "fold":
        p.folded = true;
        p.lastAction = "Fold";
        break;

      case "check":
        if (!this.canCheck(seat)) return false;
        p.lastAction = "Check";
        break;

      case "call": {
        const owe = this.callAmount(seat);
        if (owe === 0) { p.lastAction = "Check"; break; }
        this._commit(p, owe);
        p.lastAction = p.allIn ? "All-in call" : "Call";
        break;
      }

      case "raise": {
        // Default to the minimum legal raise.
        const target = raiseTo ?? this.minRaiseTo(seat);
        if (target == null) return false;
        const maxTo = p.bet + p.chips;
        const to = Math.min(target, maxTo);
        // Must be a genuine raise above the current bet.
        if (to <= this.currentBet) return false;
        const raiseBy = to - this.currentBet;
        this._commit(p, to - p.bet);
        // A full raise reopens betting and resets the min-raise increment.
        if (raiseBy >= this.minRaise) {
          this.minRaise = raiseBy;
          this._reopen(seat);
        }
        this.currentBet = Math.max(this.currentBet, p.bet);
        this.lastAggressor = seat;
        p.lastAction = p.allIn ? "All-in" : "Raise to " + this.currentBet;
        break;
      }

      case "allin": {
        const before = this.currentBet;
        const add = p.chips;
        this._commit(p, add); // commits everything; sets allIn
        if (p.bet > before) {
          // This shove raised the bet.
          const raiseBy = p.bet - before;
          this.currentBet = p.bet;
          if (raiseBy >= this.minRaise) {
            this.minRaise = raiseBy;
            this._reopen(seat);
          }
          this.lastAggressor = seat;
          p.lastAction = "All-in";
        } else {
          p.lastAction = "All-in call";
        }
        break;
      }

      default:
        return false;
    }

    p.acted = true;
    this._advance();
    return true;
  }

  // Move chips from a player's stack into their round bet, flagging all-in.
  _commit(p, amount) {
    const pay = Math.min(amount, p.chips);
    p.chips -= pay;
    p.bet += pay;
    if (p.chips === 0) p.allIn = true;
  }

  // Reopen betting: everyone except the raiser must act again.
  _reopen(raiserSeat) {
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (i === raiserSeat || p.folded || p.out || p.allIn) continue;
      p.acted = false;
    }
  }

  // Move the turn forward, resolving the round / street as needed.
  _advance() {
    // If only one player remains un-folded, the hand ends immediately.
    if (this.inHand().length <= 1) { this._finishHand(); return; }

    // Round is complete when every actable player has acted and matched the bet.
    if (this._roundComplete()) {
      this._endRound();
      return;
    }

    // Otherwise pass to the next player who can act.
    this.toAct = this.nextSeat(this.toAct);
    this._skipToActable();
  }

  // Advance toAct past players who can't act (folded / all-in). If nobody can
  // act, end the round.
  _skipToActable() {
    let guard = 0;
    while (guard++ < this.players.length) {
      const p = this.players[this.toAct];
      if (!p.folded && !p.out && !p.allIn) return;
      this.toAct = this.nextSeat(this.toAct);
    }
    // No one can act → resolve the round.
    this._endRound();
  }

  _roundComplete() {
    const actable = this.canAct();
    if (actable.length === 0) return true;
    return actable.every((p) => p.acted && p.bet === this.currentBet);
  }

  // ---- Round / street transitions -----------------------------------------
  _endRound() {
    // Fold round bets into per-hand committed totals (we don't build side pots
    // until showdown; pot() already counts both, so chips stay conserved).
    for (const p of this.players) {
      p.committed += p.bet;
      p.bet = 0;
      p.acted = false;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    // If at most one player can still act AND all bets are settled, run the
    // remaining streets out automatically to showdown.
    if (this.inHand().length <= 1) { this._finishHand(); return; }

    switch (this.street) {
      case "preflop": this._dealCommunity(3); this.street = "flop"; break;
      case "flop": this._dealCommunity(1); this.street = "turn"; break;
      case "turn": this._dealCommunity(1); this.street = "river"; break;
      case "river": this._finishHand(); return;
      default: this._finishHand(); return;
    }

    // If only one (or zero) players can still act, no more betting is possible:
    // deal out the rest of the board and go to showdown.
    if (this.canAct().length <= 1 && this._allMatched()) {
      this._runOut();
      return;
    }

    // New round: first to act is left of the button (heads-up: the button acts
    // first post-flop is NOT standard; for 3+ left of button is correct, and we
    // keep it simple and correct by starting left of the button among actable).
    this.toAct = this.nextSeat(this.button);
    this._skipToActable();
  }

  // True when no outstanding bet remains (everyone in-hand has equal commitment
  // for the round). Used to decide whether to auto-run-out the board.
  _allMatched() {
    return this.players
      .filter((p) => !p.folded && !p.out && !p.allIn)
      .every((p) => p.bet === this.currentBet);
  }

  _dealCommunity(n) {
    for (let i = 0; i < n; i++) this.community.push(this.deck.pop());
  }

  // Deal whatever community cards remain, then go to showdown (used when all
  // remaining players are all-in).
  _runOut() {
    while (this.community.length < 5) this.community.push(this.deck.pop());
    this.street = "river";
    this._finishHand();
  }

  // ---- Showdown / hand resolution -----------------------------------------
  _finishHand() {
    // Pull any in-round bets into committed first.
    for (const p of this.players) {
      p.committed += p.bet;
      p.bet = 0;
    }

    const contenders = this.inHand();

    // Single player left (everyone else folded): they take the whole pot.
    if (contenders.length === 1) {
      const winner = contenders[0];
      const amount = this._collectPot();
      winner.chips += amount;
      this.results = {
        winnersBySeat: [this.players.indexOf(winner)],
        showdown: false,
        pots: [{ amount, winners: [this.players.indexOf(winner)] }],
        evaluations: {},
      };
      this._finishUp();
      return;
    }

    // Showdown: evaluate every contender's best hand.
    const evals = {};
    for (const p of contenders) {
      const idx = this.players.indexOf(p);
      evals[idx] = evaluate([...p.hole, ...this.community]);
    }

    // Build side pots from per-player committed amounts, then award each pot to
    // the best eligible hand(s).
    const potResults = this._buildAndAwardSidePots(evals);

    const winnersBySeat = new Set();
    for (const pot of potResults) for (const w of pot.winners) winnersBySeat.add(w);

    this.results = {
      winnersBySeat: [...winnersBySeat],
      showdown: true,
      pots: potResults,
      evaluations: evals,
    };
    this._finishUp();
  }

  // Sum every committed chip into one number and zero the committed fields.
  _collectPot() {
    let total = this.pots.reduce((s, p) => s + p.amount, 0);
    this.pots = [];
    for (const p of this.players) { total += p.committed; p.committed = 0; }
    return total;
  }

  // Split the committed chips into main + side pots and award each to the best
  // eligible (non-folded) hand. Folded players' chips stay in the pots but they
  // can't win. Returns [{ amount, winners:[seat...], eligible:[seat...] }].
  _buildAndAwardSidePots(evals) {
    // Snapshot each player's total contribution this hand.
    const contrib = this.players.map((p) => p.committed);
    const pots = [];

    // Distinct positive contribution levels, ascending. Each level forms a pot
    // layer that everyone who put in at least that much shares.
    const levels = [...new Set(contrib.filter((c) => c > 0))].sort((a, b) => a - b);
    let prev = 0;
    for (const level of levels) {
      const layer = level - prev;
      let amount = 0;
      const eligible = [];
      for (let i = 0; i < this.players.length; i++) {
        if (contrib[i] >= level) {
          amount += layer;                      // each qualifying player adds `layer`
          if (!this.players[i].folded && !this.players[i].out) eligible.push(i);
        }
      }
      pots.push({ amount, eligible });
      prev = level;
    }

    // Award each pot to the best eligible hand(s), splitting ties (odd chips go
    // to the earliest seat left of the button — a fair, deterministic rule).
    const results = [];
    for (const pot of pots) {
      if (pot.amount === 0) continue;
      let best = null;
      let winners = [];
      for (const seat of pot.eligible) {
        const sc = evals[seat].score;
        if (!best || compareScore(sc, best) > 0) { best = sc; winners = [seat]; }
        else if (compareScore(sc, best) === 0) winners.push(seat);
      }
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      // Order winners by seat distance left of the button for odd-chip awarding.
      const ordered = [...winners].sort(
        (a, b) => this._seatOrder(a) - this._seatOrder(b)
      );
      for (const seat of ordered) {
        let award = share;
        if (remainder > 0) { award += 1; remainder -= 1; }
        this.players[seat].chips += award;
      }
      results.push({ amount: pot.amount, winners: ordered, eligible: pot.eligible });
    }

    // Zero out committed now that everything is distributed.
    for (const p of this.players) p.committed = 0;
    this.pots = [];
    return results;
  }

  // Distance of a seat clockwise from the button (1 = small blind seat). Used to
  // award odd chips deterministically.
  _seatOrder(seat) {
    let i = this.button;
    for (let d = 1; d <= this.players.length; d++) {
      i = (i + 1) % this.players.length;
      if (i === seat) return d;
    }
    return this.players.length;
  }

  // Mark busted players and decide whether the game is over.
  _finishUp() {
    for (const p of this.players) {
      p.bet = 0;
      if (p.chips <= 0 && !p.out) { p.out = true; p.chips = 0; p.lastAction = "Out"; }
    }
    this.street = "showdown";
    this.toAct = -1;
  }

  // True when the game is over (the human busted, or only one player remains).
  isGameOver() {
    const alive = this.activePlayers();
    return alive.length <= 1 || this.players[0].out;
  }

  // The single remaining player (or human if they busted), for game-over copy.
  gameWinner() {
    const alive = this.activePlayers();
    if (alive.length === 1) return alive[0];
    return null;
  }

  // Reset every stack and start fresh (used by "play again").
  resetGame() {
    for (const p of this.players) {
      p.chips = this.startingChips;
      p.out = false;
      p.folded = false;
      p.allIn = false;
      p.hole = [];
      p.bet = 0;
      p.committed = 0;
      p.lastAction = "";
    }
    this.button = 0;
    this.handNumber = 0;
    this.community = [];
    this.pots = [];
    this.street = "idle";
    this.toAct = -1;
    this.results = null;
  }
}
