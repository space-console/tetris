// Tic-Tac-Boom — a Bomberman-style maze bomber. Pure logic + a fixed-step
// simulation: no DOM and no timers (app.js owns the clock and calls update(dt)).
//
// You vs AI bombers on a destructible grid. Walk the maze, drop bombs whose
// cross-shaped blast destroys soft blocks and any bomber caught in it, grab the
// power-ups hidden in the rubble (extra bombs, longer blast, more speed), and be
// the last bomber standing.
//
// The grid is the classic odd-sized Bomberman layout: a solid border, a lattice
// of indestructible pillars on the even/even tiles, and destructible soft blocks
// scattered over the rest (spawn corners kept clear). Positions are continuous
// tile coordinates (1 unit = 1 tile); movement is grid-aligned so bombers run
// cleanly down corridors and only turn at tile centres.

export const COLS = 13;
export const ROWS = 11;

export const EMPTY = 0;
export const WALL = 1;   // indestructible (border + pillars)
export const SOFT = 2;   // destructible block

// Power-up kinds revealed from destroyed soft blocks.
export const PU_BOMB = "bomb";   // +1 bomb you can have out at once
export const PU_FIRE = "fire";   // +1 blast range
export const PU_SPEED = "speed"; // faster movement

export const PLAYER_COLORS = ["red", "blue", "green", "yellow"];

// Spawn corners, in player order (player 0 = the human, top-left).
const SPAWNS = [
  { col: 1, row: 1 },
  { col: COLS - 2, row: ROWS - 2 },
  { col: COLS - 2, row: 1 },
  { col: 1, row: ROWS - 2 },
];

const BOMB_FUSE = 2.4;       // seconds before a bomb detonates
const FLAME_TIME = 0.5;      // seconds the blast flames linger (and stay lethal)
const BASE_SPEED = 3.6;      // tiles / second
const SPEED_STEP = 0.7;
const MAX_SPEED = 6.2;
const START_RANGE = 2;
const START_BOMBS = 1;
const SOFT_FILL = 0.72;      // chance an eligible empty tile gets a soft block
const PU_CHANCE = 0.42;      // chance a soft block hides a power-up

// Sudden death: after SD_START seconds, indestructible walls drop in an inward
// spiral, shrinking the arena so cautious bombers can't stall forever — this is
// how the real game guarantees a finish (and makes the endgame tense).
const SD_START = 42;         // seconds before sudden death begins
const SD_INTERVAL = 0.34;    // seconds between dropped walls

const DIRS = ["up", "down", "left", "right"];
const DX = { left: -1, right: 1, up: 0, down: 0 };
const DY = { left: 0, right: 0, up: -1, down: 1 };
const OPP = { left: "right", right: "left", up: "down", down: "up" };
const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function key(c, r) { return r * COLS + c; }

export class Engine {
  constructor({ players = 4, rng = Math.random } = {}) {
    this.rng = rng;
    this.numPlayers = Math.max(2, Math.min(4, players));
    this.reset();
  }

  reset() {
    this._buildGrid();
    this.bombs = [];           // {col,row,owner,fuse,range,passers:Set<id>}
    this.flames = new Map();   // key -> seconds left
    this.pickups = new Map();  // key -> power-up type (lying on the floor)
    this.players = [];
    for (let i = 0; i < this.numPlayers; i++) {
      const s = SPAWNS[i];
      this.players.push({
        id: i,
        color: PLAYER_COLORS[i],
        x: s.col, y: s.row,
        dir: null, wantDir: null,
        alive: true,
        maxBombs: START_BOMBS, bombsActive: 0,
        range: START_RANGE, speed: BASE_SPEED,
        ai: i !== 0,
      });
    }
    this.winner = null;  // player id, -1 for a draw, or null while ongoing
    this.over = false;

    this.time = 0;
    this.suddenDeath = false;
    this.sdWalls = new Set();   // tiles walled by sudden death (for the renderer)
    this._sdOrder = this._buildSpiral();
    this._sdIndex = 0;
    this._sdTimer = 0;
  }

  // Clockwise inward spiral over the interior tiles — the order walls drop in
  // during sudden death.
  _buildSpiral() {
    const order = [];
    let top = 1, bottom = ROWS - 2, left = 1, right = COLS - 2;
    while (top <= bottom && left <= right) {
      for (let c = left; c <= right; c++) order.push(key(c, top));
      for (let r = top + 1; r <= bottom; r++) order.push(key(right, r));
      if (top < bottom) for (let c = right - 1; c >= left; c--) order.push(key(c, bottom));
      if (left < right) for (let r = bottom - 1; r >= top + 1; r--) order.push(key(left, r));
      top++; bottom--; left++; right--;
    }
    return order;
  }

  // Lattice of pillars + border; the rest seeded with soft blocks (spawn pockets
  // kept clear) and a hidden power-up map.
  _buildGrid() {
    this.grid = new Array(COLS * ROWS).fill(EMPTY);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const border = r === 0 || c === 0 || r === ROWS - 1 || c === COLS - 1;
        if (border || (r % 2 === 0 && c % 2 === 0)) this.grid[key(c, r)] = WALL;
      }
    }
    const safe = new Set();
    for (const s of SPAWNS.slice(0, this.numPlayers)) {
      for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
        safe.add(key(s.col + dc, s.row + dr));
      }
    }
    this._puCells = new Map();
    for (let r = 1; r < ROWS - 1; r++) {
      for (let c = 1; c < COLS - 1; c++) {
        const k = key(c, r);
        if (this.grid[k] !== EMPTY || safe.has(k)) continue;
        if (this.rng() < SOFT_FILL) {
          this.grid[k] = SOFT;
          if (this.rng() < PU_CHANCE) {
            const roll = this.rng();
            this._puCells.set(k, roll < 0.4 ? PU_FIRE : roll < 0.75 ? PU_BOMB : PU_SPEED);
          }
        }
      }
    }
  }

  cell(c, r) {
    if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return WALL;
    return this.grid[key(c, r)];
  }
  bombAt(c, r) { return this.bombs.find((b) => b.col === c && b.row === r) || null; }

  // Can player `p` stand on (c,r)? Floor tile, no wall/soft, and no bomb (unless
  // it's a bomb `p` is still standing on after dropping it).
  walkable(p, c, r) {
    if (this.cell(c, r) !== EMPTY) return false;
    const b = this.bombAt(c, r);
    if (b && !(p && b.passers.has(p.id))) return false;
    return true;
  }

  // ---- Intent (driven by app.js for the human, by _ai for the rest) ---------
  setWantDir(id, dir) { const p = this.players[id]; if (p && p.alive) p.wantDir = dir; }

  placeBomb(id) {
    const p = this.players[id];
    if (!p || !p.alive || p.bombsActive >= p.maxBombs) return false;
    const c = Math.round(p.x), r = Math.round(p.y);
    if (this.bombAt(c, r)) return false;
    const passers = new Set();
    for (const q of this.players) {
      if (q.alive && Math.round(q.x) === c && Math.round(q.y) === r) passers.add(q.id);
    }
    this.bombs.push({ col: c, row: r, owner: id, fuse: BOMB_FUSE, range: p.range, passers });
    p.bombsActive += 1;
    return true;
  }

  // ---- Fixed-step simulation ------------------------------------------------
  // Returns the events that occurred this step (the app turns them into sound).
  update(dt) {
    if (this.over) return [];
    const events = [];

    // Flames decay.
    for (const [k, t] of this.flames) {
      const n = t - dt;
      if (n <= 0) this.flames.delete(k); else this.flames.set(k, n);
    }

    // Fuses burn; detonate the ones that hit zero (chains handled inside).
    for (const b of this.bombs.slice()) {
      b.fuse -= dt;
      if (b.fuse <= 0) this._explode(b, events);
    }

    // Bombers: think (AI), move, collect, burn.
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.ai) this._ai(p);
      this._move(p, dt);

      const c = Math.round(p.x), r = Math.round(p.y), k = key(c, r);
      if (this.pickups.has(k)) {
        this._applyPickup(p, this.pickups.get(k));
        this.pickups.delete(k);
        events.push({ type: "pickup" });
      }
      if (this.flames.has(k)) this._kill(p, events);
    }

    // Release a bomb's "passable" flag once its dropper has stepped off it.
    for (const b of this.bombs) {
      for (const id of [...b.passers]) {
        const q = this.players[id];
        if (!q.alive || Math.round(q.x) !== b.col || Math.round(q.y) !== b.row) b.passers.delete(id);
      }
    }

    // Sudden death: drop the next walls of the inward spiral.
    this.time += dt;
    if (this.time >= SD_START) {
      if (!this.suddenDeath) { this.suddenDeath = true; events.push({ type: "sudden" }); }
      this._sdTimer += dt;
      while (this._sdTimer >= SD_INTERVAL && this._sdIndex < this._sdOrder.length) {
        const k = this._sdOrder[this._sdIndex++];
        if (this.grid[k] === WALL) continue;          // already a pillar — skip, no delay
        this._sdTimer -= SD_INTERVAL;
        this._dropWall(k, events);
      }
    }

    this._checkWin(events);
    return events;
  }

  // Slam an indestructible wall onto a tile: clear its contents, crush any bomber
  // standing there.
  _dropWall(k, events) {
    const c = k % COLS, r = Math.floor(k / COLS);
    const bi = this.bombs.findIndex((b) => b.col === c && b.row === r);
    if (bi !== -1) {
      const owner = this.players[this.bombs[bi].owner];
      if (owner) owner.bombsActive = Math.max(0, owner.bombsActive - 1);
      this.bombs.splice(bi, 1);
    }
    this.pickups.delete(k);
    this.flames.delete(k);
    this.grid[k] = WALL;
    this.sdWalls.add(k);
    events.push({ type: "sdwall", c, r });
    for (const p of this.players) {
      if (p.alive && Math.round(p.x) === c && Math.round(p.y) === r) this._kill(p, events);
    }
  }

  _explode(b, events) {
    const idx = this.bombs.indexOf(b);
    if (idx === -1) return; // already gone (detonated by a chain)
    this.bombs.splice(idx, 1);
    const owner = this.players[b.owner];
    if (owner) owner.bombsActive = Math.max(0, owner.bombsActive - 1);
    events.push({ type: "boom" });

    const lay = (c, r) => this.flames.set(key(c, r), FLAME_TIME);
    lay(b.col, b.row);
    for (const [dc, dr] of NEI) {
      for (let s = 1; s <= b.range; s++) {
        const c = b.col + dc * s, r = b.row + dr * s;
        const cv = this.cell(c, r);
        if (cv === WALL) break;
        if (cv === SOFT) {
          this.grid[key(c, r)] = EMPTY;
          lay(c, r);
          const k = key(c, r);
          if (this._puCells.has(k)) { this.pickups.set(k, this._puCells.get(k)); this._puCells.delete(k); }
          events.push({ type: "block" });
          break; // the blast stops at the first soft block
        }
        lay(c, r);
        const other = this.bombAt(c, r);
        if (other) { this._explode(other, events); break; } // chain reaction
      }
    }
    // Anything standing in the fresh flames dies immediately.
    for (const p of this.players) {
      if (p.alive && this.flames.has(key(Math.round(p.x), Math.round(p.y)))) this._kill(p, events);
    }
  }

  _kill(p, events) {
    if (!p.alive) return;
    p.alive = false;
    p.dir = null;
    p.wantDir = null;
    events.push({ type: "death", id: p.id, human: p.id === 0 });
  }

  _applyPickup(p, type) {
    if (type === PU_BOMB) p.maxBombs += 1;
    else if (type === PU_FIRE) p.range += 1;
    else if (type === PU_SPEED) p.speed = Math.min(MAX_SPEED, p.speed + SPEED_STEP);
  }

  // Grid-aligned movement: turn only at tile centres, run straight otherwise, and
  // stop dead at a wall/soft/bomb tile ahead.
  _move(p, dt) {
    const eps = 0.08;
    const cx = Math.round(p.x), cy = Math.round(p.y);
    const centered = Math.abs(p.x - cx) < eps && Math.abs(p.y - cy) < eps;
    const want = p.wantDir;

    if (centered) {
      p.x = cx; p.y = cy;
      p.dir = want && this.walkable(p, cx + DX[want], cy + DY[want]) ? want : null;
    } else if (want && OPP[want] === p.dir) {
      p.dir = want; // allow an instant about-face mid-corridor
    }
    if (!p.dir) return;

    const d = p.dir;
    let nx = p.x + DX[d] * p.speed * dt;
    let ny = p.y + DY[d] * p.speed * dt;
    if (d === "right" && !this.walkable(p, cx + 1, cy)) nx = Math.min(nx, cx);
    else if (d === "left" && !this.walkable(p, cx - 1, cy)) nx = Math.max(nx, cx);
    else if (d === "down" && !this.walkable(p, cx, cy + 1)) ny = Math.min(ny, cy);
    else if (d === "up" && !this.walkable(p, cx, cy - 1)) ny = Math.max(ny, cy);
    p.x = nx; p.y = ny;
  }

  _checkWin(events) {
    const alive = this.players.filter((p) => p.alive);
    if (alive.length <= 1) {
      this.over = true;
      this.winner = alive.length === 1 ? alive[0].id : -1;
      events.push({ type: "over", winner: this.winner });
    }
  }

  // ---- AI -------------------------------------------------------------------
  // A reactive bomber: flee danger first, else lay a bomb when it can hurt a
  // block/enemy AND it has an escape, else path toward the nearest useful tile.
  // Decisions are made only at tile centres so movement stays grid-clean.
  _ai(p) {
    if (!this._atCenter(p)) return;
    const c = Math.round(p.x), r = Math.round(p.y);
    const danger = this._dangerSet();

    if (danger.has(key(c, r))) {
      p.wantDir = this._bfsStep(p, (cc, rr) => !danger.has(key(cc, rr)), danger) ||
        this._randSafeDir(p, danger);
      return;
    }

    if (p.bombsActive < p.maxBombs && this._worthBombing(p, c, r)) {
      const after = this._blastTilesFor(c, r, p.range);
      const avoid = new Set([...danger, ...after]);
      const escape = this._bfsStep(p, (cc, rr) => !after.has(key(cc, rr)) && !danger.has(key(cc, rr)), avoid);
      if (escape) {
        this.placeBomb(p.id);
        p.wantDir = escape;
        return;
      }
    }

    p.wantDir = this._bfsStep(p, (cc, rr) => this._isTargetCell(cc, rr, p), danger) ||
      this._randSafeDir(p, danger);
  }

  _atCenter(p) { return Math.abs(p.x - Math.round(p.x)) < 0.06 && Math.abs(p.y - Math.round(p.y)) < 0.06; }

  _blastTilesFor(c, r, range) {
    const t = new Set([key(c, r)]);
    for (const [dc, dr] of NEI) {
      for (let s = 1; s <= range; s++) {
        const cc = c + dc * s, rr = r + dr * s, cv = this.cell(cc, rr);
        if (cv === WALL) break;
        t.add(key(cc, rr));
        if (cv === SOFT) break;
      }
    }
    return t;
  }

  _dangerSet() {
    const d = new Set();
    for (const b of this.bombs) for (const k of this._blastTilesFor(b.col, b.row, b.range)) d.add(k);
    for (const k of this.flames.keys()) d.add(k);
    return d;
  }

  // Breadth-first search from p's tile; returns the FIRST step direction toward
  // the nearest tile satisfying goal(), walking only over walkable tiles and not
  // routing through `avoid` tiles (unless the avoid tile is itself the goal).
  _bfsStep(p, goal, avoid) {
    const sc = Math.round(p.x), sr = Math.round(p.y);
    if (goal(sc, sr)) return null;
    const q = [[sc, sr, null]];
    const seen = new Set([key(sc, sr)]);
    while (q.length) {
      const [c, r, first] = q.shift();
      for (const dir of DIRS) {
        const nc = c + DX[dir], nr = r + DY[dir], k = key(nc, nr);
        if (seen.has(k) || !this.walkable(p, nc, nr)) continue;
        const isGoal = goal(nc, nr);
        if (avoid && avoid.has(k) && !isGoal) continue;
        seen.add(k);
        const f = first || dir;
        if (isGoal) return f;
        q.push([nc, nr, f]);
      }
    }
    return null;
  }

  _worthBombing(p, c, r) {
    for (const [dc, dr] of NEI) if (this.cell(c + dc, r + dr) === SOFT) return true;
    for (const [dc, dr] of NEI) {
      for (let s = 1; s <= p.range; s++) {
        const cc = c + dc * s, rr = r + dr * s, cv = this.cell(cc, rr);
        if (cv === WALL || cv === SOFT) break;
        if (this.players.some((q) => q.alive && q.id !== p.id && Math.round(q.x) === cc && Math.round(q.y) === rr)) return true;
      }
    }
    return false;
  }

  _isTargetCell(c, r, p) {
    for (const [dc, dr] of NEI) {
      if (this.cell(c + dc, r + dr) === SOFT) return true;
      if (this.players.some((q) => q.alive && q.id !== p.id && Math.round(q.x) === c + dc && Math.round(q.y) === r + dr)) return true;
    }
    return false;
  }

  _randSafeDir(p, danger) {
    const opts = DIRS.filter((d) => {
      const nc = Math.round(p.x) + DX[d], nr = Math.round(p.y) + DY[d];
      return this.walkable(p, nc, nr) && !(danger && danger.has(key(nc, nr)));
    });
    return opts.length ? opts[Math.floor(this.rng() * opts.length)] : null;
  }
}
