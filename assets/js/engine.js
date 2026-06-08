// Tetris engine — the pure game core. No DOM, no rendering, no input: it owns
// the board, the falling piece, gravity, line clears, scoring and levelling,
// and exposes a small command surface (move / rotate / soft & hard drop / tick).
// app.js drives it from the intent stream and renders its state.

export const COLS = 10;
export const ROWS = 20;

// The seven tetrominoes. Each is a list of rotation states; every state is the
// list of [x, y] cells (within a 4x4 box) the piece occupies. Index = colour id
// (1..7), 0 means "empty" on the board.
const SHAPES = {
  I: { color: 1, rotations: rot4("I") },
  O: { color: 2, rotations: rot4("O") },
  T: { color: 3, rotations: rot4("T") },
  S: { color: 4, rotations: rot4("S") },
  Z: { color: 5, rotations: rot4("Z") },
  J: { color: 6, rotations: rot4("J") },
  L: { color: 7, rotations: rot4("L") },
};

const ORDER = ["I", "O", "T", "S", "Z", "J", "L"];

// Base cell layouts (spawn orientation) in a 4x4 grid; rot4 derives the other
// three orientations by rotating clockwise, so we only hand-author one each.
function rot4(kind) {
  const base = {
    I: [[0, 1], [1, 1], [2, 1], [3, 1]],
    O: [[1, 0], [2, 0], [1, 1], [2, 1]],
    T: [[1, 0], [0, 1], [1, 1], [2, 1]],
    S: [[1, 0], [2, 0], [0, 1], [1, 1]],
    Z: [[0, 0], [1, 0], [1, 1], [2, 1]],
    J: [[0, 0], [0, 1], [1, 1], [2, 1]],
    L: [[2, 0], [0, 1], [1, 1], [2, 1]],
  }[kind];
  // O never rotates; rotating it would shift it within the box.
  if (kind === "O") return [base, base, base, base];
  const states = [base];
  let cur = base;
  for (let i = 0; i < 3; i++) {
    // Clockwise rotation inside a 4x4 box: (x, y) -> (3 - y, x).
    cur = cur.map(([x, y]) => [3 - y, x]);
    states.push(cur);
  }
  return states;
}

// Standard guideline gravity: rows dropped per second rises with level. We
// store it as "ms per cell" per level (level 1-indexed for display).
const DROP_MS = [
  800, 720, 630, 550, 470, 380, 300, 220, 130, 100,
  80, 80, 80, 70, 70, 70, 50, 50, 50, 30,
];

// Points per simultaneous line clear (x current level), guideline-style.
const LINE_POINTS = [0, 100, 300, 500, 800];

export class Engine extends EventTarget {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.grid = makeGrid();
    this.bag = [];
    this.piece = null;
    this.next = this._pull();
    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.over = false;
    this._spawn();
  }

  // 7-bag randomiser: each kind appears once per bag before any repeats.
  _pull() {
    if (this.bag.length === 0) {
      this.bag = ORDER.slice();
      // Fisher–Yates shuffle.
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
    }
    const kind = this.bag.pop();
    return { kind, rot: 0, x: 3, y: 0 };
  }

  _spawn() {
    this.piece = this.next;
    this.next = this._pull();
    // Game over if the fresh piece can't be placed.
    if (this._collides(this.piece, this.piece.x, this.piece.y, this.piece.rot)) {
      this.over = true;
      this.dispatchEvent(new CustomEvent("gameover"));
    }
    this._changed();
  }

  cells(piece = this.piece) {
    const { rotations } = SHAPES[piece.kind];
    return rotations[piece.rot].map(([x, y]) => [piece.x + x, piece.y + y]);
  }

  color(kind) {
    return SHAPES[kind].color;
  }

  _collides(piece, x, y, rot) {
    const cells = SHAPES[piece.kind].rotations[rot];
    for (const [cx, cy] of cells) {
      const px = x + cx;
      const py = y + cy;
      if (px < 0 || px >= COLS || py >= ROWS) return true;
      if (py >= 0 && this.grid[py][px]) return true;
    }
    return false;
  }

  move(dx) {
    if (this.over || !this.piece) return false;
    const p = this.piece;
    if (!this._collides(p, p.x + dx, p.y, p.rot)) {
      p.x += dx;
      this._changed();
      return true;
    }
    return false;
  }

  rotate() {
    if (this.over || !this.piece) return false;
    const p = this.piece;
    const next = (p.rot + 1) % 4;
    // Simple wall kicks: try in place, then nudge 1 then 2 cells horizontally.
    for (const dx of [0, -1, 1, -2, 2]) {
      if (!this._collides(p, p.x + dx, p.y, next)) {
        p.x += dx;
        p.rot = next;
        this._changed();
        return true;
      }
    }
    return false;
  }

  // One gravity step. Returns true if the piece moved down, false if it locked.
  step() {
    if (this.over || !this.piece) return false;
    const p = this.piece;
    if (!this._collides(p, p.x, p.y + 1, p.rot)) {
      p.y += 1;
      this._changed();
      return true;
    }
    this._lock();
    return false;
  }

  // Soft drop: same as a gravity step but the caller awards a point per cell.
  softDrop() {
    if (this.step()) {
      this.score += 1;
      this._changed();
      return true;
    }
    return false;
  }

  // Hard drop: fall to the floor instantly, 2 points per cell, then lock.
  hardDrop() {
    if (this.over || !this.piece) return;
    const p = this.piece;
    let dist = 0;
    while (!this._collides(p, p.x, p.y + 1, p.rot)) {
      p.y += 1;
      dist += 1;
    }
    this.score += dist * 2;
    this._lock();
  }

  _lock() {
    const id = this.color(this.piece.kind);
    for (const [x, y] of this.cells()) {
      if (y < 0) {
        // Locked above the ceiling — topped out.
        this.over = true;
        this.dispatchEvent(new CustomEvent("gameover"));
        return;
      }
      this.grid[y][x] = id;
    }
    this._clearLines();
    this._spawn();
  }

  _clearLines() {
    let cleared = 0;
    for (let y = ROWS - 1; y >= 0; y--) {
      if (this.grid[y].every((c) => c !== 0)) {
        this.grid.splice(y, 1);
        this.grid.unshift(new Array(COLS).fill(0));
        cleared += 1;
        y += 1; // re-check the row that fell into this slot
      }
    }
    if (cleared > 0) {
      this.score += LINE_POINTS[cleared] * this.level;
      this.lines += cleared;
      this.level = 1 + Math.floor(this.lines / 10);
      this.dispatchEvent(new CustomEvent("lines", { detail: { cleared } }));
    }
  }

  // Current gravity interval in ms for the active level.
  dropInterval() {
    return DROP_MS[Math.min(this.level - 1, DROP_MS.length - 1)];
  }

  // Where the piece would land — used to render the ghost.
  ghostY() {
    if (!this.piece) return 0;
    const p = this.piece;
    let y = p.y;
    while (!this._collides(p, p.x, y + 1, p.rot)) y += 1;
    return y;
  }

  _changed() {
    this.dispatchEvent(new CustomEvent("change"));
  }
}

function makeGrid() {
  return Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}

// Math.random is unavailable inside workflow scripts but fine in the browser;
// kept behind a helper so the randomness source is easy to see/swap.
function rand() {
  return Math.random();
}
