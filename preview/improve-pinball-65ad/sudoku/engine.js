// Sudoku engine — the pure game core. No DOM, no rendering, no input: it owns
// the solution, the puzzle (givens), the current board, and exposes a small
// command surface (set / cycle a cell, query conflicts, test for a win, deal a
// fresh puzzle). app.js drives it from the intent stream and renders its state.

export const N = 9;        // board is 9×9
export const BOX = 3;      // 3×3 boxes
const GIVENS = 32;         // cells revealed when a new puzzle is dealt

export class Engine {
  constructor() {
    this.newPuzzle();
  }

  // Deal a fresh puzzle: a random complete solution, then a givens mask carving
  // it down to ~GIVENS clues. The current board starts as the givens only.
  newPuzzle() {
    this.solution = makeSolution();
    this.givens = makeGivenMask(GIVENS);
    // Current board: copy each given from the solution, leave the rest empty.
    this.board = grid(() => 0);
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (this.givens[r][c]) this.board[r][c] = this.solution[r][c];
      }
    }
  }

  // Given cells are locked — the player can't edit them.
  isGiven(r, c) {
    return this.givens[r][c] === 1;
  }

  // Set a non-given cell to val (0 clears it). No-op on given cells. val is
  // clamped to 0..9. Returns true if the board changed.
  setCell(r, c, val) {
    if (this.isGiven(r, c)) return false;
    const v = Math.max(0, Math.min(N, val | 0));
    if (this.board[r][c] === v) return false;
    this.board[r][c] = v;
    return true;
  }

  // Cycle a non-given cell forward: 1 → 2 → … → 9 → empty → 1. Returns true if
  // the board changed (i.e. the cell is editable).
  cycle(r, c) {
    if (this.isGiven(r, c)) return false;
    this.board[r][c] = (this.board[r][c] + 1) % (N + 1);
    return true;
  }

  // Number of still-empty cells — handy for a "remaining" status readout.
  remaining() {
    let n = 0;
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (this.board[r][c] === 0) n++;
      }
    }
    return n;
  }

  // Every filled cell that shares its value with another cell in the same row,
  // column, or 3×3 box. Returned as a Set of "r,c" keys so the renderer can
  // paint offending cells red. Empty cells never conflict.
  conflicts() {
    const bad = new Set();
    const mark = (cells) => {
      // Within one unit (row/col/box), group cells by value; any value seen
      // more than once flags all the cells that carry it.
      const seen = new Map();
      for (const [r, c] of cells) {
        const v = this.board[r][c];
        if (v === 0) continue;
        if (!seen.has(v)) seen.set(v, []);
        seen.get(v).push([r, c]);
      }
      for (const group of seen.values()) {
        if (group.length > 1) {
          for (const [r, c] of group) bad.add(r + "," + c);
        }
      }
    };

    for (let i = 0; i < N; i++) {
      mark(rowCells(i));
      mark(colCells(i));
      mark(boxCells(i));
    }
    return bad;
  }

  // Solved when every cell is filled and nothing conflicts.
  isSolved() {
    return this.remaining() === 0 && this.conflicts().size === 0;
  }
}

// ---- Unit helpers ---------------------------------------------------------
// The nine coordinate lists for a given row / column / box index.
function rowCells(r) {
  return Array.from({ length: N }, (_, c) => [r, c]);
}
function colCells(c) {
  return Array.from({ length: N }, (_, r) => [r, c]);
}
function boxCells(b) {
  const r0 = Math.floor(b / BOX) * BOX;
  const c0 = (b % BOX) * BOX;
  const cells = [];
  for (let dr = 0; dr < BOX; dr++) {
    for (let dc = 0; dc < BOX; dc++) cells.push([r0 + dr, c0 + dc]);
  }
  return cells;
}

// ---- Generation -----------------------------------------------------------
// A blank 9×9 grid whose cells are produced by fill().
function grid(fill) {
  return Array.from({ length: N }, () => Array.from({ length: N }, fill));
}

// Build a complete, valid solution by randomized backtracking: walk the cells
// in order, trying digits 1..9 in a shuffled order and recursing; backtrack on
// dead ends. A full Sudoku always exists, so this always succeeds.
function makeSolution() {
  const b = grid(() => 0);

  const fits = (r, c, v) => {
    for (let i = 0; i < N; i++) {
      if (b[r][i] === v || b[i][c] === v) return false;
    }
    const r0 = Math.floor(r / BOX) * BOX;
    const c0 = Math.floor(c / BOX) * BOX;
    for (let dr = 0; dr < BOX; dr++) {
      for (let dc = 0; dc < BOX; dc++) {
        if (b[r0 + dr][c0 + dc] === v) return false;
      }
    }
    return true;
  };

  const solve = (pos) => {
    if (pos === N * N) return true;
    const r = Math.floor(pos / N);
    const c = pos % N;
    for (const v of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
      if (fits(r, c, v)) {
        b[r][c] = v;
        if (solve(pos + 1)) return true;
        b[r][c] = 0;
      }
    }
    return false;
  };

  solve(0);
  return b;
}

// A givens mask with exactly `count` ones, placed uniformly at random. We carve
// from a full puzzle rather than the other way around, so the clue count is
// exact and predictable (the solution is the unique source of truth for play).
function makeGivenMask(count) {
  const mask = grid(() => 0);
  const all = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) all.push([r, c]);
  }
  shuffle(all);
  for (let i = 0; i < count; i++) {
    const [r, c] = all[i];
    mask[r][c] = 1;
  }
  return mask;
}

// Fisher–Yates shuffle, in place; returns the array for chaining.
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Kept behind a helper so the randomness source is easy to see/swap.
function rand() {
  return Math.random();
}
