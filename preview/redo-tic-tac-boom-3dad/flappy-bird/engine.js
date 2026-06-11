// Flappy Bird engine — the pure game core. No DOM, no rendering, no input: it
// owns the bird (y, vy), gravity, the scrolling pipes, scoring and collision
// detection, and exposes a small command surface (flap / step / reset). app.js
// drives it from the intent stream + a fixed-dt accumulator and renders its
// state.
//
// Deterministic by construction: step() takes the elapsed time (dt, seconds)
// and all randomness flows through an injected, seedable RNG, so the same
// inputs always produce the same run (which is what makes the self-test
// possible without a DOM).

// World units are virtual pixels on a tall portrait field; the renderer scales
// this box to whatever canvas size the device gives us.
export const WORLD_W = 400;
export const WORLD_H = 700;

// Bird geometry / physics (units per second). Tuned for a fair, gentle feel.
export const BIRD_X = 120;       // bird stays at a fixed x; the world scrolls past
export const BIRD_R = 16;        // collision radius
const GRAVITY = 1500;            // downward acceleration (units/s^2)
const FLAP_VY = -480;            // upward impulse velocity on a flap (units/s)
const MAX_VY = 700;              // terminal velocity, so falls stay readable

// Pipes.
export const PIPE_W = 70;        // pipe width
const PIPE_SPEED = 160;          // leftward scroll speed (units/s)
const PIPE_SPACING = 230;        // horizontal distance between pipe pairs
const GAP_H = 190;               // vertical opening height
const GAP_MARGIN = 90;           // keep the gap away from ceiling/ground

// Ground strip height (collidable floor sits at WORLD_H - GROUND_H).
export const GROUND_H = 90;
export const FLOOR_Y = WORLD_H - GROUND_H;

// A tiny seedable PRNG (mulberry32) so runs are reproducible for the self-test.
// Returns a function yielding floats in [0, 1).
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Engine extends EventTarget {
  // rng: () => [0,1). Defaults to a fixed seed so behaviour is deterministic
  // unless the caller injects Math.random (the browser does, for variety).
  constructor(rng = makeRng(1)) {
    super();
    this.rng = rng;
    this.reset();
  }

  reset() {
    // bird sits mid-field at rest until the first flap.
    this.bird = { y: WORLD_H * 0.42, vy: 0 };
    this.pipes = [];          // [{ x, gapY, gapH, scored }] — gapY is the gap's top edge
    this.score = 0;
    this.state = "idle";      // idle | playing | over
    this._spawnX = WORLD_W;   // x at which to drop the next pipe pair
    this._seedPipes();
  }

  // Pre-place a couple of pipes off to the right so the field isn't empty when
  // play begins. They scroll in from the edge. _spawnX tracks the x of the NEXT
  // pipe to spawn — always one PIPE_SPACING past the last placed pipe — so the
  // spawn cadence matches the seeded spacing exactly.
  _seedPipes() {
    this.pipes = [];
    // First pipe a little past the right edge so the player gets a beat to
    // settle before it arrives; the rest follow at the regular spacing.
    let x = WORLD_W + 80;
    for (let i = 0; i < 3; i++) {
      this.pipes.push(this._makePipe(x));
      x += PIPE_SPACING;
    }
    this._spawnX = x;
  }

  _makePipe(x) {
    // gapY = top edge of the opening; keep it within the playable band.
    const minTop = GAP_MARGIN;
    const maxTop = FLOOR_Y - GAP_MARGIN - GAP_H;
    const gapY = minTop + this.rng() * Math.max(0, maxTop - minTop);
    return { x, gapY, gapH: GAP_H, scored: false };
  }

  // Begin a run from idle/over: a flap is what kicks it off.
  start() {
    this.reset();
    this.state = "playing";
    this.flap();
  }

  // Apply the upward impulse. Only meaningful while playing.
  flap() {
    if (this.state !== "playing") return;
    this.bird.vy = FLAP_VY;
    this.dispatchEvent(new CustomEvent("flap"));
  }

  // Advance the world by dt seconds. Integrates gravity, scrolls + recycles
  // pipes, scores passed pairs, and detects collisions. Safe to call with the
  // game idle/over (it no-ops), so the render loop can call it unconditionally.
  step(dt) {
    if (this.state !== "playing") return;

    // --- Bird physics (semi-implicit Euler). ---
    this.bird.vy = Math.min(MAX_VY, this.bird.vy + GRAVITY * dt);
    this.bird.y += this.bird.vy * dt;

    // --- Scroll pipes; spawn new ones at a fixed spacing; cull off-screen. ---
    // _spawnX is the x of the next pipe to drop. Once it scrolls to the right
    // edge, place the pipe there and advance the marker one spacing further out.
    for (const p of this.pipes) p.x -= PIPE_SPEED * dt;
    this._spawnX -= PIPE_SPEED * dt;
    while (this._spawnX <= WORLD_W) {
      this.pipes.push(this._makePipe(this._spawnX));
      this._spawnX += PIPE_SPACING;
    }
    this.pipes = this.pipes.filter((p) => p.x + PIPE_W > -PIPE_W);

    // --- Scoring: +1 the moment the bird's x clears a pair's right edge. ---
    for (const p of this.pipes) {
      if (!p.scored && p.x + PIPE_W < BIRD_X) {
        p.scored = true;
        this.score += 1;
        this.dispatchEvent(new CustomEvent("score", { detail: { score: this.score } }));
      }
    }

    // --- Collisions: ceiling, ground, and the two rects of each near pipe. ---
    if (this._collides()) {
      this.state = "over";
      this.dispatchEvent(new CustomEvent("gameover", { detail: { score: this.score } }));
    }
  }

  // True if the bird (a circle at BIRD_X / bird.y, radius BIRD_R) overlaps the
  // ceiling, the ground, or any pipe rectangle.
  _collides() {
    const by = this.bird.y;
    if (by - BIRD_R <= 0) return true;            // ceiling
    if (by + BIRD_R >= FLOOR_Y) return true;      // ground

    for (const p of this.pipes) {
      // Only pipes overlapping the bird's x-band can possibly touch it.
      if (p.x > BIRD_X + BIRD_R || p.x + PIPE_W < BIRD_X - BIRD_R) continue;
      const top = { x: p.x, y: 0, w: PIPE_W, h: p.gapY };
      const bot = { x: p.x, y: p.gapY + p.gapH, w: PIPE_W, h: FLOOR_Y - (p.gapY + p.gapH) };
      if (circleHitsRect(BIRD_X, by, BIRD_R, top)) return true;
      if (circleHitsRect(BIRD_X, by, BIRD_R, bot)) return true;
    }
    return false;
  }
}

// Circle vs axis-aligned rectangle: clamp the circle centre to the rect, then
// test the distance to that nearest point against the radius.
function circleHitsRect(cx, cy, r, rect) {
  const nx = Math.max(rect.x, Math.min(cx, rect.x + rect.w));
  const ny = Math.max(rect.y, Math.min(cy, rect.y + rect.h));
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}
