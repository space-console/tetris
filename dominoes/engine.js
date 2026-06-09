// Dominoes engine — the pure game core. No DOM, no rendering, no input: it owns
// the double-six bone set, the deal, the two-ended layout chain, the boneyard,
// legal-move detection, the play/draw mechanics, block detection, round-end
// resolution, and a small AI move chooser. app.js drives it and renders state.
//
// SETUP / RULES (documented):
//   * Standard DRAW dominoes with a DOUBLE-SIX set: 28 tiles [a|b] with
//     0 <= a <= b <= 6 (7 doubles: 0-0 .. 6-6).
//   * 2 players: "you" and "ai". Each is dealt 7 tiles; the remaining 14 form
//     the BONEYARD (face down, drawable).
//   * OPENER: the player holding the highest double opens by playing it. If no
//     one holds a double (impossible here — 14 dealt tiles always include at
//     least one of the 7 doubles when 14 of 28 are dealt? no — so we fall back),
//     the player with the heaviest single tile opens. We compute the opener and
//     their forced opening tile in findOpener(). The opener's first tile sets
//     BOTH open ends to its value(s).
//   * A tile may be played onto either OPEN END if either half of the tile
//     equals that end's pip value; it attaches there (flipped as needed) and the
//     end becomes the tile's OTHER half. A double played on an end keeps that
//     same value on the end (both halves equal), and is drawn crosswise as a
//     visual nicety.
//   * If you cannot play, DRAW from the boneyard until you can; if the boneyard
//     is empty and you still cannot, you PASS.
//   * Round ends when a player empties their hand ("domino!") -> they win; OR the
//     game is BLOCKED (neither player can play and the boneyard is empty) -> the
//     player with the lower total pip count in hand wins (equal totals = draw).

// A tile is { a, b } with a <= b. We always store tiles in canonical form
// (a <= b); flipping for the layout is handled by the placed-end metadata, not
// by mutating the stored tile.

// ---- Seedable RNG (mulberry32) --------------------------------------------
// Pure and deterministic so the self-test (and replays) can be reproducible.
export function makeRng(seed = (Date.now() >>> 0)) {
  let s = seed >>> 0;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- The bone set ----------------------------------------------------------
export const MAX_PIP = 6;            // double-six
export const HAND_SIZE = 7;          // tiles dealt to each player
export const PLAYERS = ["you", "ai"];

// Build the full ordered double-six set: 28 unique [a|b] tiles, 0<=a<=b<=6.
export function makeSet() {
  const tiles = [];
  for (let a = 0; a <= MAX_PIP; a++) {
    for (let b = a; b <= MAX_PIP; b++) tiles.push({ a, b });
  }
  return tiles;
}

export const isDouble = (tile) => tile.a === tile.b;
export const pipSum = (tile) => tile.a + tile.b;
export const handPips = (hand) => hand.reduce((n, t) => n + pipSum(t), 0);
export const tileId = (tile) => `${tile.a}-${tile.b}`;
export const sameTile = (x, y) => x.a === y.a && x.b === y.b;

// Fisher–Yates shuffle (in place, returns the same array) using the engine RNG.
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---- Legal-move detection (pure) ------------------------------------------
// ends is [left, right] pip values (or null/null before the chain exists).
// Returns the list of moves playable from `hand`:
//   { tile, ends: ["L"], ... } — a tile and which open end(s) it can attach to.
// A tile matches an end if EITHER half equals the end's value. A double matches
// only when its value equals the end (handled naturally: a===b).
export function legalMoves(hand, ends) {
  const [L, R] = ends;
  const moves = [];
  for (const tile of hand) {
    const which = [];
    if (L !== null && (tile.a === L || tile.b === L)) which.push("L");
    // Avoid duplicating the single end when both ends are equal AND it's the
    // very same playable surface — but we still want to allow choosing either
    // physical end, so we keep both. The renderer decides which to show.
    if (R !== null && (tile.a === R || tile.b === R)) which.push("R");
    if (which.length) moves.push({ tile, ends: which });
  }
  return moves;
}

export const canPlay = (hand, ends) => legalMoves(hand, ends).length > 0;

// ---- Resolve how a tile attaches to an end --------------------------------
// Given the end's current pip value and a tile, returns { outer, inner } where
// `inner` is the half that touches/matches the end and `outer` becomes the new
// open-end value. Returns null if the tile cannot attach there.
export function orientFor(tile, endValue) {
  if (tile.a === endValue) return { inner: tile.a, outer: tile.b };
  if (tile.b === endValue) return { inner: tile.b, outer: tile.a };
  return null;
}

// ---- Opener selection ------------------------------------------------------
// Returns { player, tile }: the player who opens and the exact tile they must
// open with. Prefer the highest double across both hands; if neither hand holds
// a double, fall back to the heaviest single tile (highest pip sum, then
// highest single half) to break the deal.
export function findOpener(hands) {
  let best = null; // { player, tile, double, sum, hi }
  for (const player of PLAYERS) {
    for (const tile of hands[player]) {
      const dbl = isDouble(tile);
      const sum = pipSum(tile);
      const hi = Math.max(tile.a, tile.b);
      const cand = { player, tile, double: dbl, sum, hi };
      if (best === null || better(cand, best)) best = cand;
    }
  }
  return best ? { player: best.player, tile: best.tile } : null;
}

// Opener ordering: a double beats a non-double; among doubles the higher pip
// value wins; among non-doubles the higher pip sum (then higher single half).
function better(c, best) {
  if (c.double !== best.double) return c.double;       // doubles win outright
  if (c.double) return c.tile.a > best.tile.a;          // higher double wins
  if (c.sum !== best.sum) return c.sum > best.sum;      // heavier single wins
  return c.hi > best.hi;                                // tie-break by high half
}

// ---- AI move chooser (heuristic) ------------------------------------------
// Picks among legal moves. Heuristic: dump the heaviest tile first, preferring
// doubles (they're hard to shed later) and, on ties, the end that keeps the most
// of the AI's remaining options open is not modelled — we keep it simple and
// deterministic. Returns { tile, end } or null if no legal move.
export function chooseAiMove(hand, ends) {
  const moves = legalMoves(hand, ends);
  if (!moves.length) return null;
  let best = null; // { tile, end, score }
  for (const m of moves) {
    for (const end of m.ends) {
      const score =
        pipSum(m.tile) * 10 +           // shed weight first
        (isDouble(m.tile) ? 5 : 0);     // prefer offloading doubles
      if (best === null || score > best.score) best = { tile: m.tile, end, score };
    }
  }
  return { tile: best.tile, end: best.end };
}

// ---------------------------------------------------------------------------
export class Engine {
  // seed makes the deal/AI reproducible; omit for a random game.
  constructor(seed) {
    this.rng = makeRng(seed);
    this.scores = { you: 0, ai: 0 };  // running score across rounds
    this.newRound();
  }

  // Deal a fresh round: shuffle the set, hand 7 to each, the rest is boneyard,
  // pick the opener, and force-play their opening tile so the chain has two
  // open ends. Sets turn to the player AFTER the opener.
  newRound() {
    const deck = shuffle(makeSet(), this.rng);
    this.hands = {
      you: deck.slice(0, HAND_SIZE),
      ai: deck.slice(HAND_SIZE, HAND_SIZE * 2),
    };
    this.boneyard = deck.slice(HAND_SIZE * 2); // 14 tiles
    // chain entries: { a, b, double } in left->right visual order.
    this.chain = [];
    this.ends = [null, null];        // [left, right] pip values
    this.passes = 0;                 // consecutive passes (block at 2)
    this.over = false;
    this.result = null;              // set at round end
    this.lastAction = "";

    const opener = findOpener(this.hands);
    this.opener = opener.player;
    // The opener plays their forced tile immediately.
    this._placeOpening(opener.player, opener.tile);
    // Turn passes to the other player.
    this.turn = opener.player === "you" ? "ai" : "you";
  }

  // Place the opener's first tile, setting both ends. A double opens crosswise.
  _placeOpening(player, tile) {
    this._removeFromHand(player, tile);
    this.chain.push({ a: tile.a, b: tile.b, double: isDouble(tile) });
    this.ends = [tile.a, tile.b];
    this.lastAction = `${player === "you" ? "You" : "AI"} opened with ${tileId(tile)}`;
  }

  _removeFromHand(player, tile) {
    const hand = this.hands[player];
    const i = hand.findIndex((t) => sameTile(t, tile));
    if (i >= 0) hand.splice(i, 1);
    return i >= 0;
  }

  // Legal moves for the given player against the current open ends.
  legalMovesFor(player) {
    return legalMoves(this.hands[player], this.ends);
  }

  canPlayNow(player) {
    return canPlay(this.hands[player], this.ends);
  }

  // Play `tile` from `player`'s hand onto open end "L" or "R". Updates that end
  // to the tile's outer half (the matching inner half attaches). Returns true on
  // success, false if the move is illegal. Detects "domino!" (empty hand) win.
  play(player, tile, end) {
    if (this.over) return false;
    const idx = end === "L" ? 0 : 1;
    const endValue = this.ends[idx];
    const orient = orientFor(tile, endValue);
    if (!orient) return false; // tile doesn't match that end
    if (!this._removeFromHand(player, tile)) return false;

    const placed = { a: tile.a, b: tile.b, double: isDouble(tile) };
    if (end === "L") this.chain.unshift(placed);
    else this.chain.push(placed);
    this.ends[idx] = orient.outer; // matching half consumed; outer is new end
    this.passes = 0;
    this.lastAction = `${player === "you" ? "You" : "AI"} played ${tileId(tile)}`;

    if (this.hands[player].length === 0) {
      this._finishDomino(player);
    }
    return true;
  }

  // Draw one tile from the boneyard into `player`'s hand. Returns the drawn tile
  // or null if the boneyard is empty.
  draw(player) {
    if (this.over) return null;
    if (this.boneyard.length === 0) return null;
    const tile = this.boneyard.shift();
    this.hands[player].push(tile);
    this.lastAction = `${player === "you" ? "You" : "AI"} drew a tile`;
    return tile;
  }

  // True if `player` is blocked right now: no legal move AND the boneyard is
  // empty (so they cannot draw to find one). Such a player must pass.
  mustPass(player) {
    return this.boneyard.length === 0 && !this.canPlayNow(player);
  }

  // Record a pass for `player`. Two consecutive passes with an empty boneyard
  // means neither side can move -> the round is BLOCKED.
  pass(player) {
    if (this.over) return false;
    if (!this.mustPass(player)) return false;
    this.passes += 1;
    this.lastAction = `${player === "you" ? "You" : "AI"} passed`;
    if (this.passes >= 2) {
      this._finishBlocked();
    }
    return true;
  }

  // Round won by emptying a hand.
  _finishDomino(player) {
    this.over = true;
    this.scores[player] += 1;
    this.result = {
      type: "domino",
      winner: player,
      youPips: handPips(this.hands.you),
      aiPips: handPips(this.hands.ai),
    };
  }

  // Round blocked: lower total pip count wins; equal totals = draw.
  _finishBlocked() {
    this.over = true;
    const youPips = handPips(this.hands.you);
    const aiPips = handPips(this.hands.ai);
    let winner = null;
    if (youPips < aiPips) winner = "you";
    else if (aiPips < youPips) winner = "ai";
    if (winner) this.scores[winner] += 1;
    this.result = { type: "blocked", winner, youPips, aiPips };
  }

  // AI move for the current turn (assumes it is the AI's turn). Pure-ish: uses
  // the engine RNG only via the chooser's deterministic tie-breaks. Returns the
  // chosen { tile, end } or null when the AI can only draw/pass.
  aiChoice() {
    return chooseAiMove(this.hands.ai, this.ends);
  }
}
