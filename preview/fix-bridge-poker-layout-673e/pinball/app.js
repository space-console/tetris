// Space Pinball for the Space Console — entry point.
// Owns the canvas render + input; the World (engine.js) owns all physics.
//
// States: idle → playing → over.
//   idle    — start overlay, empty table behind it.
//   playing — a ball is served to the plunger or in flight; flippers active.
//   over     — all balls drained; game-over overlay, Enter restarts.
//
// Flippers are HELD controls (press = raise, release = lower), which the shared
// discrete-intent layer can't express. So — exactly as other games handle extra
// keys (e.g. Tetris's M-to-mute meta listener) — flippers use DIRECT keyboard
// keydown/keyup and pointer-down/up listeners. The shared Input still runs (so
// the touch class + gestures exist) and supplies the discrete intents:
// enter = launch / start / restart, back = hub.

import { World, WIDTH, HEIGHT, FIXED_DT, BALL_R, FLIP_W } from "./engine.js?v=3ac189ae-caeb-4eff-8794-e95b96dae173";
import { Input } from "../assets/js/shared/input.js?v=3ac189ae-caeb-4eff-8794-e95b96dae173";
import { Sound } from "../assets/js/shared/sound.js?v=3ac189ae-caeb-4eff-8794-e95b96dae173";

const world = new World();
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  score: document.getElementById("score"),
  balls: document.getElementById("balls"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  touchControls: document.getElementById("touchControls"),
};

const START_BALLS = 3;

// idle | playing | over
let state = "idle";
let balls = START_BALLS;
let lastTime = 0;
let acc = 0;                  // fixed-step accumulator (seconds)
let nextMilestone = 1000;     // score threshold for the next "milestone" chime
let serveDelay = 0;           // pause (ms) after a drain before re-serving
const MAX_FRAME = 0.05;       // clamp huge dt (tab refocus) to avoid spiral-of-death

// ---- Game-state transitions ------------------------------------------------
function startGame() {
  sound.resume();   // first gesture unlocks audio (autoplay policy)
  sound.start();
  world.reset();
  world.serve();
  balls = START_BALLS;
  nextMilestone = 1000;
  serveDelay = 0;
  state = "playing";
  lastTime = performance.now();
  acc = 0;
  hideOverlay();
  setStatus("Launch the ball");
}

function launch() {
  if (state !== "playing") return;
  if (world.ball.live || serveDelay > 0) return;
  world.launch(1);
  sound.drop();
  setStatus("");
}

function loseBall() {
  balls -= 1;
  sound.move();
  if (balls <= 0) {
    gameOver();
  } else {
    serveDelay = 700;       // brief beat before the next ball appears
    setStatus(balls + (balls === 1 ? " ball left" : " balls left"));
  }
}

function gameOver() {
  state = "over";
  sound.gameOver();
  showOverlay("Game Over", `Score ${world.score} · Tap to play again`);
  setStatus("Game over");
}

// ---- Discrete intents (start / launch / hub) -------------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter") {
    if (state === "idle" || state === "over") startGame();
    else if (state === "playing") launch();
  }
});

// ---- Flippers: direct held controls (meta, outside the intent layer) -------
const keyState = { left: false, right: false };

function raiseFlipper(side) {
  // side: -1 left, +1 right.
  sound.resume();
  const key = side === -1 ? "left" : "right";
  if (keyState[key]) return;     // ignore key auto-repeat
  keyState[key] = true;
  world.setFlipper(side, true);
  sound.rotate();
  // A flip can also serve as the launch when the ball is waiting (convenience).
}
function lowerFlipper(side) {
  const key = side === -1 ? "left" : "right";
  keyState[key] = false;
  world.setFlipper(side, false);
}

// Keyboard: Left / Z / LeftShift → left flipper; Right / "/" / RightShift → right.
// e.location 1 = left modifier, 2 = right modifier (lets the Shift keys work).
function flipperSideForKey(e) {
  if (e.key === "ArrowLeft" || e.key === "z" || e.key === "Z") return -1;
  if (e.key === "ArrowRight" || e.key === "/") return 1;
  if (e.key === "Shift") return e.location === 2 ? 1 : -1;
  return 0;
}
window.addEventListener("keydown", (e) => {
  if (e.key === "m" || e.key === "M") { toggleMute(); return; }
  if (e.repeat) return;
  const side = flipperSideForKey(e);
  if (side !== 0) raiseFlipper(side);
});
window.addEventListener("keyup", (e) => {
  const side = flipperSideForKey(e);
  if (side !== 0) lowerFlipper(side);
});

// ---- Fixed-step simulation loop --------------------------------------------
function processEvents(events) {
  for (const ev of events) {
    if (ev.type === "bumper") sound.lock();
    else if (ev.type === "sling") sound.lock();
    else if (ev.type === "drain") loseBall();
  }
  // Score milestone chime (don't spam: one per threshold crossed).
  while (world.score >= nextMilestone) {
    sound.clear(1);
    nextMilestone += 1000;
  }
}

function loop(now) {
  if (state === "playing") {
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;

    // Re-serve countdown after a drain (ball not yet back in the lane).
    if (serveDelay > 0) {
      serveDelay -= dt * 1000;
      if (serveDelay <= 0) {
        serveDelay = 0;
        world.serve();
        setStatus("Launch the ball");
      }
    }

    acc += dt;
    while (acc >= FIXED_DT) {
      const events = world.step(FIXED_DT);
      acc -= FIXED_DT;
      if (events.length) processEvents(events);
      if (state !== "playing") break;   // drain may have ended the game
    }
  } else {
    lastTime = now;
  }
  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering -------------------------------------------------------------
// The canvas is fixed at WIDTH×HEIGHT table units, so we render in table units
// directly (CSS scales the canvas to fit the .board). 1 unit = 1 px on canvas.
const trail = []; // recent ball positions, for a motion trail while live

function draw() {
  els.score.textContent = world.score;
  els.balls.textContent = Math.max(0, balls);

  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  drawBackground();
  drawLaneArrows();
  drawWalls();
  drawSlings();
  drawBumpers();
  drawFlippers();

  const waiting = state === "playing" && !world.ball.live && serveDelay <= 0;
  if (waiting) drawPlunger();

  // Track + render the ball's fading motion trail.
  if (world.ball.live) {
    trail.push({ x: world.ball.x, y: world.ball.y });
    if (trail.length > 10) trail.shift();
  } else {
    trail.length = 0;
  }
  drawTrail();

  if (world.ball.live || waiting) drawBall();
}

function drawBackground() {
  // Deep-space gradient table bed.
  const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  g.addColorStop(0, "#0b1234");
  g.addColorStop(0.5, "#0a0c22");
  g.addColorStop(1, "#05060f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // A soft pool of table light in the upper play area.
  const rg = ctx.createRadialGradient(WIDTH / 2, HEIGHT * 0.32, 20, WIDTH / 2, HEIGHT * 0.32, 330);
  rg.addColorStop(0, "rgba(86,116,255,0.13)");
  rg.addColorStop(1, "rgba(86,116,255,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Sparse deterministic starfield (no shimmer).
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  for (let i = 0; i < 60; i++) {
    const x = (i * 97 + 23) % WIDTH;
    const y = (i * 173 + 41) % HEIGHT;
    const s = (i % 3) === 0 ? 1.4 : 0.8;
    ctx.globalAlpha = 0.12 + ((i * 37) % 50) / 140;
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
}

// Decorative rollover-lane chevrons near the top, like a real table's feed lane.
function drawLaneArrows() {
  ctx.save();
  ctx.strokeStyle = "rgba(110,224,255,0.45)";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < 3; i++) {
    const y = 76 + i * 10;
    ctx.beginPath();
    ctx.moveTo(WIDTH / 2 - 13, y + 8);
    ctx.lineTo(WIDTH / 2, y);
    ctx.lineTo(WIDTH / 2 + 13, y + 8);
    ctx.stroke();
  }
  ctx.restore();
}

// Walls drawn as raised metal rails: a dark thick body with a bright inner edge.
function drawWalls() {
  const walls = world.segments.filter((s) => s.kind !== "sling");
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.strokeStyle = "#0e1640";
  ctx.lineWidth = 8;
  ctx.beginPath();
  for (const s of walls) { ctx.moveTo(s.ax, s.ay); ctx.lineTo(s.bx, s.by); }
  ctx.stroke();

  ctx.strokeStyle = "#6ea8ff";
  ctx.lineWidth = 3;
  ctx.shadowColor = "rgba(91,140,255,0.7)";
  ctx.shadowBlur = 7;
  ctx.beginPath();
  for (const s of walls) { ctx.moveTo(s.ax, s.ay); ctx.lineTo(s.bx, s.by); }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// Slingshots: filled triangular rubber kickers that flash bright on contact.
function drawSlings() {
  for (const s of world.segments) {
    if (s.kind !== "sling") continue;
    const mx = (s.ax + s.bx) / 2, my = (s.ay + s.by) / 2;
    const dx = s.bx - s.ax, dy = s.by - s.ay;
    let nx = -dy, ny = dx;
    const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    // Point the apex away from the playfield centre (outward toward the wall).
    if ((mx - WIDTH / 2) * nx < 0) { nx = -nx; ny = -ny; }
    const apexX = mx + nx * 30, apexY = my + ny * 30;
    const lit = s.flash > 0;

    ctx.beginPath();
    ctx.moveTo(s.ax, s.ay);
    ctx.lineTo(s.bx, s.by);
    ctx.lineTo(apexX, apexY);
    ctx.closePath();
    ctx.fillStyle = lit ? "rgba(255,180,80,0.95)" : "rgba(58,30,92,0.95)";
    ctx.shadowColor = lit ? "#ffb347" : "transparent";
    ctx.shadowBlur = lit ? 18 : 0;
    ctx.fill();
    ctx.shadowBlur = 0;

    // The play-facing rubber edge (the kicker).
    ctx.beginPath();
    ctx.moveTo(s.ax, s.ay);
    ctx.lineTo(s.bx, s.by);
    ctx.strokeStyle = lit ? "#fff2c0" : "#ff6ad5";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.shadowColor = "#ff6ad5";
    ctx.shadowBlur = lit ? 16 : 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }
}

// Pop bumpers: dark skirt, glowing domed cap, white ring + centre.
function drawBumpers() {
  for (const b of world.bumpers) {
    const lit = b.flash > 0;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = lit ? "#3a2a10" : "#241640";
    ctx.fill();

    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.8, 0, Math.PI * 2);
    const cap = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.3, 2, b.x, b.y, b.r * 0.8);
    if (lit) { cap.addColorStop(0, "#fff3b0"); cap.addColorStop(1, "#ffb020"); }
    else { cap.addColorStop(0, "#b48cff"); cap.addColorStop(1, "#6a2fe0"); }
    ctx.fillStyle = cap;
    ctx.shadowColor = lit ? "#ffd34d" : "#7b3ff2";
    ctx.shadowBlur = lit ? 26 : 12;
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.5, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
  }
}

// Flippers: glossy red bats with a metal pivot stud.
function drawFlippers() {
  for (const f of world.flippers) {
    const [tx, ty] = f.tip();
    ctx.lineCap = "round";

    // Dark body underlay.
    ctx.strokeStyle = "#7a0f25";
    ctx.lineWidth = FLIP_W * 2 + 2;
    ctx.beginPath(); ctx.moveTo(f.px, f.py); ctx.lineTo(tx, ty); ctx.stroke();

    // Bright body.
    const grd = ctx.createLinearGradient(f.px, f.py, tx, ty);
    grd.addColorStop(0, "#ff5a6e");
    grd.addColorStop(1, "#e01f3d");
    ctx.strokeStyle = grd;
    ctx.lineWidth = FLIP_W * 2 - 2;
    ctx.shadowColor = "rgba(255,60,90,0.6)";
    ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(f.px, f.py); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.shadowBlur = 0;

    // Gloss highlight along the inner half.
    ctx.strokeStyle = "rgba(255,255,255,0.5)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.lineTo(f.px + (tx - f.px) * 0.55, f.py + (ty - f.py) * 0.55);
    ctx.stroke();

    // Pivot stud.
    ctx.beginPath();
    ctx.arc(f.px, f.py, FLIP_W * 1.05, 0, Math.PI * 2);
    const sg = ctx.createRadialGradient(f.px - 2, f.py - 2, 1, f.px, f.py, FLIP_W * 1.05);
    sg.addColorStop(0, "#dfe6ff");
    sg.addColorStop(1, "#5566aa");
    ctx.fillStyle = sg;
    ctx.fill();
    ctx.strokeStyle = "#1a2348";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

// A spring plunger in the launch lane, shown while a ball waits to be fired.
function drawPlunger() {
  const b = world.ball;
  const x = b.x;
  const topY = b.y + BALL_R + 3;
  const botY = HEIGHT - 44;

  // Spring coils.
  ctx.strokeStyle = "#8aa0d8";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, topY);
  const coils = 5;
  for (let i = 1; i <= coils; i++) {
    const yy = topY + (botY - topY) * (i / coils);
    const xx = x + (i % 2 === 0 ? -7 : 7);
    ctx.lineTo(xx, yy);
  }
  ctx.lineTo(x, botY);
  ctx.stroke();

  // Shaft + knob.
  ctx.strokeStyle = "#c9d4f5";
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(x, botY); ctx.lineTo(x, botY + 8); ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, botY + 12, 6, 0, Math.PI * 2);
  ctx.fillStyle = "#ffd34d";
  ctx.fill();
}

function drawTrail() {
  for (let i = 0; i < trail.length; i++) {
    const p = trail[i];
    const t = (i + 1) / trail.length;
    ctx.beginPath();
    ctx.arc(p.x, p.y, BALL_R * (0.3 + 0.5 * t), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(150,180,255,${0.04 + 0.1 * t})`;
    ctx.fill();
  }
}

// Chrome ball with a specular highlight.
function drawBall() {
  const b = world.ball;
  const g = ctx.createRadialGradient(b.x - 3, b.y - 4, 1, b.x, b.y, BALL_R);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.45, "#cdd6ee");
  g.addColorStop(1, "#7e8ab0");
  ctx.beginPath();
  ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.shadowColor = "rgba(180,200,255,0.7)";
  ctx.shadowBlur = 10;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.beginPath();
  ctx.arc(b.x - 3, b.y - 4, BALL_R * 0.28, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fill();
}

// ---- Overlay helpers -------------------------------------------------------
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() {
  els.overlay.classList.add("overlay--hidden");
}
function setStatus(text) {
  els.status.textContent = text;
}

// ---- Mute control (meta, outside the gameplay intent layer) ----------------
function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() {
  sound.toggleMute();
  renderMute();
}

// ---- On-screen touch controls (flippers + launch) --------------------------
// Built by hand (not via makeButton) because flippers need pointerup/leave to
// LOWER the flipper — hold semantics the shared helper doesn't expose. Each is
// marked [data-touch-ignore] so the global gesture layer leaves it alone.
function buildTouchControls() {
  const make = (label, ariaLabel, onDown, onUp, cls) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = ("tbtn " + (cls || "")).trim();
    b.textContent = label;
    b.setAttribute("data-touch-ignore", "");
    b.setAttribute("aria-label", ariaLabel);
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); onDown(); });
    if (onUp) {
      b.addEventListener("pointerup", (e) => { e.preventDefault(); onUp(); });
      b.addEventListener("pointerleave", () => onUp());
      b.addEventListener("pointercancel", () => onUp());
    }
    return b;
  };

  els.touchControls.appendChild(
    make("◀", "Left flipper", () => raiseFlipper(-1), () => lowerFlipper(-1), "flip"));
  els.touchControls.appendChild(
    make("LAUNCH", "Launch / start", () => {
      if (state === "idle" || state === "over") startGame();
      else launch();
    }, null, "launch"));
  els.touchControls.appendChild(
    make("▶", "Right flipper", () => raiseFlipper(1), () => lowerFlipper(1), "flip"));
}

// ---- Boot ------------------------------------------------------------------
function boot() {
  input.start();          // adds <html>.touch + gesture layer; supplies intents
  buildTouchControls();
  els.mute.addEventListener("click", toggleMute);
  renderMute();
  draw();                 // render the empty table behind the start overlay
  showOverlay("Space Pinball", "Tap or press <kbd>Enter</kbd> to launch");
  requestAnimationFrame(loop);
}

boot();
