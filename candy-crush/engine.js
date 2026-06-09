// Candy Crush (match-3) engine — the pure game core. No DOM, no rendering, no
// input: it owns the 8x8 grid of candy colours, the swap/match/cascade logic,
// gravity + refill, the moves/score/target bookkeeping and the win/lose verdict,
// and exposes a small command surface. app.js drives it and renders its state.
//
// A candy is an integer colour id 1..COLORS (0 = empty, used transiently while
// a column is collapsing). The board never holds 0 once a turn settles.

export const SIZE = 8;        // 8x8 board
export const COLORS = 6;      // six candy colours

// Game tuning — documented numbers.
//   MOVES  : swaps allowed before the game ends (20).
//   TARGET : score needed to win within those moves (1000).
// These give a brisk, winnable-but-not-trivial round: ~50 points/move on
// average is enough, which a couple of cascades comfortably beat.
export const MOVES = 20;
export const TARGET = 1000;

// Scoring. A cleared candy is worth POINT_PER_CANDY, multiplied by the cascade
// step (1 for the swap's own match, 2 for the first cascade it triggers, 3 for
// the next, ...). So chains are worth progressively more — the combo multiplier.
const POINT_PER_CANDY = 10;

// A tiny seedable RNG (mulberry32) so tests are deterministic. Returns a
// function producing floats in [0, 1). app.js leaves it defaulted to a
// time-seeded instance for normal play.
export function makeRng(seed = (Date.now() >>> 0)) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Engine {
  /**
   * @param {() => number} [rng]  returns a float in [0,1). Inject a seedable RNG
   *                              for deterministic tests; defaults to a
   *                              time-seeded mulberry32.
   */
  constructor(rng = makeRng()) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.grid = this._makeStartGrid(); // 8x8 of colour ids, no initial matches
    this.score = 0;
    this.moves = MOVES;
    this.target = TARGET;
    this.state = "playing";            // "playing" | "won" | "lost"
    // Guarantee at least one valid move from the very first board.
    if (!this.hasValidMove()) this.reshuffle();
  }

  // ---- Board generation ---------------------------------------------------
  _randomColor() {
    return 1 + Math.floor(this.rng() * COLORS);
  }

  // Build a board that has NO matches of 3+ already on it. We fill cell by cell,
  // rejecting any colour that would complete a run of three with the two cells
  // immediately to the left or above. This can never paint into a corner with
  // six colours, so it always terminates.
  _makeStartGrid() {
    const g = Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        let color;
        do {
          color = this._randomColor();
        } while (
          (c >= 2 && g[r][c - 1] === color && g[r][c - 2] === color) ||
          (r >= 2 && g[r - 1][c] === color && g[r - 2][c] === color)
        );
        g[r][c] = color;
      }
    }
    return g;
  }

  // ---- Match detection ----------------------------------------------------
  // Find every cell that is part of a horizontal or vertical run of 3+ of the
  // same colour. Returns a Set of "r,c" keys (deduped across overlapping runs).
  findMatches() {
    const matched = new Set();

    // Horizontal runs.
    for (let r = 0; r < SIZE; r++) {
      let runStart = 0;
      for (let c = 1; c <= SIZE; c++) {
        const same = c < SIZE && this.grid[r][c] !== 0 &&
          this.grid[r][c] === this.grid[r][runStart];
        if (!same) {
          if (c - runStart >= 3) {
            for (let k = runStart; k < c; k++) matched.add(r + "," + k);
          }
          runStart = c;
        }
      }
    }

    // Vertical runs.
    for (let c = 0; c < SIZE; c++) {
      let runStart = 0;
      for (let r = 1; r <= SIZE; r++) {
        const same = r < SIZE && this.grid[r][c] !== 0 &&
          this.grid[r][c] === this.grid[runStart][c];
        if (!same) {
          if (r - runStart >= 3) {
            for (let k = runStart; k < r; k++) matched.add(k + "," + c);
          }
          runStart = r;
        }
      }
    }

    return matched;
  }

  // ---- Clear + gravity + refill -------------------------------------------
  // Empty the given matched cells, then let candies above fall into the gaps and
  // refill the emptied top cells with fresh random candies. Mutates the grid in
  // place. Returns the number of cells cleared.
  clearAndCollapse(matched) {
    for (const key of matched) {
      const [r, c] = key.split(",").map(Number);
      this.grid[r][c] = 0;
    }

    // Per column, compact the survivors downward, then top up with new candies.
    for (let c = 0; c < SIZE; c++) {
      let write = SIZE - 1;                 // next free row from the bottom up
      for (let r = SIZE - 1; r >= 0; r--) {
        if (this.grid[r][c] !== 0) {
          this.grid[write][c] = this.grid[r][c];
          write--;
        }
      }
      // Everything from `write` up is now a gap → fill with new candies.
      for (let r = write; r >= 0; r--) {
        this.grid[r][c] = this._randomColor();
      }
    }

    return matched.size;
  }

  // ---- Swap + resolve -----------------------------------------------------
  /** Are (r1,c1) and (r2,c2) orthogonally adjacent (and both in bounds)? */
  areAdjacent(r1, c1, r2, c2) {
    if (!this._inBounds(r1, c1) || !this._inBounds(r2, c2)) return false;
    return Math.abs(r1 - r2) + Math.abs(c1 - c2) === 1;
  }

  /**
   * Try to swap two adjacent candies. The swap is committed only if it creates
   * a match; otherwise the board is left untouched (reverted). On a valid swap
   * we resolve all matches and cascades, accumulate score with an increasing
   * combo multiplier, spend a move, and update the win/lose state.
   *
   * @returns {{
   *   valid: boolean,        // did the swap create a match?
   *   cleared: number,       // total candies cleared across all cascades
   *   maxRun: number,        // size of the largest single run cleared (for SFX)
   *   chains: number,        // number of cascade steps (1 = no extra cascade)
   *   score: number,         // points gained this swap
   * }}
   */
  trySwap(r1, c1, r2, c2) {
    const fail = { valid: false, cleared: 0, maxRun: 0, chains: 0, score: 0 };
    if (this.state !== "playing") return fail;
    if (!this.areAdjacent(r1, c1, r2, c2)) return fail;

    this._swap(r1, c1, r2, c2);

    const first = this.findMatches();
    if (first.size === 0) {
      this._swap(r1, c1, r2, c2);   // revert: the swap created nothing
      return fail;
    }

    // Valid swap — resolve the chain of cascades.
    let cleared = 0;
    let chains = 0;
    let gained = 0;
    let maxRun = 0;
    let matched = first;
    while (matched.size > 0) {
      chains += 1;
      maxRun = Math.max(maxRun, this._largestRun(matched));
      cleared += matched.size;
      // Combo multiplier grows with the cascade depth.
      gained += matched.size * POINT_PER_CANDY * chains;
      this.clearAndCollapse(matched);
      matched = this.findMatches();
    }

    this.score += gained;
    this.moves -= 1;

    // After settling, make sure the next board still has a move (else reshuffle).
    if (!this.hasValidMove()) this.reshuffle();

    this._updateVerdict();

    return { valid: true, cleared, maxRun, chains, score: gained };
  }

  // ---- Move availability + reshuffle --------------------------------------
  // Is there at least one adjacent swap that would create a match? We probe each
  // cell's right and down neighbour (covers every adjacency once), swapping,
  // testing, and swapping back without disturbing the board.
  hasValidMove() {
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (c + 1 < SIZE && this._swapCreatesMatch(r, c, r, c + 1)) return true;
        if (r + 1 < SIZE && this._swapCreatesMatch(r, c, r + 1, c)) return true;
      }
    }
    return false;
  }

  // Re-deal the board until it has no current matches and at least one valid
  // move, preserving score/moves/state. Used at start and whenever the settled
  // board would otherwise be a dead end.
  reshuffle() {
    do {
      this.grid = this._makeStartGrid();
    } while (this.findMatches().size > 0 || !this.hasValidMove());
  }

  // ---- Internals ----------------------------------------------------------
  _inBounds(r, c) {
    return r >= 0 && r < SIZE && c >= 0 && c < SIZE;
  }

  _swap(r1, c1, r2, c2) {
    const tmp = this.grid[r1][c1];
    this.grid[r1][c1] = this.grid[r2][c2];
    this.grid[r2][c2] = tmp;
  }

  // Swap, test for any match, swap back. Pure probe — leaves the grid unchanged.
  _swapCreatesMatch(r1, c1, r2, c2) {
    this._swap(r1, c1, r2, c2);
    const hit = this.findMatches().size > 0;
    this._swap(r1, c1, r2, c2);
    return hit;
  }

  // Size of the longest single colour run within a matched set — used to pick
  // the clear sound (3/4/5). Scans the matched cells for runs along both axes.
  _largestRun(matched) {
    let best = 0;
    // Horizontal.
    for (let r = 0; r < SIZE; r++) {
      let run = 0;
      for (let c = 0; c < SIZE; c++) {
        if (matched.has(r + "," + c)) { run++; best = Math.max(best, run); }
        else run = 0;
      }
    }
    // Vertical.
    for (let c = 0; c < SIZE; c++) {
      let run = 0;
      for (let r = 0; r < SIZE; r++) {
        if (matched.has(r + "," + c)) { run++; best = Math.max(best, run); }
        else run = 0;
      }
    }
    return best;
  }

  _updateVerdict() {
    if (this.score >= this.target) this.state = "won";
    else if (this.moves <= 0) this.state = "lost";
    else this.state = "playing";
  }
}
