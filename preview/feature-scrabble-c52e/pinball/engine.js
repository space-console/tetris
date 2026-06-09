// Pinball physics engine for the Space Console — pure simulation, no DOM.
//
// A vertical table (WIDTH x HEIGHT, in "table units" that the renderer scales to
// the canvas) with a single ball under gravity. Collisions are resolved against
// two primitive shapes only — line SEGMENTS (the table outline, walls, slings,
// flippers) and CIRCLES (bumpers) — which keeps the maths simple and reliable.
//
// Determinism: step(dt) is fixed-timestep and takes dt explicitly so the same
// inputs always produce the same trajectory (and so it can be unit-tested in
// node). The owning app calls update(realDt) which feeds a fixed-step accumulator.
//
// Coordinate system: x→right, y→DOWN (canvas convention), so GRAVITY is +y.

export const WIDTH = 400;
export const HEIGHT = 640;

// ---- Tuning ----------------------------------------------------------------
// Units are table-units / second. The fixed step is small (FIXED_DT) so a fast
// ball never travels more than a fraction of its radius per substep, which —
// together with swept circle-vs-segment tests — prevents tunnelling.
export const FIXED_DT = 1 / 240;        // physics substep (seconds)
const GRAVITY = 900;                    // downward accel (units/s^2)
const WALL_RESTITUTION = 0.55;          // bounciness off static walls
const BUMPER_RESTITUTION = 1.05;        // bumpers kick the ball a little harder
const SLING_RESTITUTION = 1.15;         // slingshots are lively
const FLIPPER_RESTITUTION = 0.5;        // base bounce; flipper motion adds more
const FRICTION = 0.04;                  // velocity bleed per second (air/rolling drag)
const MAX_SPEED = 1500;                 // hard velocity cap (anti-tunnelling)
const BALL_RADIUS = 9;

// Flipper geometry / motion.
const FLIPPER_LEN = 78;
const FLIPPER_WIDTH = 9;               // half-thickness used as collision radius
const FLIPPER_REST_ANGLE = 0.50;       // radians below horizontal at rest (tips down)
const FLIPPER_UP_ANGLE = -0.55;        // radians above horizontal when raised
const FLIPPER_SPEED = 18;              // angular speed (rad/s) — snappy
const FLIPPER_TIP_BOOST = 900;         // extra speed imparted by a moving flipper

const LAUNCH_LANE_X = WIDTH - 26;      // centre of the right-hand plunger lane
const LAUNCH_LANE_Y = HEIGHT - 92;     // rest height of the ball on the lane floor

// ---- Small vector helpers --------------------------------------------------
function len(x, y) { return Math.hypot(x, y); }
function clampSpeed(vx, vy) {
  const s = len(vx, vy);
  if (s > MAX_SPEED) { const k = MAX_SPEED / s; return [vx * k, vy * k]; }
  return [vx, vy];
}

// Closest point on segment AB to point P, returned as [cx, cy].
function closestOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const abLen2 = abx * abx + aby * aby;
  if (abLen2 === 0) return [ax, ay];
  let t = ((px - ax) * abx + (py - ay) * aby) / abLen2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  return [ax + abx * t, ay + aby * t, t];
}

// ---- Flipper ---------------------------------------------------------------
// A flipper is a line segment pivoting around (px, py). `side` is -1 (left) or
// +1 (right). When raised, the tip swings up. We track the previous angle so we
// can give the ball a kick proportional to the flipper's angular velocity.
class Flipper {
  constructor(px, py, side) {
    this.px = px;
    this.py = py;
    this.side = side;
    this.restAngle = side === -1 ? FLIPPER_REST_ANGLE : Math.PI - FLIPPER_REST_ANGLE;
    this.upAngle = side === -1 ? FLIPPER_UP_ANGLE : Math.PI - FLIPPER_UP_ANGLE;
    this.angle = this.restAngle;
    this.prevAngle = this.restAngle;
    this.raised = false;
  }

  // Advance the flipper angle toward its target by FLIPPER_SPEED * dt.
  step(dt) {
    this.prevAngle = this.angle;
    const target = this.raised ? this.upAngle : this.restAngle;
    const max = FLIPPER_SPEED * dt;
    const d = target - this.angle;
    if (Math.abs(d) <= max) this.angle = target;
    else this.angle += Math.sign(d) * max;
  }

  // Pivot point and current tip point.
  tip(angle = this.angle) {
    return [this.px + Math.cos(angle) * FLIPPER_LEN, this.py + Math.sin(angle) * FLIPPER_LEN];
  }
}

// ---- World -----------------------------------------------------------------
export class World {
  constructor() {
    this.segments = [];   // {ax,ay,bx,by,restitution,kind}
    this.bumpers = [];    // {x,y,r,restitution,score,flash}
    this.flippers = [];
    this._buildTable();
    this.reset();
  }

  // Build the static geometry. The table is a funnel: vertical side walls,
  // angled lower walls that channel a missed ball into a central drain gap
  // between the two flippers, plus a divider creating the right launch lane.
  _buildTable() {
    const W = WIDTH, H = HEIGHT;
    const wall = (ax, ay, bx, by, kind = "wall") =>
      this.segments.push({ ax, ay, bx, by, restitution: WALL_RESTITUTION, kind });

    const laneX = W - 44;                    // left edge of the plunger lane
    this.laneX = laneX;

    // ---- Outer frame -------------------------------------------------------
    wall(8, 70, 8, H - 150);                 // left wall
    wall(W - 8, 12, W - 8, H - 40);          // right wall (also the lane's right side)

    // Ceiling: a curved dome spanning the WHOLE width. Over the lane it slopes
    // DOWN-LEFT so a ball shot up the lane is deflected left, carrying it over
    // the divider and into the play area (and it can't escape the table).
    wall(8, 70, 44, 28);                     // top-left chamfer
    wall(44, 28, 120, 12);
    wall(120, 12, 250, 12);                  // flat top centre
    wall(250, 12, W - 30, 44);               // dome slopes down toward the lane
    wall(W - 30, 44, W - 8, 78);             // short cap into the right wall

    // ---- Launch lane -------------------------------------------------------
    // The divider rises near the ceiling, leaving only a narrow mouth at the top
    // of the lane. The rising ball, deflected left by the dome, clears the mouth
    // into play; a guard lip on the play side slopes DOWN-LEFT so a ball drifting
    // back toward the lane is turned away from the mouth (a practical one-way).
    // The lane is CLOSED at the bottom by the lane floor, so a launched ball
    // never drains straight back down the lane.
    const dividerTop = 96;
    wall(laneX, dividerTop, laneX, H - 96);  // divider wall
    wall(laneX, H - 96, W - 8, H - 64);      // lane floor (ball rests here pre-launch)
    // Guard lip: from the divider top, slope up-and-left so a play-side ball is
    // steered away from the lane mouth instead of dropping in.
    wall(laneX, dividerTop, laneX - 40, dividerTop + 26);

    // ---- Lower funnel + flippers -------------------------------------------
    // The flippers are placed symmetrically about the play-field centre. The
    // funnel walls run down INTO the flipper pivots with a clear slope (no flat
    // shelf or acute corner where a slow ball could wedge), so a ball reaching
    // the bottom either lands on a flipper (saveable) or passes through the
    // central gap between the flipper tips (drains). The pivots are the lowest
    // wall points. Inner play field spans x=8..laneX; its centre is `mid`.
    const mid = (8 + laneX) / 2;             // ~182
    const pivotY = H - 96;
    const leftPivotX = mid - 100;            // ~82
    const rightPivotX = mid + 100;           // ~282

    // Funnel walls: side/divider down to a kink, then a steeper run into the
    // pivot. Two segments per side keep every interior angle obtuse so nothing
    // can balance in a corner.
    wall(8, H - 240, 44, H - 150);            // left upper funnel
    wall(44, H - 150, leftPivotX, pivotY);    // left lower funnel -> left pivot
    wall(laneX, H - 240, laneX - 36, H - 150); // right upper funnel
    wall(laneX - 36, H - 150, rightPivotX, pivotY); // right lower funnel -> right pivot

    // Slingshots (lively kickers above each flipper, facing inward).
    this.segments.push({ ax: 36, ay: H - 168, bx: leftPivotX + 10, by: H - 116,
      restitution: SLING_RESTITUTION, kind: "sling" });
    this.segments.push({ ax: laneX - 28, ay: H - 168, bx: rightPivotX - 10, by: H - 116,
      restitution: SLING_RESTITUTION, kind: "sling" });

    // Bumpers (round, scoring). Positioned in the upper-mid play area.
    const B = (x, y, r, score) =>
      this.bumpers.push({ x, y, r, restitution: BUMPER_RESTITUTION, score, flash: 0 });
    B(112, 196, 26, 100);
    B(214, 150, 28, 100);
    B(166, 262, 24, 100);
    B(280, 224, 22, 100);

    // Flippers — tips angle down toward the central drain so a well-timed flip
    // flings the ball back up the table.
    this.flippers.push(new Flipper(leftPivotX, pivotY, -1));
    this.flippers.push(new Flipper(rightPivotX, pivotY, +1));

    // Drain line: when the ball centre passes below this y it is lost.
    this.drainY = H - 6;
  }

  reset() {
    this.ball = { x: LAUNCH_LANE_X, y: LAUNCH_LANE_Y, vx: 0, vy: 0, live: false };
    this.score = 0;
    this.drained = false;
    this._laneDwell = 0;
  }

  // Place a fresh ball in the launch lane, at rest, ready for the plunger.
  serve() {
    this.ball.x = LAUNCH_LANE_X;
    this.ball.y = LAUNCH_LANE_Y;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.live = false;
    this.drained = false;
  }

  // Fire the plunger. power in [0,1]; launches the resting ball straight up the
  // lane. The dome at the top deflects it left into the play area.
  launch(power = 1) {
    if (this.ball.live) return;
    const p = Math.max(0.25, Math.min(1, power));
    this.ball.vy = -(680 + 720 * p);     // upward kick
    this.ball.vx = 0;
    this.ball.live = true;
  }

  setFlipper(side, raised) {
    for (const f of this.flippers) if (f.side === side) f.raised = raised;
  }

  // ---- Fixed-step integration --------------------------------------------
  // Returns an array of collision events that happened this step, e.g.
  // {type:"bumper", score}, {type:"sling"}, {type:"wall"}, {type:"flipper"},
  // {type:"drain"}. The app turns these into sound + score-milestone effects.
  step(dt) {
    const events = [];
    for (const f of this.flippers) f.step(dt);

    // Decay bumper flash timers (purely visual; render reads them).
    for (const b of this.bumpers) if (b.flash > 0) b.flash = Math.max(0, b.flash - dt);

    const ball = this.ball;
    if (!ball.live) return events;

    // Gravity + drag.
    ball.vy += GRAVITY * dt;
    const drag = Math.max(0, 1 - FRICTION * dt);
    ball.vx *= drag;
    ball.vy *= drag;
    [ball.vx, ball.vy] = clampSpeed(ball.vx, ball.vy);

    // Integrate position.
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Resolve collisions (a few iterations so stacked contacts settle).
    for (let i = 0; i < 4; i++) {
      let hit = false;
      for (const seg of this.segments) {
        const ev = this._collideSegment(ball, seg.ax, seg.ay, seg.bx, seg.by, seg.restitution);
        if (ev) { events.push({ type: seg.kind }); hit = true; }
      }
      for (const f of this.flippers) {
        const [tx, ty] = f.tip();
        const ev = this._collideSegment(ball, f.px, f.py, tx, ty, FLIPPER_RESTITUTION, f);
        if (ev) { events.push({ type: "flipper" }); hit = true; }
      }
      for (const b of this.bumpers) {
        if (this._collideCircle(ball, b)) {
          b.flash = 0.12;
          this.score += b.score;
          events.push({ type: "bumper", score: b.score });
          hit = true;
        }
      }
      if (!hit) break;
    }

    // Hard table-bound clamps as a safety net: if the ball ever slips through a
    // wall vertex at speed, snap it back inside and reflect. Belt-and-braces on
    // top of the per-substep segment tests (MAX_SPEED * FIXED_DT < BALL_RADIUS,
    // so a ball can't tunnel a wall mid-segment) so it can never leave the table.
    if (ball.x < 8 + BALL_RADIUS) { ball.x = 8 + BALL_RADIUS; if (ball.vx < 0) ball.vx = -ball.vx * WALL_RESTITUTION; }
    if (ball.x > WIDTH - 8 - BALL_RADIUS) { ball.x = WIDTH - 8 - BALL_RADIUS; if (ball.vx > 0) ball.vx = -ball.vx * WALL_RESTITUTION; }
    if (ball.y < 8 + BALL_RADIUS) { ball.y = 8 + BALL_RADIUS; if (ball.vy < 0) ball.vy = -ball.vy * WALL_RESTITUTION; }

    // Safety valve: if a LIVE ball drifts into the launch lane and dwells there
    // nearly stopped (it can't be flipped out), auto-plunge it back into play so
    // the game never deadlocks. Deterministic — keyed off dt, not wall-clock.
    const inLane = ball.x > this.laneX + BALL_RADIUS;
    const slow = ball.vx * ball.vx + ball.vy * ball.vy < 900; // |v| < 30
    if (inLane && slow) {
      this._laneDwell += dt;
      if (this._laneDwell > 0.8) {
        this._laneDwell = 0;
        ball.vy = -1100;   // re-plunge up the lane (ball is already live)
        ball.vx = 0;
      }
    } else {
      this._laneDwell = 0;
    }

    // Drain detection: ball falls past the flippers, off the bottom.
    if (ball.y - BALL_RADIUS > this.drainY) {
      ball.live = false;
      this.drained = true;
      events.push({ type: "drain" });
    }

    [ball.vx, ball.vy] = clampSpeed(ball.vx, ball.vy);
    return events;
  }

  // Resolve ball vs a line segment. Reflects velocity about the contact normal
  // and pushes the ball out of penetration. If `flipper` is supplied and moving,
  // add a kick along the normal proportional to the flipper's tip speed.
  // Returns true on contact.
  _collideSegment(ball, ax, ay, bx, by, restitution, flipper = null) {
    const r = BALL_RADIUS + (flipper ? FLIPPER_WIDTH : 0);
    const [cx, cy] = closestOnSegment(ball.x, ball.y, ax, ay, bx, by);
    let nx = ball.x - cx, ny = ball.y - cy;
    let dist = len(nx, ny);
    if (dist >= r) return false;

    if (dist < 1e-6) {
      // Degenerate (centre on the line): push along the segment's normal.
      const sx = bx - ax, sy = by - ay;
      nx = -sy; ny = sx; dist = len(nx, ny) || 1;
    }
    nx /= dist; ny /= dist;

    // Push out of penetration.
    const pen = r - dist;
    ball.x += nx * pen;
    ball.y += ny * pen;

    // Relative normal velocity. For a moving flipper, subtract the surface
    // velocity at the contact point so a rising flipper bats the ball away.
    let surfVN = 0;
    if (flipper) {
      const omega = (flipper.angle - flipper.prevAngle) / FIXED_DT; // rad/s
      // Contact point velocity = omega x r (perpendicular to pivot→contact).
      const rxp = cx - flipper.px, ryp = cy - flipper.py;
      const svx = -omega * ryp, svy = omega * rxp;
      surfVN = svx * nx + svy * ny;
    }
    const vn = ball.vx * nx + ball.vy * ny;
    let impulsed = false;
    if (vn - surfVN < 0) {
      const j = -(1 + restitution) * (vn - surfVN);
      ball.vx += j * nx;
      ball.vy += j * ny;
      // Extra punch when a raised, fast-moving flipper makes contact, so a
      // well-timed flip can fling the ball back up the table (a real "save").
      if (flipper && flipper.raised) {
        const omega = (flipper.angle - flipper.prevAngle) / FIXED_DT;
        const boost = Math.min(1, Math.abs(omega) / FLIPPER_SPEED) * FLIPPER_TIP_BOOST;
        ball.vx += nx * boost;
        ball.vy += ny * boost;
      }
      impulsed = true;
    }
    [ball.vx, ball.vy] = clampSpeed(ball.vx, ball.vy);
    // Report contact only when a kick was applied (ball approaching), so a ball
    // resting/sliding along a wall doesn't spam collision events every iteration.
    return impulsed;
  }

  // Resolve ball vs a round bumper. Pushes the ball out along the contact
  // normal and reflects velocity (with restitution) so it kicks away. Returns
  // true only when it actually applied a kick (ball approaching) — so the caller
  // scores ONCE per hit and not again on the settle-out resolution iterations.
  _collideCircle(ball, b) {
    let nx = ball.x - b.x, ny = ball.y - b.y;
    const dist = len(nx, ny);
    const minDist = BALL_RADIUS + b.r;
    if (dist >= minDist) return false;
    if (dist < 1e-6) { nx = 0; ny = -1; }
    else { nx /= dist; ny /= dist; }
    // Push out.
    ball.x = b.x + nx * minDist;
    ball.y = b.y + ny * minDist;
    const vn = ball.vx * nx + ball.vy * ny;
    if (vn < 0) {
      const j = -(1 + b.restitution) * vn;
      ball.vx += j * nx;
      ball.vy += j * ny;
      [ball.vx, ball.vy] = clampSpeed(ball.vx, ball.vy);
      return true;   // a real hit: caller scores + flashes
    }
    return false;    // overlapping but separating — just a push-out, no score
  }
}

// Expose a few constants for the renderer.
export const BALL_R = BALL_RADIUS;
export const FLIP_W = FLIPPER_WIDTH;
