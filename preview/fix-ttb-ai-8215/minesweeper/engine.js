// Minesweeper engine — pure board logic, no DOM, no timers.
// The app layer owns rendering, input, the clock and the mine counter display;
// this module owns the grid, mine placement, reveal/flood/flag rules and the
// win/lose detection. Mines are placed lazily on the FIRST reveal so that first
// click (and ideally its neighbourhood) is guaranteed safe. A seedable RNG keeps
// mine placement deterministic for tests.

// The eight neighbour offsets shared by counting and flood-fill.
const NEIGHBOURS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
];

// Tiny seedable PRNG (mulberry32). Deterministic given a seed; falls back to a
// time-based seed for real play so every game differs.
function mulberry32(seed) {
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
   * @param {{rows:number, cols:number, mines:number, seed?:number}} cfg
   */
  constructor(cfg) {
    this.configure(cfg);
  }

  /** Reset to a fresh, unplayed board with the given dimensions / mine count. */
  configure({ rows, cols, mines, seed } = {}) {
    this.rows = rows;
    this.cols = cols;
    this.mines = mines;
    this._seed = seed;
    this._rng = mulberry32(seed === undefined ? (Date.now() >>> 0) : seed);
    this.reset();
  }

  /** Clear board state but keep the dimensions / mine count / RNG seed. */
  reset() {
    const n = this.rows * this.cols;
    this.mine = new Array(n).fill(false);     // is this cell a mine?
    this.count = new Array(n).fill(0);        // adjacent mine count
    this.revealed = new Array(n).fill(false);
    this.flagged = new Array(n).fill(false);
    this.placed = false;                      // have mines been placed yet?
    this.exploded = -1;                       // index of the mine the player hit
    this.state = "playing";                   // playing | won | lost
    this.revealedCount = 0;
    if (this._seed !== undefined) this._rng = mulberry32(this._seed);
  }

  idx(r, c) { return r * this.cols + c; }
  inBounds(r, c) { return r >= 0 && r < this.rows && c >= 0 && c < this.cols; }

  /** Mines remaining to find = total mines − flags placed (may go negative). */
  minesLeft() {
    let flags = 0;
    for (let i = 0; i < this.flagged.length; i++) if (this.flagged[i]) flags++;
    return this.mines - flags;
  }

  // Place mines avoiding the first-clicked cell AND its neighbours, so the first
  // reveal always opens onto a zero (or at worst a safe number). If the board is
  // too dense to keep the whole neighbourhood clear, fall back to sparing just
  // the clicked cell so placement always succeeds.
  _placeMines(safeR, safeC) {
    const n = this.rows * this.cols;
    const safe = new Set();
    safe.add(this.idx(safeR, safeC));
    for (const [dr, dc] of NEIGHBOURS) {
      const r = safeR + dr, c = safeC + dc;
      if (this.inBounds(r, c)) safe.add(this.idx(r, c));
    }
    // If sparing the neighbourhood leaves too few cells, only spare the click.
    let exclude = safe;
    if (n - safe.size < this.mines) {
      exclude = new Set([this.idx(safeR, safeC)]);
    }

    // Build the pool of placeable indices, then shuffle-pick `mines` of them.
    const pool = [];
    for (let i = 0; i < n; i++) if (!exclude.has(i)) pool.push(i);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(this._rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    for (let k = 0; k < this.mines && k < pool.length; k++) {
      this.mine[pool[k]] = true;
    }

    // Precompute adjacency counts for every non-mine cell.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.mine[this.idx(r, c)]) continue;
        let count = 0;
        for (const [dr, dc] of NEIGHBOURS) {
          const nr = r + dr, nc = c + dc;
          if (this.inBounds(nr, nc) && this.mine[this.idx(nr, nc)]) count++;
        }
        this.count[this.idx(r, c)] = count;
      }
    }
    this.placed = true;
  }

  /**
   * Reveal a cell.
   * @returns {{outcome:"safe"|"mine"|"win"|"none", revealed:number[], flooded:boolean}}
   *   outcome "none" = nothing happened (flagged, already revealed, game over).
   *   revealed = indices newly uncovered this call. flooded = a zero-region opened.
   */
  reveal(r, c) {
    if (this.state !== "playing" || !this.inBounds(r, c)) {
      return { outcome: "none", revealed: [], flooded: false };
    }
    const start = this.idx(r, c);
    if (this.revealed[start] || this.flagged[start]) {
      return { outcome: "none", revealed: [], flooded: false };
    }

    // First reveal seeds the mines so this cell is guaranteed safe.
    if (!this.placed) this._placeMines(r, c);

    // Hit a mine: lose. Mark the exploded cell; the app reveals all mines.
    if (this.mine[start]) {
      this.revealed[start] = true;
      this.exploded = start;
      this.state = "lost";
      return { outcome: "mine", revealed: [start], flooded: false };
    }

    // Flood-fill the connected zero region plus its bordering numbers. A single
    // numbered cell just reveals itself (the loop runs once and stops).
    const out = [];
    const stack = [start];
    const seen = new Set([start]);
    while (stack.length) {
      const cur = stack.pop();
      if (this.revealed[cur]) continue;
      this.revealed[cur] = true;
      this.revealedCount++;
      out.push(cur);
      // Only expand outward from zero cells; numbers form the region border.
      if (this.count[cur] === 0) {
        const cr = Math.floor(cur / this.cols);
        const cc = cur % this.cols;
        for (const [dr, dc] of NEIGHBOURS) {
          const nr = cr + dr, nc = cc + dc;
          if (!this.inBounds(nr, nc)) continue;
          const ni = this.idx(nr, nc);
          if (this.revealed[ni] || this.flagged[ni] || seen.has(ni)) continue;
          seen.add(ni);
          stack.push(ni);
        }
      }
    }

    // Win when every non-mine cell is revealed.
    const safeCells = this.rows * this.cols - this.mines;
    if (this.revealedCount >= safeCells) {
      this.state = "won";
      return { outcome: "win", revealed: out, flooded: out.length > 1 };
    }
    return { outcome: "safe", revealed: out, flooded: out.length > 1 };
  }

  /**
   * Toggle a flag on a covered cell.
   * @returns {boolean} the cell's new flagged state (false if no-op).
   */
  toggleFlag(r, c) {
    if (this.state !== "playing" || !this.inBounds(r, c)) return false;
    const i = this.idx(r, c);
    if (this.revealed[i]) return false;          // can't flag an open cell
    this.flagged[i] = !this.flagged[i];
    return this.flagged[i];
  }

  /** Indices of every mine — used by the app to reveal them all on a loss. */
  mineIndices() {
    const out = [];
    for (let i = 0; i < this.mine.length; i++) if (this.mine[i]) out.push(i);
    return out;
  }
}
