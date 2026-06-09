// Fruit Ninja for Space Console — entry point.
// Owns canvas rendering and pointer input; the engine owns all game logic. A
// fixed-timestep accumulator advances the deterministic engine, then we draw
// the fruits, the blade trail, juice particles and the HUD. The player slices
// by dragging (pointerdown → move → up, or touch): each frame the segment from
// the previous pointer position to the current one is fed to the engine.
//
// This file is input + render only — match the tetris/app.js conventions.

import { Engine, makeRng, WIDTH, HEIGHT, FRUIT_COLORS } from "./engine.js";
import { Input } from "../assets/js/shared/input.js";
import { Sound } from "../assets/js/shared/sound.js";

const engine = new Engine(makeRng(Date.now() >>> 0));
const input = new Input();
const sound = new Sound();

const boardCanvas = document.getElementById("board");
const ctx = boardCanvas.getContext("2d");

// Virtual→canvas scale. The engine works in a WIDTH×HEIGHT virtual field; the
// canvas is sized to the same aspect (2:3), so a single uniform scale maps both
// axes. Recomputed on resize.
let scaleX = boardCanvas.width / WIDTH;
let scaleY = boardCanvas.height / HEIGHT;

const els = {
  status: document.getElementById("status"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

const BEST_KEY = "fruitninja.best";
let best = Number(localStorage.getItem(BEST_KEY) || 0);

// idle | playing | over
let state = "idle";
let lastTime = 0;
let acc = 0;               // ms accumulated toward the fixed simulation step
const STEP_MS = 1000 / 120; // fixed 120Hz physics for stable arcs & slicing

// ---- Blade -----------------------------------------------------------------
// The trail is a short list of recent pointer points (in VIRTUAL coords). Each
// frame, while dragging, the newest segment is tested against the fruits.
let blade = [];           // [{x,y,t}] virtual-space points, newest last
let dragging = false;
const TRAIL_MS = 90;      // how long a trail point lingers (visual + slicing)

// ---- Engine events ---------------------------------------------------------
engine.on((type, detail) => {
  if (type === "slice") {
    // 3+ in one swipe is a flashy combo → a brighter cue.
    if (detail.count >= 3) sound.levelUp();
    else sound.clear(1);
  } else if (type === "bomb") {
    sound.gameOver();
  } else if (type === "miss") {
    sound.drop();
  } else if (type === "gameover") {
    gameOver();
  }
});

// ---- Game-state transitions ------------------------------------------------
function startGame() {
  sound.resume();   // first gesture unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  state = "playing";
  acc = 0;
  blade = [];
  dragging = false;
  lastTime = performance.now();
  hideOverlay();
  setStatus("Slice!");
  draw();
}

function gameOver() {
  state = "over";
  if (engine.score > best) {
    best = engine.score;
    localStorage.setItem(BEST_KEY, String(best));
  }
  showOverlay("Game Over", `Score ${engine.score} · Best ${best} · Tap to play again`);
  setStatus("Game over");
}

// ---- Intent handling (keyboard / remote: start, restart, back) -------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter") {
    if (state === "idle" || state === "over") startGame();
  }
});

// ---- Pointer (blade) handling ----------------------------------------------
// Pointer Events cover mouse, touch and pen with one path. We convert client
// coordinates to the canvas's internal pixel space, then to virtual units.
function toVirtual(clientX, clientY) {
  const rect = boardCanvas.getBoundingClientRect();
  const cx = ((clientX - rect.left) / rect.width) * boardCanvas.width;
  const cy = ((clientY - rect.top) / rect.height) * boardCanvas.height;
  return { x: cx / scaleX, y: cy / scaleY };
}

function pointerDown(e) {
  if (state !== "playing") return;
  dragging = true;
  blade = [{ ...toVirtual(e.clientX, e.clientY), t: performance.now() }];
  e.preventDefault();
}

function pointerMove(e) {
  if (!dragging || state !== "playing") return;
  const now = performance.now();
  const p = toVirtual(e.clientX, e.clientY);
  const prev = blade[blade.length - 1];
  if (prev) {
    // Feed the freshest segment to the engine for the slice test.
    engine.sliceSegment(prev.x, prev.y, p.x, p.y);
  }
  blade.push({ ...p, t: now });
  e.preventDefault();
}

function pointerUp() {
  dragging = false;
}

boardCanvas.addEventListener("pointerdown", pointerDown);
boardCanvas.addEventListener("pointermove", pointerMove);
window.addEventListener("pointerup", pointerUp);
boardCanvas.addEventListener("pointercancel", pointerUp);
boardCanvas.addEventListener("pointerleave", () => { /* keep drag across edge */ });

// ---- Loop (fixed-timestep accumulator) -------------------------------------
function loop(now) {
  if (state === "playing") {
    let dt = now - lastTime;
    lastTime = now;
    if (dt > 250) dt = 250; // clamp tab-switch hitches
    acc += dt;
    while (acc >= STEP_MS) {
      engine.step(STEP_MS / 1000);
      acc -= STEP_MS;
      if (state !== "playing") break; // a sliced bomb / 3rd miss may end it
    }
    // Expire stale blade points so the trail is short.
    const cutoff = now - TRAIL_MS;
    blade = blade.filter((p) => p.t >= cutoff);
  } else {
    lastTime = now;
  }
  draw(now);
  requestAnimationFrame(loop);
}

// ---- Rendering -------------------------------------------------------------
function draw() {
  ctx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);

  drawParticles();
  drawEntities();
  drawBlade();
  drawHud();
}

function vx(x) { return x * scaleX; }
function vy(y) { return y * scaleY; }
function vr(r) { return r * scaleX; }

function drawEntities() {
  for (const e of engine.entities) {
    const cx = vx(e.x);
    const cy = vy(e.y);
    const r = vr(e.r);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(e.angle);
    if (e.type === "bomb") {
      drawBomb(r);
    } else if (e.half) {
      drawFruitHalves(e, r);
    } else {
      drawFruit(e, r);
    }
    ctx.restore();
  }
}

function drawFruit(e, r) {
  const color = FRUIT_COLORS[e.kind] || "#e23b46";
  // Body.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  // Rind highlight.
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.3, r * 0.5, 0, Math.PI * 2);
  ctx.fill();
  // Rind ring.
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = Math.max(1, r * 0.08);
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.96, 0, Math.PI * 2);
  ctx.stroke();
  // Drawn leaf at the top.
  ctx.fillStyle = "#3fae4a";
  ctx.beginPath();
  ctx.ellipse(r * 0.15, -r * 1.05, r * 0.4, r * 0.22, -0.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawFruitHalves(e, r) {
  const color = FRUIT_COLORS[e.kind] || "#e23b46";
  // Two half-circles drifting apart along the slice axis (use spin sign).
  const gap = r * 0.5;
  for (const side of [-1, 1]) {
    ctx.save();
    ctx.translate(side * gap, 0);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(0, 0, r, side > 0 ? -Math.PI / 2 : Math.PI / 2, side > 0 ? Math.PI / 2 : (3 * Math.PI) / 2);
    ctx.closePath();
    ctx.fill();
    // Pale flesh on the cut face.
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillRect(-1, -r, 2, r * 2);
    ctx.restore();
  }
}

function drawBomb(r) {
  // Dark sphere.
  ctx.fillStyle = "#222232";
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.beginPath();
  ctx.arc(-r * 0.3, -r * 0.3, r * 0.4, 0, Math.PI * 2);
  ctx.fill();
  // Fuse.
  ctx.strokeStyle = "#9a7b4f";
  ctx.lineWidth = Math.max(1, r * 0.14);
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.quadraticCurveTo(r * 0.5, -r * 1.4, r * 0.7, -r * 1.1);
  ctx.stroke();
  // Spark.
  ctx.fillStyle = "#ffce4a";
  ctx.beginPath();
  ctx.arc(r * 0.7, -r * 1.1, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

function drawParticles() {
  for (const p of engine.particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(vx(p.x), vy(p.y), vr(p.bomb ? 0.9 : 1.2), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawBlade() {
  if (blade.length < 2) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // Glow underlay then bright core, tapering newest→widest.
  for (let pass = 0; pass < 2; pass++) {
    ctx.beginPath();
    ctx.moveTo(vx(blade[0].x), vy(blade[0].y));
    for (let i = 1; i < blade.length; i++) {
      ctx.lineTo(vx(blade[i].x), vy(blade[i].y));
    }
    ctx.strokeStyle = pass === 0 ? "rgba(120,200,255,0.35)" : "rgba(255,255,255,0.95)";
    ctx.lineWidth = pass === 0 ? 10 : 4;
    ctx.stroke();
  }
}

function drawHud() {
  ctx.font = `700 ${Math.round(boardCanvas.width * 0.05)}px system-ui, sans-serif`;
  ctx.textBaseline = "top";
  // Score (left).
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.fillText(String(engine.score), 14, 12);
  ctx.font = `600 ${Math.round(boardCanvas.width * 0.03)}px system-ui, sans-serif`;
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(`BEST ${Math.max(best, engine.score)}`, 14, 12 + boardCanvas.width * 0.055);

  // Lives (right) — draw remaining as filled crosses, lost as faint.
  const total = 3;
  const s = boardCanvas.width * 0.035;
  for (let i = 0; i < total; i++) {
    const cx = boardCanvas.width - 18 - i * (s + 8);
    const cy = 18 + s / 2;
    ctx.strokeStyle = i < engine.lives ? "#ff5a5a" : "rgba(255,255,255,0.18)";
    ctx.lineWidth = Math.max(2, s * 0.18);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - s / 2, cy - s / 2);
    ctx.lineTo(cx + s / 2, cy + s / 2);
    ctx.moveTo(cx + s / 2, cy - s / 2);
    ctx.lineTo(cx - s / 2, cy + s / 2);
    ctx.stroke();
  }
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

// ---- Canvas sizing ---------------------------------------------------------
// Keep the internal pixel buffer matched to the displayed size (×DPR) so the
// drawing stays crisp and the virtual→canvas scale is exact.
function resize() {
  const rect = boardCanvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  boardCanvas.width = Math.round(rect.width * dpr);
  boardCanvas.height = Math.round(rect.height * dpr);
  scaleX = boardCanvas.width / WIDTH;
  scaleY = boardCanvas.height / HEIGHT;
  draw();
}

// ---- Boot ------------------------------------------------------------------
function boot() {
  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });
  window.addEventListener("resize", resize);
  resize();
  showOverlay("Fruit Ninja", "Drag across the screen to slice. Tap or press <kbd>Enter</kbd> to start");
  requestAnimationFrame(loop);
}

boot();
