// Contract Bridge — pure rules engine (no DOM, no input, no rendering).
//
// This module owns EVERYTHING that is "the rules of bridge": the deck and deal,
// the auction (legal calls, who may double/redouble, when the auction ends, who
// becomes declarer), the play of the hand (follow-suit, trick winners, 13
// tricks, dummy), and the duplicate-style scoring of the final result.
//
// The companion app.js handles DOM rendering, the human's input, and the
// (deliberately simple) AI. Keeping rules here makes them testable in plain Node.
//
// ── SIMPLIFICATIONS (documented, never silently misleading) ────────────────
//  * NOBODY IS VULNERABLE. We model a single deal with both sides non-vulnerable.
//    All bonuses/penalties use the non-vulnerable column. (See scoreContract.)
//  * The DEALER IS ALWAYS SOUTH, and South always opens the auction. There is no
//    rotating dealer across deals — each "New deal" is an independent South-dealt
//    board. (Documented; simplifies seat math and is fully legal for one board.)
//  * SCORING SUBSET: we implement the standard, complete non-vulnerable result
//    scoring — trick score by strain, part-score vs game bonus, small/grand slam
//    bonuses, doubled/redoubled contract bonuses + made-overtricks, and
//    doubled/redoubled/undoubled undertrick penalties. We do NOT implement
//    honors bonuses (an optional rubber-bridge nicety, irrelevant to a single
//    duplicate-style board) — noted at scoreContract.
//  * The auction AI and the card-play AI live in app.js and are intentionally
//    weak heuristics; the ENGINE only enforces legality, never "good" play.

// ── Constants ──────────────────────────────────────────────────────────────

// Seats clockwise. South = 0 (the human). Partnerships: N–S vs E–W.
export const SEATS = ["S", "W", "N", "E"]; // index 0..3, clockwise order of play
export const SEAT_NAMES = { S: "South", W: "West", N: "North", E: "East" };
export const SOUTH = 0, WEST = 1, NORTH = 2, EAST = 3;

// Suits in bidding/sorting rank order (low → high): clubs, diamonds, hearts,
// spades. "NT" (no-trump) ranks above all suits in the auction but is not a
// card suit.
export const SUITS = ["C", "D", "H", "S"];
export const SUIT_SYMBOL = { C: "♣", D: "♦", H: "♥", S: "♠" };
// Strains used in the auction, low → high. NT outranks every suit at a level.
export const STRAINS = ["C", "D", "H", "S", "NT"];
export const STRAIN_LABEL = { C: "♣", D: "♦", H: "♥", S: "♠", NT: "NT" };

// Card ranks 2..14 (J=11, Q=12, K=13, A=14). RANK_LABEL maps for display.
export const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const RANK_LABEL = {
  2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7", 8: "8", 9: "9", 10: "10",
  11: "J", 12: "Q", 13: "K", 14: "A",
};

// High-card points for opening/responding heuristics (A=4,K=3,Q=2,J=1).
export const HCP = { 14: 4, 13: 3, 12: 2, 11: 1 };

// ── Helpers shared by engine + app ───────────────────────────────────────────

/** True for the red suits (hearts/diamonds) — used for red card colouring. */
export function isRedSuit(suit) {
  return suit === "H" || suit === "D";
}

/** Numeric rank of a strain in the auction (clubs lowest … NT highest). */
export function strainRank(strain) {
  return STRAINS.indexOf(strain);
}

/** A bid's absolute order: level*5 + strainRank, so higher = ranks higher. */
export function bidOrder(level, strain) {
  return level * STRAINS.length + strainRank(strain);
}

/** Partnership of a seat: 0 = N–S, 1 = E–W. */
export function sideOf(seat) {
  // S(0) and N(2) are one side; W(1) and E(3) the other.
  return seat % 2; // 0 → NS, 1 → EW
}

/** Are two seats partners? */
export function arePartners(a, b) {
  return a !== b && sideOf(a) === sideOf(b);
}

/** Next seat clockwise. */
export function nextSeat(seat) {
  return (seat + 1) % 4;
}

/** Sum of high-card points in a hand (array of {rank}). */
export function handHCP(hand) {
  let pts = 0;
  for (const c of hand) pts += HCP[c.rank] || 0;
  return pts;
}

/** Count cards of a suit in a hand. */
export function suitLength(hand, suit) {
  let n = 0;
  for (const c of hand) if (c.suit === suit) n++;
  return n;
}

// ── Deck / deal ──────────────────────────────────────────────────────────────

/** Build an ordered 52-card deck of { suit, rank } objects. */
export function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ suit, rank });
  return deck;
}

/** Fisher–Yates shuffle in place using the supplied rng (defaults Math.random). */
export function shuffle(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * Deal a shuffled 52-card deck into four 13-card hands, indexed by seat
 * (0=S,1=W,2=N,3=E). Each hand is returned sorted for display (by suit then
 * descending rank). Returns { hands }.
 */
export function deal(rng = Math.random) {
  const deck = shuffle(makeDeck(), rng);
  const hands = [[], [], [], []];
  for (let i = 0; i < deck.length; i++) hands[i % 4].push(deck[i]);
  for (const h of hands) sortHand(h);
  return { hands };
}

/** Sort a hand in place: suits S,H,D,C (display order), descending rank. */
export function sortHand(hand) {
  // Display order spades→hearts→diamonds→clubs (high suit first), high cards
  // first within a suit — the conventional way players fan their hand.
  const order = { S: 0, H: 1, D: 2, C: 3 };
  hand.sort((a, b) => (order[a.suit] - order[b.suit]) || (b.rank - a.rank));
  return hand;
}

// ── Auction ──────────────────────────────────────────────────────────────────
//
// A "call" is one of:
//   { type: "pass" }
//   { type: "bid", level, strain }     level 1..7, strain in STRAINS
//   { type: "double" }                 doubles opponents' last bid
//   { type: "redouble" }               redoubles an opponents' double of our bid
//
// Auction object:
//   { dealer, calls: [{seat, call}], contract|null, passedOut, ended }
// contract when set: { level, strain, declarer, doubled: 0|1|2 } where doubled
// is 0 (undoubled), 1 (doubled), 2 (redoubled).

/** Create a fresh auction for the given dealer seat. */
export function newAuction(dealer = SOUTH) {
  return {
    dealer,
    turn: dealer,
    calls: [],          // { seat, call }
    lastBid: null,      // { seat, level, strain } — last actual bid (not pass/dbl)
    doubled: 0,         // current doubled state of lastBid: 0 none, 1 dbl, 2 rdbl
    contract: null,
    passedOut: false,
    ended: false,
  };
}

/**
 * Is `call` legal right now in `auction`? Returns true/false. Pure check — does
 * not mutate.
 */
export function isLegalCall(auction, call) {
  if (auction.ended) return false;
  if (call.type === "pass") return true;

  if (call.type === "bid") {
    if (call.level < 1 || call.level > 7) return false;
    if (!STRAINS.includes(call.strain)) return false;
    // Must rank strictly higher than the last actual bid.
    if (!auction.lastBid) return true;
    return bidOrder(call.level, call.strain) >
      bidOrder(auction.lastBid.level, auction.lastBid.strain);
  }

  if (call.type === "double") {
    // Legal only if the last bid was made by an OPPONENT and it is currently
    // undoubled (you can't double your own side, or double a double).
    if (!auction.lastBid) return false;
    if (auction.doubled !== 0) return false;
    return sideOf(auction.lastBid.seat) !== sideOf(auction.turn);
  }

  if (call.type === "redouble") {
    // Legal only if the last bid is currently doubled AND that bid belongs to
    // OUR side (we redouble an opponent's double of our contract).
    if (!auction.lastBid) return false;
    if (auction.doubled !== 1) return false;
    return sideOf(auction.lastBid.seat) === sideOf(auction.turn);
  }

  return false;
}

/** All legal calls for the seat on turn (used to build/enable the bidding box). */
export function legalCalls(auction) {
  const calls = [];
  calls.push({ type: "pass" });
  for (let level = 1; level <= 7; level++) {
    for (const strain of STRAINS) {
      const c = { type: "bid", level, strain };
      if (isLegalCall(auction, c)) calls.push(c);
    }
  }
  if (isLegalCall(auction, { type: "double" })) calls.push({ type: "double" });
  if (isLegalCall(auction, { type: "redouble" })) calls.push({ type: "redouble" });
  return calls;
}

/**
 * Apply a (legal) call to the auction, mutating it, and finalise the contract /
 * passed-out state when the auction ends. Throws on an illegal call so bugs are
 * loud rather than silently corrupting state.
 *
 * Auction-end rule: after any bid, three consecutive passes end the auction and
 * the last bid is the contract. Four passes with no bid = passed out (redeal).
 */
export function applyCall(auction, call) {
  if (!isLegalCall(auction, call)) {
    throw new Error("Illegal call: " + JSON.stringify(call));
  }
  const seat = auction.turn;
  auction.calls.push({ seat, call });

  if (call.type === "bid") {
    auction.lastBid = { seat, level: call.level, strain: call.strain };
    auction.doubled = 0;
  } else if (call.type === "double") {
    auction.doubled = 1;
  } else if (call.type === "redouble") {
    auction.doubled = 2;
  }

  // Check for auction end.
  if (auction.lastBid) {
    // Count trailing passes since the last non-pass call.
    let passes = 0;
    for (let i = auction.calls.length - 1; i >= 0; i--) {
      if (auction.calls[i].call.type === "pass") passes++;
      else break;
    }
    if (passes >= 3) {
      auction.ended = true;
      auction.contract = finalizeContract(auction);
    }
  } else {
    // No bid yet: four passes total = passed out.
    if (auction.calls.length >= 4 &&
        auction.calls.every((c) => c.call.type === "pass")) {
      auction.ended = true;
      auction.passedOut = true;
      auction.contract = null;
    }
  }

  if (!auction.ended) auction.turn = nextSeat(auction.turn);
  return auction;
}

/**
 * Determine the contract + declarer from a finished auction with a last bid.
 * Declarer = the member of the winning side who FIRST bid the contract's strain
 * (NT counts as its own strain), per the Laws.
 */
export function finalizeContract(auction) {
  const { level, strain, seat: winningSeat } = auction.lastBid;
  const winningSide = sideOf(winningSeat);
  let declarer = winningSeat;
  for (const { seat, call } of auction.calls) {
    if (call.type === "bid" && call.strain === strain && sideOf(seat) === winningSide) {
      declarer = seat;
      break; // first time this side named this strain
    }
  }
  return { level, strain, declarer, doubled: auction.doubled };
}

// ── Play ─────────────────────────────────────────────────────────────────────
//
// Play object:
//   {
//     trump,                    strain's suit, or null for NT
//     declarer, dummy,          seats
//     leader,                   seat to lead the current trick
//     turn,                     seat to play next
//     hands: [seat]→[cards],    remaining cards, mutated as cards are played
//     currentTrick: [{seat, card}],
//     tricks: [{cards:[{seat,card}], winner}],   completed tricks
//     trickCount: { 0: nsTricks, 1: ewTricks },  by side
//     done                      true after 13 tricks
//   }

/**
 * Start the play from a finished contract auction. `hands` is the dealt hands
 * by seat (will be cloned so the engine owns mutable copies). Opening leader is
 * the player to the LEFT of declarer; dummy is declarer's partner.
 */
export function startPlay(contract, hands) {
  const trump = contract.strain === "NT" ? null : contract.strain;
  const declarer = contract.declarer;
  const dummy = (declarer + 2) % 4; // partner sits across
  const leader = nextSeat(declarer); // left of declarer leads
  return {
    trump,
    declarer,
    dummy,
    leader,
    turn: leader,
    hands: hands.map((h) => h.slice()),
    currentTrick: [],
    tricks: [],
    trickCount: { 0: 0, 1: 0 },
    done: false,
  };
}

/** The suit that was led in the current trick, or null if no card yet. */
export function ledSuit(play) {
  return play.currentTrick.length ? play.currentTrick[0].card.suit : null;
}

/**
 * Is it legal for `seat` to play `card` right now? Enforces: it's the seat's
 * turn, the seat actually holds the card, and follow-suit (must follow the led
 * suit if able). Pure check.
 */
export function isLegalPlay(play, seat, card) {
  if (play.done) return false;
  if (seat !== play.turn) return false;
  const hand = play.hands[seat];
  if (!hand.some((c) => c.suit === card.suit && c.rank === card.rank)) return false;
  const led = ledSuit(play);
  if (led && card.suit !== led && suitLength(hand, led) > 0) return false; // must follow
  return true;
}

/** The set of legal cards `seat` may play now (for highlighting / AI). */
export function legalPlays(play, seat) {
  if (play.done || seat !== play.turn) return [];
  const hand = play.hands[seat];
  const led = ledSuit(play);
  if (led && suitLength(hand, led) > 0) return hand.filter((c) => c.suit === led);
  return hand.slice();
}

/**
 * Compare two played cards under a trump suit: returns the winner of (a, b),
 * given which suit was led. A trump beats any non-trump; otherwise only cards of
 * the led suit can win, highest rank wins.
 */
function beats(candidate, best, led, trump) {
  const cIsTrump = trump && candidate.suit === trump;
  const bIsTrump = trump && best.suit === trump;
  if (cIsTrump && !bIsTrump) return true;
  if (!cIsTrump && bIsTrump) return false;
  if (cIsTrump && bIsTrump) return candidate.rank > best.rank;
  // Neither is trump: only led-suit cards can win.
  const cIsLed = candidate.suit === led;
  const bIsLed = best.suit === led;
  if (cIsLed && !bIsLed) return true;
  if (!cIsLed && bIsLed) return false;
  if (cIsLed && bIsLed) return candidate.rank > best.rank;
  return false; // both off-suit non-trump: first played (best) stands
}

/** Winning seat of a completed trick (array of {seat, card}) under trump. */
export function trickWinner(cards, trump) {
  const led = cards[0].card.suit;
  let best = cards[0];
  for (let i = 1; i < cards.length; i++) {
    if (beats(cards[i].card, best.card, led, trump)) best = cards[i];
  }
  return best.seat;
}

/**
 * Play one (legal) card for the seat on turn. Mutates the play state: removes
 * the card from the hand, appends to the current trick, and when the trick
 * completes computes the winner, updates trick counts, sets the next leader, and
 * flags `done` after 13 tricks. Throws on an illegal play.
 *
 * Returns { trickComplete, winner|null, done }.
 */
export function playCard(play, seat, card) {
  if (!isLegalPlay(play, seat, card)) {
    throw new Error("Illegal play: seat " + seat + " " + JSON.stringify(card));
  }
  const hand = play.hands[seat];
  const idx = hand.findIndex((c) => c.suit === card.suit && c.rank === card.rank);
  hand.splice(idx, 1);
  play.currentTrick.push({ seat, card });

  if (play.currentTrick.length < 4) {
    play.turn = nextSeat(seat);
    return { trickComplete: false, winner: null, done: false };
  }

  // Trick complete.
  const winner = trickWinner(play.currentTrick, play.trump);
  play.tricks.push({ cards: play.currentTrick.slice(), winner });
  play.trickCount[sideOf(winner)]++;
  play.currentTrick = [];
  play.leader = winner;
  play.turn = winner;
  play.done = play.tricks.length === 13;
  return { trickComplete: true, winner, done: play.done };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

/** Per-trick value of a strain for the trick score (after the contract). */
function strainTrickValue(strain) {
  if (strain === "C" || strain === "D") return 20; // minors
  return 30;                                        // majors + NT (NT handled below)
}

/**
 * Score a played contract. Inputs:
 *   contract: { level, strain, declarer, doubled }
 *   declarerTricks: number of tricks (0..13) won by the DECLARING side.
 *
 * Returns { made, declarerSide, declarerScore, defenderScore, tricksNeeded,
 *           result, detail }
 * where declarerScore is positive when declarer makes the contract and the
 * penalty (positive) goes to defenderScore when it goes down. `result` is the
 * over/undertrick count (e.g. +1, 0, -2).
 *
 * ── SCORING IMPLEMENTED (standard duplicate, NON-VULNERABLE only) ──
 *   Trick score (per contracted trick over book of 6):
 *     ♣/♦ = 20, ♥/♠ = 30, NT = 40 for the first trick then 30 each.
 *     Doubled ×2, redoubled ×4.
 *   Game vs part-score bonus: trick score ≥ 100 → +300 (game, non-vul);
 *     otherwise +50 (part-score).
 *   Slam bonus (non-vul): small slam (level 6) +500; grand slam (level 7) +1000.
 *   Doubled/redoubled "insult" bonus for making the contract: +50 doubled,
 *     +100 redoubled.
 *   Overtricks: undoubled = strain trick value each; doubled = 100 each
 *     (non-vul); redoubled = 200 each (non-vul).
 *   Undertricks (non-vul):
 *     undoubled = 50 per trick.
 *     doubled    = 100 first, 200 each subsequent (i.e. 100,300,500,800,…).
 *     redoubled  = double the doubled penalties (200 first, 400 each subseq.).
 *   NOT implemented: honors bonuses (rubber-bridge only; irrelevant to a single
 *     duplicate board) and vulnerability (assumed none — see module header).
 */
export function scoreContract(contract, declarerTricks) {
  const { level, strain, doubled } = contract;
  const declarerSide = sideOf(contract.declarer);
  const tricksNeeded = 6 + level;
  const result = declarerTricks - tricksNeeded;
  const made = result >= 0;
  const mult = doubled === 2 ? 4 : doubled === 1 ? 2 : 1;

  let declarerScore = 0;
  let defenderScore = 0;
  const detail = {};

  if (made) {
    // ── Trick score for the contracted tricks. ──
    let trickScore;
    if (strain === "NT") trickScore = 40 + (level - 1) * 30; // 40 first, 30 rest
    else trickScore = level * strainTrickValue(strain);
    trickScore *= mult;
    detail.trickScore = trickScore;

    // ── Bonuses. ──
    let bonus = 0;
    bonus += trickScore >= 100 ? 300 : 50;     // game (non-vul) vs part-score
    detail.gameBonus = trickScore >= 100 ? 300 : 50;
    if (level === 6) { bonus += 500; detail.slamBonus = 500; }       // small slam
    else if (level === 7) { bonus += 1000; detail.slamBonus = 1000; } // grand slam
    if (doubled === 1) { bonus += 50; detail.insult = 50; }          // making doubled
    else if (doubled === 2) { bonus += 100; detail.insult = 100; }   // making redoubled

    // ── Overtricks. ──
    const overtricks = result;
    let otScore = 0;
    if (overtricks > 0) {
      if (doubled === 0) otScore = overtricks * strainTrickValue(strain);
      else if (doubled === 1) otScore = overtricks * 100; // non-vul doubled OT
      else otScore = overtricks * 200;                    // non-vul redoubled OT
      detail.overtricks = otScore;
    }

    declarerScore = trickScore + bonus + otScore;
  } else {
    // ── Undertricks (declarer goes down by `under` tricks). ──
    const under = -result;
    let pen = 0;
    if (doubled === 0) {
      pen = under * 50;                       // non-vul, undoubled
    } else {
      // Non-vul doubled penalty ladder: 100, 300, 500, 800, then +300 each.
      let perTrick;
      for (let i = 1; i <= under; i++) {
        if (i === 1) perTrick = 100;
        else if (i <= 3) perTrick = 200;      // tricks 2 & 3 cost 200 each
        else perTrick = 300;                  // 4th and beyond cost 300 each
        pen += perTrick;
      }
      if (doubled === 2) pen *= 2;            // redoubled doubles the penalty
    }
    detail.penalty = pen;
    defenderScore = pen;
  }

  return {
    made,
    declarerSide,
    declarerScore,
    defenderScore,
    tricksNeeded,
    declarerTricks,
    result,
    detail,
  };
}

/** Human-readable contract label, e.g. "4♠ X by South". */
export function contractLabel(contract) {
  if (!contract) return "Passed out";
  const dbl = contract.doubled === 2 ? " XX" : contract.doubled === 1 ? " X" : "";
  return contract.level + STRAIN_LABEL[contract.strain] + dbl +
    " by " + SEAT_NAMES[SEATS[contract.declarer]];
}
