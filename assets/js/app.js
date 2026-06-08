// Tetris for Space Console — entry point.
// Wires the shared intent stream to the engine, runs the gravity loop, renders
// the board / next / ghost / scoreboard, and manages the game states
// (idle → playing → paused → over). The engine owns all game logic; this file
// is input + render only.

import { Engine, COLS, ROWS } from "./engine.js?v=cc2b755e-e810-41e2-a22d-0b233f4eac5e";
import { Input } from "./input.js?v=cc2b755e-e810-41e2-a22d-0b233f4eac5e";

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

const boardCanvas = document.getElementById("board");
const nextCanvas = document.getElementById("next");
const bctx = boardCanvas.getContext("2d");
const nctx = nextCanvas.getContext("2d");

const CELL = boardCanvas.width / COLS; // 30px

const els = {
  status: document.getElementById("status"),
  score: document.getElementById("score"),
  lines: document.getElementById("lines"),
  level: document.getElementById("level"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
};

// idle | playing | paused | over
let state = "idle";
let lastTime = 0;
let dropAcc = 0; // ms accumulated toward the next gravity step

// ---- Game-state transitions ----------------------------------------------
function startGame() {
  engine.reset();
  state = "playing";
  dropAcc = 0;
  lastTime = performance.now();
  hideOverlay();
  setStatus("");
  draw();
}

function pause() {
  if (state !== "playing") return;
  state = "paused";
  showOverlay("Paused", "Press <kbd>Enter</kbd> to resume");
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

engine.addEventListener("gameover", gameOver);

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (state === "playing") {
    switch (intent) {
      case "left": engine.move(-1); break;
      case "right": engine.move(1); break;
      case "up": engine.rotate(); break;
      case "down":
        engine.softDrop();
        dropAcc = 0; // resync gravity so soft drop feels responsive
        break;
      case "enter": engine.hardDrop(); dropAcc = 0; break;
      case "back": pause(); break;
    }
    draw();
    return;
  }

  // Not playing: Enter advances (start / resume / restart); Back resumes too.
  if (intent === "enter" || intent === "back") {
    if (state === "idle" || state === "over") startGame();
    else if (state === "paused") resume();
  }
});

// ---- Gravity loop ---------------------------------------------------------
function loop(now) {
  if (state === "playing") {
    const dt = now - lastTime;
    lastTime = now;
    dropAcc += dt;
    const interval = engine.dropInterval();
    while (dropAcc >= interval) {
      dropAcc -= interval;
      engine.step();
      if (state !== "playing") break; // a lock may have ended the game
    }
    draw();
  } else {
    lastTime = now;
  }
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
function draw() {
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
  const ncell = 32;
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

// ---- Boot -----------------------------------------------------------------
function boot() {
  input.start();
  draw();             // render the empty board behind the start overlay
  showOverlay("Tetris", "Press <kbd>Enter</kbd> to start");
  requestAnimationFrame(loop);
}

boot();
