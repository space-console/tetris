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

import { World, WIDTH, HEIGHT, FIXED_DT, BALL_R, FLIP_W } from "./engine.js?v=5abd3d81-c3ba-4254-baa2-b9a34a23722d";
import { Input } from "../assets/js/shared/input.js?v=5abd3d81-c3ba-4254-baa2-b9a34a23722d";
import { Sound } from "../assets/js/shared/sound.js?v=5abd3d81-c3ba-4254-baa2-b9a34a23722d";

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
function draw() {
  els.score.textContent = world.score;
  els.balls.textContent = Math.max(0, balls);

  ctx.clearRect(0, 0, WIDTH, HEIGHT);
  drawBackground();
  drawSegments();
  drawBumpers();
  drawFlippers();
  if (world.ball.live || (state === "playing" && serveDelay <= 0)) drawBall();
}

function drawBackground() {
  // Deep-space gradient + a sparse starfield (deterministic so it doesn't shimmer).
  const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  g.addColorStop(0, "#0a0f2a");
  g.addColorStop(1, "#05060f");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  for (let i = 0; i < 60; i++) {
    const x = (i * 97 + 23) % WIDTH;
    const y = (i * 173 + 41) % HEIGHT;
    const s = (i % 3) === 0 ? 1.4 : 0.8;
    ctx.globalAlpha = 0.15 + ((i * 37) % 50) / 120;
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
}

function drawSegments() {
  for (const seg of world.segments) {
    ctx.lineCap = "round";
    if (seg.kind === "sling") {
      ctx.strokeStyle = "#ff6ad5";
      ctx.lineWidth = 6;
      ctx.shadowColor = "#ff6ad5";
      ctx.shadowBlur = 10;
    } else {
      ctx.strokeStyle = "#4f8cff";
      ctx.lineWidth = 4;
      ctx.shadowColor = "rgba(79,140,255,0.6)";
      ctx.shadowBlur = 6;
    }
    ctx.beginPath();
    ctx.moveTo(seg.ax, seg.ay);
    ctx.lineTo(seg.bx, seg.by);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

function drawBumpers() {
  for (const b of world.bumpers) {
    const lit = b.flash > 0;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = lit ? "#ffe066" : "#7b3ff2";
    ctx.shadowColor = lit ? "#ffe066" : "#7b3ff2";
    ctx.shadowBlur = lit ? 24 : 12;
    ctx.fill();
    ctx.shadowBlur = 0;
    // Inner ring.
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r * 0.55, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawFlippers() {
  for (const f of world.flippers) {
    const [tx, ty] = f.tip();
    ctx.lineCap = "round";
    ctx.strokeStyle = "#2ee6e6";
    ctx.lineWidth = FLIP_W * 2;
    ctx.shadowColor = "#2ee6e6";
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(f.px, f.py);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.shadowBlur = 0;
    // Pivot stud.
    ctx.beginPath();
    ctx.arc(f.px, f.py, FLIP_W * 0.9, 0, Math.PI * 2);
    ctx.fillStyle = "#0a0f2a";
    ctx.fill();
    ctx.strokeStyle = "#2ee6e6";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawBall() {
  const b = world.ball;
  const g = ctx.createRadialGradient(b.x - 3, b.y - 3, 1, b.x, b.y, BALL_R);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#9aa6c8");
  ctx.beginPath();
  ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.shadowColor = "rgba(255,255,255,0.6)";
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.shadowBlur = 0;
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
