// Fruit Ninja engine — the pure game core. No DOM, no rendering, no input.
// It owns the entities (fruits + bombs) flying on a parabolic arc, the spawn
// pacing that ramps up over time, the blade slice test (segment vs circle),
// scoring with combo bonuses, lives and game-over. The shell (app.js) drives it
// with an injected dt and a seedable RNG, and renders its state.
//
// Coordinate space is normalised to a virtual playfield WIDTH×HEIGHT; the shell
// scales it to the canvas. y grows downward (screen coordinates); gravity pulls
// y downward, fruits launch with negative vy (upward), arc over and fall.

export const WIDTH = 100;   // virtual units wide
export const HEIGHT = 150;  // virtual units tall (portrait)
export const GRAVITY = 90;  // units / s²  (tuned so a fruit arcs for a few s)

const MAX_MISSES = 3;

// A small seedable RNG (mulberry32) so the self-test and any replay is
// deterministic. The browser shell seeds it from Date.now().
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _id = 0;

export class Engine {
  constructor(rng = makeRng(Date.now() >>> 0)) {
    this.rng = rng;
    this.reset();
  }

  reset() {
    this.entities = [];      // {id,x,y,vx,vy,r,type,angle,spin,sliced,missed}
    this.particles = [];     // juice splashes {x,y,vx,vy,life,max,color}
    this.score = 0;
    this.lives = MAX_MISSES;
    this.misses = 0;
    this.over = false;
    this.elapsed = 0;        // seconds since reset — drives the difficulty ramp
    this.spawnTimer = 0;     // seconds until the next spawn
    this._scheduleSpawn();
  }

  // ---- Difficulty ramp ----------------------------------------------------
  // Spawn interval shrinks and bomb chance grows the longer you survive.
  _spawnInterval() {
    // 1.4s at the start, easing toward ~0.5s after ~90s of play.
    return Math.max(0.5, 1.4 - this.elapsed * 0.01);
  }
  _bombChance() {
    return Math.min(0.22, 0.05 + this.elapsed * 0.0015);
  }
  _scheduleSpawn() {
    const iv = this._spawnInterval();
    // ±25% jitter so launches don't feel metronomic.
    this.spawnTimer = iv * (0.75 + this.rng() * 0.5);
  }

  // ---- Spawning -----------------------------------------------------------
  // Launch one (occasionally two) entities from just below the bottom edge,
  // arcing upward toward the opposite side so they cross the playfield.
  _spawn() {
    const burst = this.rng() < 0.25 ? 2 : 1; // small clusters keep combos alive
    for (let i = 0; i < burst; i++) {
      const fromLeft = this.rng() < 0.5;
      const x = fromLeft
        ? WIDTH * (0.1 + this.rng() * 0.25)
        : WIDTH * (0.65 + this.rng() * 0.25);
      const y = HEIGHT + 6;
      // Horizontal drift carries it toward the far side.
      const vx = (fromLeft ? 1 : -1) * (8 + this.rng() * 10);
      // Upward launch strong enough to clear most of the height before falling.
      const vy = -(50 + this.rng() * 16);
      const isBomb = this.rng() < this._bombChance();
      this.entities.push({
        id: _id++,
        x, y, vx, vy,
        r: isBomb ? 5.5 : 5 + this.rng() * 1.5,
        type: isBomb ? "bomb" : "fruit",
        kind: isBomb ? -1 : Math.floor(this.rng() * 5), // fruit colour/style index
        angle: this.rng() * Math.PI * 2,
        spin: (this.rng() - 0.5) * 4,
        sliced: false,
        missed: false,
      });
    }
  }

  // ---- Simulation ---------------------------------------------------------
  // Advance the world by dt seconds. Pure: same dt + same RNG → same result.
  step(dt) {
    if (this.over) return;
    this.elapsed += dt;

    // Spawning.
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this._spawn();
      this._scheduleSpawn();
    }

    // Integrate entities (semi-implicit Euler: gravity first, then position).
    for (const e of this.entities) {
      e.vy += GRAVITY * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.angle += e.spin * dt;
    }

    // Integrate juice particles.
    for (const p of this.particles) {
      p.vy += GRAVITY * 1.4 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);

    // Cull entities that fell off the bottom. An unsliced FRUIT that escapes
    // costs a life (3 misses ⇒ game over). Missed bombs are harmless.
    const kept = [];
    for (const e of this.entities) {
      // Halves keep flying off-screen; only count whole, unsliced bodies.
      if (e.y - e.r > HEIGHT + 4) {
        if (!e.sliced && !e.half && e.type === "fruit") {
          this.misses += 1;
          this.lives = Math.max(0, MAX_MISSES - this.misses);
          this._emit("miss");
          if (this.misses >= MAX_MISSES) this._gameOver();
        }
        continue; // drop it
      }
      // Far off either side, also retire it.
      if (e.x < -20 || e.x > WIDTH + 20) continue;
      kept.push(e);
    }
    this.entities = kept;
  }

  // ---- Slicing ------------------------------------------------------------
  // Test the blade segment (x1,y1)→(x2,y2) against every live whole entity.
  // Returns the list of entities the blade crossed this frame. Slicing a fruit
  // scores (with a combo bonus for multiples in one swipe); slicing a bomb ends
  // the game.
  sliceSegment(x1, y1, x2, y2) {
    if (this.over) return [];
    const hits = [];
    for (const e of this.entities) {
      if (e.sliced || e.half) continue;
      if (segCircle(x1, y1, x2, y2, e.x, e.y, e.r)) {
        e.sliced = true;
        hits.push(e);
      }
    }
    if (hits.length === 0) return hits;

    // Any bomb in the swipe ends the game immediately.
    const bomb = hits.find((e) => e.type === "bomb");
    if (bomb) {
      this._spawnSplash(bomb, true);
      this._emit("bomb");
      this._gameOver();
      return hits;
    }

    // Score fruits: 1 base point each, plus a combo bonus that grows with the
    // number sliced in this single swipe.
    const n = hits.length;
    let gained = 0;
    for (let i = 0; i < n; i++) gained += 1 + i; // 1,2,3… → combo escalates
    this.score += gained;
    for (const e of hits) this._spawnSplash(e, false);
    this._emit("slice", { count: n });
    return hits;
  }

  // Spray a few juice particles and mark the body as a pair of flying halves.
  _spawnSplash(e, isBomb) {
    e.half = true; // flagged so it's drawn as halves and no longer sliceable
    const count = isBomb ? 14 : 8;
    for (let i = 0; i < count; i++) {
      const a = this.rng() * Math.PI * 2;
      const sp = 12 + this.rng() * 26;
      this.particles.push({
        x: e.x, y: e.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 8,
        life: 0.5 + this.rng() * 0.5,
        max: 1,
        color: isBomb ? "#3a3a3a" : FRUIT_COLORS[e.kind] || "#ff5a5a",
        bomb: isBomb,
      });
    }
  }

  _gameOver() {
    if (this.over) return;
    this.over = true;
    this._emit("gameover");
  }

  // Minimal event surface (mirrors the EventTarget pattern of other engines but
  // stays DOM-free so the engine runs under plain Node for the self-test).
  on(handler) { (this._handlers ||= new Set()).add(handler); return this; }
  _emit(type, detail = {}) {
    if (!this._handlers) return;
    for (const h of this._handlers) h(type, detail);
  }
}

// Fruit fill colours, indexed by `kind` (watermelon, apple, orange, lemon, kiwi).
export const FRUIT_COLORS = ["#e23b46", "#5ec85e", "#ff9d2e", "#f4d33b", "#8bc34a"];

// ---- Geometry --------------------------------------------------------------
// Shortest distance from point (cx,cy) to segment (x1,y1)→(x2,y2); true when it
// is within r (the blade crosses the circle's body this frame).
export function segCircle(x1, y1, x2, y2, cx, cy, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((cx - x1) * dx + (cy - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  const ddx = cx - px;
  const ddy = cy - py;
  return ddx * ddx + ddy * ddy <= r * r;
}
