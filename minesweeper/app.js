// Minesweeper for Space Console — entry point.
// Wires the shared intent stream to the engine, moves a cursor over a DOM grid
// of cells, renders tiles / numbers / flags / mines and the mine + time
// counters, and manages game state (idle → playing → won/lost). The engine owns
// all board logic; this file is input + render + the clock only.

import { Engine } from "./engine.js?v=62505fea-be99-4f1f-8de5-ca00c59bf70b";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=62505fea-be99-4f1f-8de5-ca00c59bf70b";
import { Sound } from "../assets/js/shared/sound.js?v=62505fea-be99-4f1f-8de5-ca00c59bf70b";

// Difficulty presets. Expert is wide — the board scrolls horizontally on small
// screens (see .board__scroll in style.css) so it never overflows the layout.
const LEVELS = {
  beginner: { rows: 9, cols: 9, mines: 10, label: "Beginner" },
  intermediate: { rows: 16, cols: 16, mines: 40, label: "Intermediate" },
  expert: { rows: 16, cols: 30, mines: 99, label: "Expert" },
};

// Classic Minesweeper number colours (1–8).
const NUM_COLORS = [
  "", "#4f8cff", "#38e8a0", "#ff5a5a", "#b14bff",
  "#ff9f43", "#33d6e0", "#e6e6f0", "#9aa0c0",
];

const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  mines: document.getElementById("mines"),
  time: document.getElementById("time"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  newGame: document.getElementById("newGame"),
  flagMode: document.getElementById("flagMode"),
  diffs: {
    beginner: document.getElementById("diffBeginner"),
    intermediate: document.getElementById("diffIntermediate"),
    expert: document.getElementById("diffExpert"),
  },
};

// On phones default to Beginner; Expert is wide and best on a larger screen.
let level = "beginner";
let engine = new Engine(LEVELS[level]);

// idle | playing | over (won or lost — engine.state distinguishes them)
let phase = "idle";
let cursor = 0;            // grid index 0..n-1 the cursor hovers
let flagMode = false;     // touch toggle: tap reveals (false) vs flags (true)
let cells = [];           // DOM nodes, one per grid cell
let startTime = 0;        // ms timestamp of the first reveal
let timer = null;         // setInterval handle for the clock
const LONG_PRESS_MS = 450;

// ---- Board construction ---------------------------------------------------
// Rebuild the DOM grid for the current difficulty. Each cell owns its own taps
// (data-touch-ignore keeps the global gesture layer off the board) and a
// long-press to flag, mirroring the tic-tac-toe tappable-cell pattern.
function buildGrid() {
  els.grid.style.setProperty("--cols", engine.cols);
  els.grid.style.setProperty("--rows", engine.rows);
  els.grid.textContent = "";
  cells = [];
  for (let i = 0; i < engine.rows * engine.cols; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("data-touch-ignore", "");
    attachCellHandlers(cell, i);
    els.grid.appendChild(cell);
    cells.push(cell);
  }
}

// pointerdown drives reveal/flag (snappier than click). A long press always
// flags, regardless of flag-mode, so touch users have two ways to flag.
function attachCellHandlers(cell, i) {
  let pressTimer = null;
  let longFired = false;

  cell.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    longFired = false;
    pressTimer = setTimeout(() => {
      longFired = true;
      flagAt(i);
    }, LONG_PRESS_MS);
  });
  const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
  cell.addEventListener("pointerup", () => {
    cancel();
    if (longFired) return;       // the long-press already flagged this cell
    tapCell(i);
  });
  cell.addEventListener("pointerleave", cancel);
  cell.addEventListener("pointercancel", cancel);
  // Right-click flags on desktop (classic Minesweeper).
  cell.addEventListener("contextmenu", (e) => { e.preventDefault(); flagAt(i); });
}

// A tap on a cell: when the round is finished any tap starts a new game.
// Otherwise it reveals — or flags, if flag-mode is on. Moves the cursor there.
function tapCell(i) {
  if (phase === "over" || phase === "idle") { newGame(); return; }
  cursor = i;
  if (flagMode) flagAt(i);
  else revealAt(i);
}

// ---- Game-state transitions ----------------------------------------------
function newGame() {
  sound.resume();   // first gesture unlocks audio (autoplay policy)
  sound.start();
  engine.configure(LEVELS[level]);
  phase = "playing";
  cursor = 0;
  stopClock();
  setTime(0);
  buildGrid();
  hideOverlay();
  draw();
  setStatus(promptText());
}

function revealAt(i) {
  if (phase !== "playing") return;
  const r = Math.floor(i / engine.cols);
  const c = i % engine.cols;
  const wasPlaced = engine.placed;
  const res = engine.reveal(r, c);
  if (res.outcome === "none") return;

  if (!wasPlaced) startClock();   // clock starts on the first successful reveal

  switch (res.outcome) {
    case "mine": loseGame(); break;
    case "win": winGame(); break;
    case "safe":
      if (res.flooded) sound.clear(1);   // a zero-region opened
      else sound.move();                 // a single number revealed
      break;
  }
  draw();
}

function flagAt(i) {
  if (phase !== "playing") return;
  const r = Math.floor(i / engine.cols);
  const c = i % engine.cols;
  if (engine.revealed[i]) return;
  engine.toggleFlag(r, c);
  sound.lock();
  draw();
}

function winGame() {
  phase = "over";
  stopClock();
  sound.levelUp();
  showOverlay("You win!", winMsg());
  setStatus(`Cleared in ${elapsed()}s`);
}

function loseGame() {
  phase = "over";
  stopClock();
  sound.gameOver();
  // Reveal every mine so the player sees the full board.
  for (const m of engine.mineIndices()) engine.revealed[m] = true;
  showOverlay("Boom!", loseMsg());
  setStatus("You hit a mine");
}

// ---- Clock ----------------------------------------------------------------
function startClock() {
  startTime = Date.now();
  setTime(0);
  timer = setInterval(() => setTime(elapsed()), 1000);
}
function stopClock() { if (timer) { clearInterval(timer); timer = null; } }
function elapsed() { return Math.min(999, Math.floor((Date.now() - startTime) / 1000)); }
function setTime(s) { els.time.textContent = s; }

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (phase === "playing") {
    const cols = engine.cols, n = engine.rows * engine.cols;
    switch (intent) {
      case "left": cursor = (cursor % cols === 0) ? cursor + cols - 1 : cursor - 1; break;
      case "right": cursor = (cursor % cols === cols - 1) ? cursor - cols + 1 : cursor + 1; break;
      case "up": cursor = (cursor - cols + n) % n; break;
      case "down": cursor = (cursor + cols) % n; break;
      case "enter": revealAt(cursor); return;
      case "back": location.href = "../"; return;
    }
    draw();
    return;
  }
  // Not playing: Enter starts a new game; Back exits to the hub.
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter" && (phase === "idle" || phase === "over")) newGame();
});

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.mines.textContent = engine.minesLeft();

  const lost = engine.state === "lost";
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const revealed = engine.revealed[i];
    const isMine = engine.mine[i];
    const flagged = engine.flagged[i];

    cell.className = "cell";
    cell.textContent = "";
    cell.style.color = "";

    if (revealed) {
      cell.classList.add("cell--open");
      if (isMine) {
        cell.textContent = "💣";
        cell.classList.add("cell--mine");
        if (i === engine.exploded) cell.classList.add("cell--boom");
      } else {
        const n = engine.count[i];
        if (n > 0) {
          cell.textContent = String(n);
          cell.style.color = NUM_COLORS[n];
        }
      }
    } else if (flagged) {
      cell.textContent = "🚩";
      cell.classList.add("cell--flag");
      // On a loss, a flag on a non-mine cell was a mistake — mark it.
      if (lost && !isMine) cell.classList.add("cell--wrong");
    }

    // The roaming cursor highlights the current cell while the round is live.
    if (phase === "playing" && i === cursor) cell.classList.add("cell--cursor");
  }
}

// ---- Difficulty + controls ------------------------------------------------
function setLevel(name) {
  level = name;
  for (const k of Object.keys(els.diffs)) {
    els.diffs[k].classList.toggle("is-active", k === name);
  }
  newGame();
}

function setFlagMode(on) {
  flagMode = on;
  els.flagMode.textContent = on ? "🚩 Flag: On" : "🚩 Flag: Off";
  els.flagMode.classList.toggle("is-active", on);
  els.flagMode.setAttribute("aria-pressed", String(on));
}
function toggleFlagMode() { setFlagMode(!flagMode); }

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function promptText() {
  return isTouchDevice()
    ? "Tap to reveal · long-press or Flag mode to flag"
    : "Arrows move · Enter reveals · F flags";
}
function startMsg() {
  return isTouchDevice() ? "Tap a cell to start" : "Press <kbd>Enter</kbd> to start";
}
function winMsg() {
  return isTouchDevice() ? "Tap to play again" : "Press <kbd>Enter</kbd> to play again";
}
function loseMsg() {
  return isTouchDevice() ? "Tap to try again" : "Press <kbd>Enter</kbd> to try again";
}

// ---- Overlay helpers ------------------------------------------------------
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(text) { els.status.textContent = text; }

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

  els.newGame.addEventListener("click", newGame);
  els.flagMode.addEventListener("click", toggleFlagMode);
  els.diffs.beginner.addEventListener("click", () => setLevel("beginner"));
  els.diffs.intermediate.addEventListener("click", () => setLevel("intermediate"));
  els.diffs.expert.addEventListener("click", () => setLevel("expert"));

  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") { toggleMute(); return; }
    // F (or hold-to-flag) toggles a flag on the cursor cell while playing.
    if ((e.key === "f" || e.key === "F") && phase === "playing") { e.preventDefault(); flagAt(cursor); return; }
    // N starts a fresh game at any time.
    if (e.key === "n" || e.key === "N") { e.preventDefault(); newGame(); }
  });

  buildGrid();        // render the empty board behind the start overlay
  draw();
  setStatus(promptText());
  showOverlay("Minesweeper", startMsg());
}

boot();
