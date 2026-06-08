// Tetris for Space Console — entry point.
// Wires the shared intent stream to the engine, runs the gravity loop, renders
// the board / next / ghost / scoreboard, and manages the game states
// (idle → playing → paused → over). The engine owns all game logic; this file
// is input + render only.

import { Engine, COLS, ROWS } from "./engine.js";
import { Input } from "../assets/js/shared/input.js";
import { Sound } from "../assets/js/shared/sound.js";

// Colours indexed by the engine's cell ids (1..7 = I O T S Z J L).
const COLORS = [
  null,
  "#2ee6e6", // I cyan
  "#f4d03f", // O yellow
  "#b14bff", // T purple
  "#2ecc71", // S green
  "#ff5a5a", // Z red
  "#4f8cff", // J blue
  "#ff9f43", // L orange
];

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const boardCanvas = document.getElementById("board");
const nextCanvas = document.getElementById("next");
const bctx = boardCanvas.getContext("2d");
const nctx = nextCanvas.getContext("2d");

const CELL = boardCanvas.width / COLS; // 40px

// How long the line-clear flash plays before the rows actually drop (ms).
const CLEAR_MS = 240;

const els = {
  status: document.getElementById("status"),
  score: document.getElementById("score"),
  lines: document.getElementById("lines"),
  level: document.getElementById("level"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// idle | playing | paused | over
let state = "idle";
let lastTime = 0;
let dropAcc = 0;        // ms accumulated toward the next gravity step
let clearAnim = null;   // { rows: number[], start: ms } while a clear plays

// ---- Game-state transitions ----------------------------------------------
function startGame() {
  sound.resume();   // first key press unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  state = "playing";
  dropAcc = 0;
  clearAnim = null;
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
  showOverlay("Game Over", `Score ${engine.score} · Press <kbd>Enter</kbd> to play again`);
  setStatus("Game over");
}

engine.addEventListener("lock", () => sound.lock());
engine.addEventListener("lineclear", (e) => {
  clearAnim = { rows: e.detail.rows, start: performance.now() };
  sound.clear(e.detail.cleared);
});
engine.addEventListener("lines", (e) => {
  if (e.detail.leveledUp) sound.levelUp();
});
engine.addEventListener("gameover", () => {
  sound.gameOver();
  gameOver();
});

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (state === "playing") {
    // Ignore movement while the clear animation plays (the piece is gone).
    if (engine.isClearing() && intent !== "back") return;
    switch (intent) {
      case "left": if (engine.move(-1)) sound.move(); break;
      case "right": if (engine.move(1)) sound.move(); break;
      case "up": if (engine.rotate()) sound.rotate(); break;
      case "down":
        engine.softDrop();
        dropAcc = 0; // resync gravity so soft drop feels responsive
        break;
      case "enter": sound.drop(); engine.hardDrop(); dropAcc = 0; break;
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

// ---- Gravity loop ---------------------------------------------------------
function loop(now) {
  if (state === "playing") {
    if (engine.isClearing()) {
      // Gravity is paused while the full rows flash; drop them when done.
      if (clearAnim && now - clearAnim.start >= CLEAR_MS) {
        engine.commitClear();
        clearAnim = null;
        dropAcc = 0;
      }
      lastTime = now;
      draw(now);
    } else {
      const dt = now - lastTime;
      lastTime = now;
      dropAcc += dt;
      const interval = engine.dropInterval();
      while (dropAcc >= interval) {
        dropAcc -= interval;
        engine.step();
        if (state !== "playing" || engine.isClearing()) break; // lock may end game / start a clear
      }
      draw(now);
    }
  } else {
    lastTime = now;
  }
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
function draw(now = performance.now()) {
  els.score.textContent = engine.score;
  els.lines.textContent = engine.lines;
  els.level.textContent = engine.level;

  bctx.clearRect(0, 0, boardCanvas.width, boardCanvas.height);
  drawGridLines();

  // Settled cells.
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      const id = engine.grid[y][x];
      if (id) drawCell(bctx, x, y, COLORS[id]);
    }
  }

  // Line-clear animation: the full rows flash white and collapse before they go.
  if (engine.isClearing() && clearAnim) {
    const t = Math.min(1, (now - clearAnim.start) / CLEAR_MS);
    for (const gy of clearAnim.rows) {
      bctx.clearRect(0, gy * CELL, boardCanvas.width, CELL);
      const h = CELL * (1 - t);                     // collapse toward the row centre
      bctx.globalAlpha = 1 - t;                     // and fade out
      bctx.fillStyle = "#ffffff";
      roundRect(bctx, 1, gy * CELL + (CELL - h) / 2, boardCanvas.width - 2, Math.max(0, h - 2), 5);
      bctx.fill();
      bctx.globalAlpha = 1;
    }
  }

  if (engine.piece && (state === "playing" || state === "paused")) {
    // Ghost: where the piece will land.
    const gy = engine.ghostY();
    const dy = gy - engine.piece.y;
    for (const [x, y] of engine.cells()) {
      if (y + dy >= 0) drawCell(bctx, x, y + dy, COLORS[engine.color(engine.piece.kind)], true);
    }
    // Active piece.
    const color = COLORS[engine.color(engine.piece.kind)];
    for (const [x, y] of engine.cells()) {
      if (y >= 0) drawCell(bctx, x, y, color);
    }
  }

  drawNext();
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

function drawCell(ctx, gx, gy, color, ghost = false) {
  const x = gx * CELL;
  const y = gy * CELL;
  const pad = 1;
  if (ghost) {
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.18;
    roundRect(ctx, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, 5);
    ctx.fill();
    ctx.globalAlpha = 1;
    return;
  }
  ctx.fillStyle = color;
  roundRect(ctx, x + pad, y + pad, CELL - pad * 2, CELL - pad * 2, 5);
  ctx.fill();
  // Glossy top highlight.
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(ctx, x + pad, y + pad, CELL - pad * 2, (CELL - pad * 2) * 0.4, 5);
  ctx.fill();
}

function drawNext() {
  nctx.clearRect(0, 0, nextCanvas.width, nextCanvas.height);
  const p = engine.next;
  if (!p) return;
  const ncell = 36;
  const cells = engine.cells({ kind: p.kind, rot: 0, x: 0, y: 0 });
  // Centre the piece within the 4x4 preview box.
  const xs = cells.map((c) => c[0]);
  const ys = cells.map((c) => c[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const offX = (nextCanvas.width - (maxX - minX + 1) * ncell) / 2 - minX * ncell;
  const offY = (nextCanvas.height - (maxY - minY + 1) * ncell) / 2 - minY * ncell;
  const color = COLORS[engine.color(p.kind)];
  for (const [x, y] of cells) {
    const px = offX + x * ncell;
    const py = offY + y * ncell;
    nctx.fillStyle = color;
    roundRect(nctx, px + 2, py + 2, ncell - 4, ncell - 4, 5);
    nctx.fill();
    nctx.fillStyle = "rgba(255,255,255,0.18)";
    roundRect(nctx, px + 2, py + 2, ncell - 4, (ncell - 4) * 0.4, 5);
    nctx.fill();
  }
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
  draw();             // render the empty board behind the start overlay
  showOverlay("Tetris", "Press <kbd>Enter</kbd> to start");
  requestAnimationFrame(loop);
}

boot();
