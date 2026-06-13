// Flappy Bird for Space Console — entry point.
// Wires the shared intent stream to the engine, runs a fixed-dt accumulator
// loop, renders the parallax sky / pipes / ground / bird, and manages the game
// states (idle → playing → over). The engine owns all game logic and physics;
// this file is input + render only.

import {
  Engine,
  WORLD_W, WORLD_H,
  BIRD_X, BIRD_R,
  PIPE_W, FLOOR_Y, GROUND_H,
} from "./engine.js?v=175f583e-3f62-43ec-8059-9980fdac431b";
import { Input } from "../assets/js/shared/input.js?v=175f583e-3f62-43ec-8059-9980fdac431b";
import { Sound } from "../assets/js/shared/sound.js?v=175f583e-3f62-43ec-8059-9980fdac431b";

// Browser play wants variety, so feed the engine Math.random rather than the
// deterministic default seed.
const engine = new Engine(Math.random);
const input = new Input();
const sound = new Sound();

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const els = {
  status: document.getElementById("status"),
  score: document.getElementById("score"),
  best: document.getElementById("best"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// Persisted best score.
const BEST_KEY = "flappy.best";
let best = Number(localStorage.getItem(BEST_KEY) || 0);

// Fixed-timestep accumulator: physics steps at a constant dt regardless of the
// display's frame rate, so collisions and scoring are frame-rate independent.
const STEP = 1 / 120;        // seconds per physics tick
const MAX_FRAME = 0.05;      // clamp huge gaps (tab switch) so we don't tunnel
let lastTime = 0;
let acc = 0;

// Parallax background scroll offsets (purely cosmetic).
let cloudX = 0;
let groundX = 0;

// ---- Game-state transitions ----------------------------------------------
function startGame() {
  sound.resume();   // first gesture unlocks audio (autoplay policy)
  sound.start();
  engine.start();   // resets + applies the first flap
  hideOverlay();
  setStatus("");
  lastTime = performance.now();
  acc = 0;
}

function gameOver() {
  showOverlay("Game Over", `Score ${engine.score} · Best ${best} · Tap to play again`);
  setStatus("Game over");
}

engine.addEventListener("flap", () => sound.move());
engine.addEventListener("score", () => sound.clear(1));
engine.addEventListener("gameover", () => {
  sound.gameOver();
  if (engine.score > best) {
    best = engine.score;
    localStorage.setItem(BEST_KEY, String(best));
  }
  gameOver();
});

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }

  // Any "go" intent flaps. From idle/over it starts a fresh run; mid-run it's
  // an ordinary flap.
  if (intent === "enter" || intent === "up") {
    if (engine.state === "playing") engine.flap();
    else startGame();
  }
});

// A plain click/tap on the board also flaps (covers mouse + non-gesture taps);
// the shared input layer already maps touch taps to "enter".
canvas.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (engine.state === "playing") { sound.resume(); engine.flap(); }
  else startGame();
});

// ---- Loop -----------------------------------------------------------------
function loop(now) {
  if (engine.state === "playing") {
    let frame = (now - lastTime) / 1000;
    lastTime = now;
    if (frame > MAX_FRAME) frame = MAX_FRAME;
    acc += frame;
    while (acc >= STEP) {
      engine.step(STEP);
      acc -= STEP;
      if (engine.state !== "playing") break; // collision ended the run
    }
    // Advance cosmetic parallax with real time.
    cloudX = (cloudX + frame * 14) % WORLD_W;
    groundX = (groundX + frame * 160) % 40;
  } else {
    lastTime = now;
  }
  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
// All drawing happens in WORLD_W × WORLD_H virtual units; a single transform
// scales that to the backing-store pixels (set in resize()).
function draw() {
  els.score.textContent = engine.score;
  els.best.textContent = best;

  ctx.setTransform(scaleX, 0, 0, scaleY, 0, 0);
  drawSky();
  drawClouds();
  drawPipes();
  drawGround();
  drawBird();
}

function drawSky() {
  const g = ctx.createLinearGradient(0, 0, 0, WORLD_H);
  g.addColorStop(0, "#4ec0ff");   // bright top
  g.addColorStop(0.6, "#8fd6ff");
  g.addColorStop(1, "#cdeeff");   // hazy horizon
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
}

// A few soft parallax clouds drifting slowly across the sky.
function drawClouds() {
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const ys = [110, 250, 400];
  for (let i = 0; i < ys.length; i++) {
    const baseX = (i * 150 - cloudX * (1 + i * 0.4));
    const x = ((baseX % (WORLD_W + 120)) + (WORLD_W + 120)) % (WORLD_W + 120) - 60;
    puff(x, ys[i], 34);
  }
}

function puff(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.arc(x + r, y + 6, r * 0.8, 0, Math.PI * 2);
  ctx.arc(x - r, y + 8, r * 0.7, 0, Math.PI * 2);
  ctx.arc(x + r * 0.4, y + r * 0.5, r * 0.9, 0, Math.PI * 2);
  ctx.fill();
}

function drawPipes() {
  for (const p of engine.pipes) {
    const topH = p.gapY;
    const botY = p.gapY + p.gapH;
    const botH = FLOOR_Y - botY;
    drawPipe(p.x, 0, PIPE_W, topH, true);
    drawPipe(p.x, botY, PIPE_W, botH, false);
  }
}

// A classic green pipe with a body, a shaded inner edge, and a lip at the gap.
function drawPipe(x, y, w, h, capBottom) {
  if (h <= 0) return;
  const body = ctx.createLinearGradient(x, 0, x + w, 0);
  body.addColorStop(0, "#3fae3f");
  body.addColorStop(0.18, "#7ed957");
  body.addColorStop(0.5, "#5cc23a");
  body.addColorStop(0.85, "#3f9e30");
  body.addColorStop(1, "#2c7a22");
  ctx.fillStyle = body;
  ctx.fillRect(x, y, w, h);

  // Outline.
  ctx.strokeStyle = "rgba(20,70,15,0.7)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);

  // The flared lip sits at the gap-facing end of each pipe.
  const lipH = 26;
  const lipW = w + 12;
  const lipX = x - 6;
  const lipY = capBottom ? y + h - lipH : y;
  ctx.fillStyle = body;
  ctx.fillRect(lipX, lipY, lipW, lipH);
  ctx.strokeRect(lipX + 1, lipY + 1, lipW - 2, lipH - 2);
}

function drawGround() {
  // Earth strip.
  ctx.fillStyle = "#ded895";
  ctx.fillRect(0, FLOOR_Y, WORLD_W, GROUND_H);
  // A darker grass band along the top edge of the ground.
  ctx.fillStyle = "#73c043";
  ctx.fillRect(0, FLOOR_Y, WORLD_W, 14);
  ctx.fillStyle = "#5aa336";
  ctx.fillRect(0, FLOOR_Y + 14, WORLD_W, 4);
  // Diagonal hatch marks scrolling with the world for a sense of motion.
  ctx.strokeStyle = "rgba(160,140,70,0.5)";
  ctx.lineWidth = 6;
  for (let x = -40; x < WORLD_W + 40; x += 40) {
    const px = x - groundX;
    ctx.beginPath();
    ctx.moveTo(px, FLOOR_Y + 22);
    ctx.lineTo(px + 20, GROUND_H + FLOOR_Y);
    ctx.stroke();
  }
}

// The bird: a round yellow body that tilts with vertical velocity, plus a wing,
// eye, and beak. Drawn at the fixed BIRD_X and the engine's current y.
function drawBird() {
  const { y, vy } = engine.bird;
  // Map velocity to a tilt: nose-up when rising, nose-down when diving.
  const tilt = Math.max(-0.5, Math.min(1.1, vy / 600));

  ctx.save();
  ctx.translate(BIRD_X, y);
  ctx.rotate(tilt);

  // Body.
  const g = ctx.createRadialGradient(-4, -4, 4, 0, 0, BIRD_R + 4);
  g.addColorStop(0, "#ffe45e");
  g.addColorStop(1, "#f5b400");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "rgba(120,80,0,0.6)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Wing (flaps with vertical motion).
  ctx.fillStyle = "#ffd23f";
  ctx.beginPath();
  const wingUp = vy < 0;
  ctx.ellipse(-3, wingUp ? -2 : 5, 9, 6, wingUp ? -0.5 : 0.4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Eye.
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(7, -6, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.arc(9, -6, 2.4, 0, Math.PI * 2);
  ctx.fill();

  // Beak.
  ctx.fillStyle = "#ff8c1a";
  ctx.beginPath();
  ctx.moveTo(BIRD_R - 2, -2);
  ctx.lineTo(BIRD_R + 9, 1);
  ctx.lineTo(BIRD_R - 2, 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

// ---- Canvas sizing (crisp on HiDPI; scales the world box to the element) ---
let scaleX = 1;
let scaleY = 1;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  // Backing store matches the displayed size × DPR for sharp edges.
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  // One transform maps WORLD_W × WORLD_H virtual units onto the backing store.
  scaleX = canvas.width / WORLD_W;
  scaleY = canvas.height / WORLD_H;
  draw();
}

// ---- Overlay helpers ------------------------------------------------------
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

// ---- Mute control (meta, deliberately outside the gameplay intent layer) ---
function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() {
  sound.toggleMute();
  renderMute();
}

// ---- Boot -----------------------------------------------------------------
function boot() {
  input.start();
  els.best.textContent = best;

  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });
  window.addEventListener("resize", resize);

  resize();
  showOverlay("Flappy Bird", "Tap or press <kbd>Space</kbd> to flap");
  requestAnimationFrame(loop);
}

boot();
