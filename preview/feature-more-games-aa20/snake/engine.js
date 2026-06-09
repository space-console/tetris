// Snake engine — the pure game core. No DOM, no rendering, no input: it owns
// the grid, the snake's body and heading, food placement, growth, scoring and
// the tick speed-up, and exposes a small command surface (turn / tick / reset).
// app.js drives it from the intent stream and renders its state.

export const COLS = 21;
export const ROWS = 21;

// Direction vectors. The snake always carries one of these as its heading; a
// turn swaps it for another, except a direct reverse into its own neck.
const DIRS = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Tick interval (ms per step) by score band: starts slow, speeds up as the
// snake grows, then caps so the game stays playable at high scores.
const START_MS = 140;
const MIN_MS = 60;
const SPEEDUP_MS = 6; // shaved off the interval per food eaten

export class Engine extends EventTarget {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    // Snake starts as three cells in the middle, heading right. Index 0 is the
    // head; the tail is the last element.
    const cy = Math.floor(ROWS / 2);
    const cx = Math.floor(COLS / 2);
    this.snake = [
      { x: cx, y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ];
    this.dir = DIRS.right;       // current heading
    this.nextDir = DIRS.right;   // buffered turn, applied at the next tick
    this.score = 0;
    this.over = false;
    this.food = null;
    this._placeFood();
    this._changed();
  }

  // Queue a turn. Ignored if it would reverse directly into the neck (a 180°
  // flip), or if the direction is unchanged. Buffered until the next tick so a
  // fast double-tap can't fold the snake onto itself within one step.
  turn(name) {
    if (this.over) return false;
    const d = DIRS[name];
    if (!d) return false;
    // Reject reversal relative to the heading the snake will actually move on.
    if (d.x === -this.dir.x && d.y === -this.dir.y) return false;
    if (d.x === this.nextDir.x && d.y === this.nextDir.y) return false;
    this.nextDir = d;
    return true;
  }

  // One game step: advance the head, handle food / collisions, grow or move.
  // Returns true if the snake ate this tick (so the shell can blip), false otherwise.
  tick() {
    if (this.over) return false;
    this.dir = this.nextDir;
    const head = this.snake[0];
    const nx = head.x + this.dir.x;
    const ny = head.y + this.dir.y;

    // Wall collision.
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) {
      this._die();
      return false;
    }

    // Self collision. The tail cell is about to vacate, so it's safe to enter
    // unless we're growing this tick (head lands on food).
    const eating = this.food && nx === this.food.x && ny === this.food.y;
    const ignoreTail = !eating;
    for (let i = 0; i < this.snake.length; i++) {
      if (i === this.snake.length - 1 && ignoreTail) continue;
      if (this.snake[i].x === nx && this.snake[i].y === ny) {
        this._die();
        return false;
      }
    }

    this.snake.unshift({ x: nx, y: ny });
    if (eating) {
      this.score += 1;
      this._placeFood();
      this.dispatchEvent(new CustomEvent("eat", { detail: { score: this.score } }));
    } else {
      this.snake.pop(); // move: drop the tail so length stays the same
    }
    this._changed();
    return eating;
  }

  // Current tick interval in ms — shrinks with score, floored at MIN_MS.
  tickInterval() {
    return Math.max(MIN_MS, START_MS - this.score * SPEEDUP_MS);
  }

  _die() {
    this.over = true;
    this.dispatchEvent(new CustomEvent("gameover", { detail: { score: this.score } }));
  }

  // Drop food on a random cell not currently occupied by the snake. If the
  // board is full (a winning board) there's nowhere to go — leave food null.
  _placeFood() {
    const free = [];
    const occupied = new Set(this.snake.map((c) => c.y * COLS + c.x));
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        if (!occupied.has(y * COLS + x)) free.push({ x, y });
      }
    }
    this.food = free.length ? free[Math.floor(rand() * free.length)] : null;
  }

  _changed() {
    this.dispatchEvent(new CustomEvent("change"));
  }
}

// Math.random is unavailable inside workflow scripts but fine in the browser;
// kept behind a helper so the randomness source is easy to see/swap.
function rand() {
  return Math.random();
}
