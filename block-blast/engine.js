// Block Blast engine — the pure game core. No DOM, no rendering, no input: it
// owns the 8x8 board, the 3-piece tray, placement validity, simultaneous
// row + column clears, scoring, refills and game-over detection, and exposes a
// small command surface. app.js drives it and renders its state.

export const SIZE = 8;          // 8x8 board
export const TRAY_SIZE = 3;     // pieces dealt at a time

// ---- Shape pool -----------------------------------------------------------
// Each shape is a list of [r, c] cells relative to its bounding-box top-left
// (so the smallest row and the smallest col are both 0). Pieces are pre-oriented
// (never rotated by the player); both orientations of lines / L-shapes live in
// the pool and are picked at random. Each entry carries a colour id (1..N) used
// purely for rendering — placement never depends on colour.
//
// `color` is an index into the COLORS table in app.js.
export const SHAPES = [
  // Single.
  { color: 1, cells: [[0, 0]] },

  // Dominoes (both orientations).
  { color: 2, cells: [[0, 0], [0, 1]] },                 // horizontal
  { color: 2, cells: [[0, 0], [1, 0]] },                 // vertical

  // Trominoes — straight (both orientations).
  { color: 3, cells: [[0, 0], [0, 1], [0, 2]] },          // horizontal
  { color: 3, cells: [[0, 0], [1, 0], [2, 0]] },          // vertical
  // Trominoes — corner / L (all four orientations).
  { color: 4, cells: [[0, 0], [1, 0], [1, 1]] },
  { color: 4, cells: [[0, 0], [0, 1], [1, 0]] },
  { color: 4, cells: [[0, 0], [0, 1], [1, 1]] },
  { color: 4, cells: [[0, 1], [1, 0], [1, 1]] },

  // Tetrominoes.
  { color: 5, cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },  // I horizontal
  { color: 5, cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },  // I vertical
  { color: 6, cells: [[0, 0], [0, 1], [1, 0], [1, 1]] },  // O (2x2 square)
  { color: 7, cells: [[0, 0], [0, 1], [0, 2], [1, 1]] },  // T (4 orientations)
  { color: 7, cells: [[0, 1], [1, 0], [1, 1], [2, 1]] },
  { color: 7, cells: [[1, 0], [1, 1], [1, 2], [0, 1]] },
  { color: 7, cells: [[0, 0], [1, 0], [1, 1], [2, 0]] },
  { color: 8, cells: [[0, 1], [0, 2], [1, 0], [1, 1]] },  // S (2 orientations)
  { color: 8, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  { color: 9, cells: [[0, 0], [0, 1], [1, 1], [1, 2]] },  // Z (2 orientations)
  { color: 9, cells: [[0, 1], [1, 0], [1, 1], [2, 0]] },
  { color: 10, cells: [[0, 0], [1, 0], [2, 0], [2, 1]] }, // L (4 orientations)
  { color: 10, cells: [[0, 0], [0, 1], [0, 2], [1, 0]] },
  { color: 10, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { color: 10, cells: [[0, 2], [1, 0], [1, 1], [1, 2]] },
  { color: 11, cells: [[0, 1], [1, 1], [2, 0], [2, 1]] }, // J (4 orientations)
  { color: 11, cells: [[0, 0], [1, 0], [1, 1], [1, 2]] },
  { color: 11, cells: [[0, 0], [0, 1], [1, 0], [2, 0]] },
  { color: 11, cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },

  // Big square.
  { color: 12, cells: [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2]] }, // 3x3

  // Long lines, length 5 (both orientations).
  { color: 13, cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] }, // horizontal
  { color: 13, cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] }, // vertical
];

// Points awarded for clearing N lines at once. Generous, scaling super-linearly
// so multi-clears (combos) are far more valuable than the same lines one by one.
// index = number of lines cleared (0 unused). Beyond the table, extrapolate.
const CLEAR_POINTS = [0, 10, 30, 60, 100, 150, 210, 280, 360, 450, 550, 660, 780, 910, 1050, 1200, 1360];

const POINT_PER_CELL = 1;       // placement reward, per filled cell

export class Engine {
  /**
   * @param {() => number} [rng]  returns a float in [0,1); defaults to Math.random.
   *                              Inject a seedable RNG for deterministic tests.
   */
  constructor(rng = Math.random) {
    this.rng = rng;
    this.best = 0;               // app.js loads/persists this from localStorage
    this.reset();
  }

  reset() {
    this.grid = makeGrid();      // grid[r][c] = 0 (empty) or a colour id
    this.score = 0;
    this.over = false;
    this.tray = [];              // up to TRAY_SIZE pieces; nulls mark placed slots
    this._refill();
  }

  // Deal a fresh tray of TRAY_SIZE random pieces.
  _refill() {
    this.tray = [];
    for (let i = 0; i < TRAY_SIZE; i++) this.tray.push(this._randomPiece());
  }

  _randomPiece() {
    const shape = SHAPES[Math.floor(this.rng() * SHAPES.length)];
    // Clone the cells so a piece instance never aliases the shared shape data.
    return { color: shape.color, cells: shape.cells.map(([r, c]) => [r, c]) };
  }

  /** Number of pieces still waiting in the tray (non-null slots). */
  remaining() {
    return this.tray.filter((p) => p != null).length;
  }

  /**
   * Can the tray piece at `index` be placed with its bounding-box top-left at
   * (r, c)? Every cell must be in-bounds and land on an empty board square.
   */
  canPlace(index, r, c) {
    const piece = this.tray[index];
    if (!piece) return false;
    for (const [dr, dc] of piece.cells) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || rr >= SIZE || cc < 0 || cc >= SIZE) return false;
      if (this.grid[rr][cc] !== 0) return false;
    }
    return true;
  }

  /**
   * Place the tray piece at `index` with top-left at (r, c). On success fills
   * those cells, removes the piece from the tray, clears any completed
   * rows/columns, scores, refills when the tray empties, and re-checks for game
   * over. Returns a result, or null if the placement is invalid.
   *
   * @returns {{
   *   placedCells: number,
   *   rows: number[], cols: number[], lines: number,
   *   clearPoints: number, placePoints: number, gained: number,
   *   refilled: boolean, over: boolean,
   * } | null}
   */
  place(index, r, c) {
    if (this.over || !this.canPlace(index, r, c)) return null;
    const piece = this.tray[index];

    for (const [dr, dc] of piece.cells) {
      this.grid[r + dr][c + dc] = piece.color;
    }
    const placePoints = piece.cells.length * POINT_PER_CELL;
    this.tray[index] = null;     // mark the slot empty; refill only when all gone

    // Find every full row and full column FIRST, then empty them together, so a
    // cell at the intersection of a full row and full column is only counted
    // once and both lines clear simultaneously.
    const rows = [];
    const cols = [];
    for (let i = 0; i < SIZE; i++) {
      if (this.grid[i].every((v) => v !== 0)) rows.push(i);
    }
    for (let j = 0; j < SIZE; j++) {
      let full = true;
      for (let i = 0; i < SIZE; i++) {
        if (this.grid[i][j] === 0) { full = false; break; }
      }
      if (full) cols.push(j);
    }
    for (const i of rows) {
      for (let j = 0; j < SIZE; j++) this.grid[i][j] = 0;
    }
    for (const j of cols) {
      for (let i = 0; i < SIZE; i++) this.grid[i][j] = 0;
    }

    const lines = rows.length + cols.length;
    const clearPoints = clearScore(lines);

    this.score += placePoints + clearPoints;

    // Refill only once the whole tray has been placed.
    let refilled = false;
    if (this.remaining() === 0) {
      this._refill();
      refilled = true;
    }

    // Game over when nothing left in the tray can be placed anywhere.
    this.over = !this.anyMoveAvailable();

    if (this.score > this.best) this.best = this.score;

    return {
      placedCells: piece.cells.length,
      rows, cols, lines,
      clearPoints, placePoints,
      gained: placePoints + clearPoints,
      refilled, over: this.over,
    };
  }

  /** Is there at least one legal placement for some piece still in the tray? */
  anyMoveAvailable() {
    for (let index = 0; index < this.tray.length; index++) {
      if (!this.tray[index]) continue;
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (this.canPlace(index, r, c)) return true;
        }
      }
    }
    return false;
  }

  /** True if the tray piece at `index` can be placed anywhere on the board. */
  pieceHasMove(index) {
    if (!this.tray[index]) return false;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (this.canPlace(index, r, c)) return true;
      }
    }
    return false;
  }
}

function makeGrid() {
  return Array.from({ length: SIZE }, () => new Array(SIZE).fill(0));
}

// Points for clearing `lines` lines at once, extrapolating past the table.
function clearScore(lines) {
  if (lines <= 0) return 0;
  if (lines < CLEAR_POINTS.length) return CLEAR_POINTS[lines];
  // Beyond the table keep the generous slope of the last step.
  const last = CLEAR_POINTS.length - 1;
  const step = CLEAR_POINTS[last] - CLEAR_POINTS[last - 1];
  return CLEAR_POINTS[last] + (lines - last) * step;
}
