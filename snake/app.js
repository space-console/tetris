// Snake for Space Console — entry point.
// Wires the shared intent stream to the engine, runs the tick loop, renders
// the grid / snake / food / scoreboard, and manages the game states
// (idle → playing → paused → over). The engine owns all game logic; this file
// is input + render only.

import { Engine, COLS, ROWS } from "./engine.js";
import { Input } from "../assets/js/shared/input.js";
import { Sound } from "../assets/js/shared/sound.js";

// Palette: the head is brighter than the body so the heading reads at a glance.
const HEAD = "#7cffc4";
const BODY = "#1f9d6b";
const FOOD = "#ff5a5a";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const boardCanvas = document.getElementById("board");
const bctx = boardCanvas.getContext("2d");

const CELL = boardCanvas.width / COLS; // 30px

// Best score persists across restarts within the session (and the browser).
const BEST_KEY = "snake.best";

const els = {
  status: document.getElementById("status"),
  score: document.getElementById("score"),
  best: document.getElementById("best"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// idle | playing | paused | over
let state = "idle";
let lastTime = 0;
let tickAcc = 0; // ms accumulated toward the next tick
let best = loadBest();

// ---- Game-state transitions ----------------------------------------------
function startGame() {
  sound.resume();   // first key press unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  state = "playing";
  tickAcc = 0;
  lastTime = performance.now();
  hideOverlay();
  setStatus("");
  draw();
}

function pause() {
  if (state !== "playing") return;
  state = "paused";
  showOverlay("Paused", "<kbd>Enter</kbd> resume · <kbd>Back</kbd> menu");
  setStatus("Paused");
}

function resume() {
  if (state !== "paused") return;
  state = "playing";
  lastTime = performance.now();
  hideOverlay();
  setStatus("");
}

function gameOver() {
  state = "over";
  if (engine.score > best) {
    best = engine.score;
    saveBest(best);
  }
  showOverlay("Game Over", `Score ${engine.score} · Press <kbd>Enter</kbd> to play again`);
  setStatus("Game over");
}

engine.addEventListener("eat", () => sound.clear(1));
engine.addEventListener("gameover", () => {
  sound.gameOver();
  gameOver();
});

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (state === "playing") {
    switch (intent) {
      case "up": if (engine.turn("up")) sound.move(); break;
      case "down": if (engine.turn("down")) sound.move(); break;
      case "left": if (engine.turn("left")) sound.move(); break;
      case "right": if (engine.turn("right")) sound.move(); break;
      case "back": pause(); break;
    }
    draw();
    return;
  }

  // Not playing: Enter advances (start / resume / restart); Back exits to the hub.
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter") {
    if (state === "idle" || state === "over") startGame();
    else if (state === "paused") resume();
  }
});

// ---- Tick loop ------------------------------------------------------------
function loop(now) {
  if (state === "playing") {
    const dt = now - lastTime;
    lastTime = now;
    tickAcc += dt;
    const interval = engine.tickInterval();
    while (tickAcc >= interval) {
      tickAcc -= interval;
      engine.tick();
      if (state !== "playing") break; // a tick can end the game
    }
    draw(now);
  } else {
    lastTime = now;
  }
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.score.textContent = engine.score;
  els.best.textContent = best;

  bctx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
  drawGridLines();

  // Food: a distinct dot with a soft glow.
  if (engine.food) {
    const cx = engine.food.x * CELL + CELL / 2;
    const cy = engine.food.y * CELL + CELL / 2;
    bctx.fillStyle = FOOD;
    bctx.shadowColor = FOOD;
    bctx.shadowBlur = CELL * 0.6;
    bctx.beginPath();
    bctx.arc(cx, cy, CELL * 0.32, 0, Math.PI * 2);
    bctx.fill();
    bctx.shadowBlur = 0;
  }

  // Snake body as rounded cells; the head is brighter than the body.
  for (let i = engine.snake.length - 1; i >= 0; i--) {
    const seg = engine.snake[i];
    drawCell(seg.x, seg.y, i === 0 ? HEAD : BODY);
  }
}

function drawGridLines() {
  bctx.strokeStyle = "rgba(255,255,255,0.04)";
  bctx.lineWidth = 1;
  for (let x = 1; x < COLS; x++) {
    bctx.beginPath();
    bctx.moveTo(x * CELL + 0.5, 0);
    bctx.lineTo(x * CELL + 0.5, boardCanvas.height);
    bctx.stroke();
  }
  for (let y = 1; y < ROWS; y++) {
    bctx.beginPath();
    bctx.moveTo(0, y * CELL + 0.5);
    bctx.lineTo(boardCanvas.width, y * CELL + 0.5);
    bctx.stroke();
  }
}

function drawCell(gx, gy, color) {
  const x = gx * CELL;
  const y = gy * CELL;
  const pad = 1.5;
  bctx.fillStyle = color;
  roundRect(bctx, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, 6);
  bctx.fill();
  // Glossy top highlight.
  bctx.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(bctx, x + pad, y + pad, CELL - pad * 2, (CELL - pad * 2) * 0.4, 6);
  bctx.fill();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---- Best score persistence ------------------------------------------------
function loadBest() {
  try {
    return Number(localStorage.getItem(BEST_KEY)) || 0;
  } catch {
    return 0; // private mode / storage disabled — fall back to session memory
  }
}
function saveBest(value) {
  try {
    localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // ignore: best simply won't persist past the page
  }
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
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });
  draw();             // render the starting board behind the start overlay
  showOverlay("Snake", "Press <kbd>Enter</kbd> to start");
  requestAnimationFrame(loop);
}

boot();
