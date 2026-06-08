// Sudoku for Space Console — entry point.
// Wires the shared intent stream to the engine, builds the 9×9 DOM grid, moves
// the selection, edits non-given cells, renders cell states (given / selected /
// conflict), and shows a win overlay. The engine owns all game logic; this file
// is input + render only.

import { Engine, N } from "./engine.js?v=249f7edb-2ece-4311-98c3-4217e5a5562d";
import { Input } from "../assets/js/shared/input.js?v=249f7edb-2ece-4311-98c3-4217e5a5562d";
import { Sound } from "../assets/js/shared/sound.js?v=249f7edb-2ece-4311-98c3-4217e5a5562d";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  grid: document.getElementById("grid"),
  status: document.getElementById("status"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// playing | solved
let state = "playing";
let sel = { r: 0, c: 0 };   // the selected cell
let cells = [];             // the 81 cell elements, indexed [r][c]

// ---- Grid construction ----------------------------------------------------
// Build the 81 cell <div>s once; render() repaints their text and state.
function buildGrid() {
  els.grid.innerHTML = "";
  cells = [];
  for (let r = 0; r < N; r++) {
    cells[r] = [];
    for (let c = 0; c < N; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      cell.setAttribute("role", "gridcell");
      // Clicking a cell selects it — a mouse convenience alongside the D-pad.
      cell.addEventListener("click", () => {
        select(r, c);
      });
      els.grid.appendChild(cell);
      cells[r][c] = cell;
    }
  }
}

// ---- Game-state transitions ----------------------------------------------
function newGame() {
  engine.newPuzzle();
  state = "playing";
  // Land the cursor on the first editable cell so Enter/number keys do something.
  sel = firstEmpty();
  hideOverlay();
  render();
}

function win() {
  state = "solved";
  sound.levelUp();
  sound.start();
  showOverlay("Solved!", "Press <kbd>Enter</kbd> for a new puzzle");
}

// First non-given cell (top-left scan), falling back to 0,0.
function firstEmpty() {
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!engine.isGiven(r, c)) return { r, c };
    }
  }
  return { r: 0, c: 0 };
}

// ---- Selection + editing --------------------------------------------------
function select(r, c) {
  sel = { r, c };
  render();
}

// Move the selection by one step, wrapping at the edges (TV-remote friendly).
function moveSel(dr, dc) {
  sel = {
    r: (sel.r + dr + N) % N,
    c: (sel.c + dc + N) % N,
  };
  sound.move();
  render();
}

// Apply an edit to the selected cell, then re-render and check for a win.
function edit(fn) {
  if (fn()) {
    sound.lock();
    render();
    if (engine.isSolved()) win();
  }
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  sound.resume();   // first key press unlocks audio (autoplay policy)

  if (intent === "back") { location.href = "../"; return; }

  if (state === "solved") {
    // The win screen waits on Enter to deal the next puzzle.
    if (intent === "enter") newGame();
    return;
  }

  switch (intent) {
    case "up": moveSel(-1, 0); break;
    case "down": moveSel(1, 0); break;
    case "left": moveSel(0, -1); break;
    case "right": moveSel(0, 1); break;
    // Enter cycles the selected cell 1→…→9→empty — works on a bare TV remote.
    case "enter": edit(() => engine.cycle(sel.r, sel.c)); break;
  }
});

// ---- Rendering ------------------------------------------------------------
function render() {
  const bad = engine.conflicts();
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const el = cells[r][c];
      const v = engine.board[r][c];
      el.textContent = v === 0 ? "" : String(v);
      el.classList.toggle("cell--given", engine.isGiven(r, c));
      el.classList.toggle("cell--selected", r === sel.r && c === sel.c);
      el.classList.toggle("cell--bad", bad.has(r + "," + c));
    }
  }
  const left = engine.remaining();
  els.status.textContent = state === "solved"
    ? "Solved! Press Enter for a new puzzle"
    : `${left} cell${left === 1 ? "" : "s"} left`;
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

// ---- Mute control (meta, deliberately outside the gameplay intent layer) ---
function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() {
  sound.toggleMute();
  renderMute();
}

// ---- Direct number entry (convenience outside the 6-intent vocabulary) -----
// Number keys set a value directly and 0/Backspace/Delete clear it — a fast
// path for keyboard players, while Enter-cycling stays available for remotes.
function onKeyEntry(e) {
  if (state !== "playing") return;
  if (e.key >= "1" && e.key <= "9") {
    edit(() => engine.setCell(sel.r, sel.c, Number(e.key)));
  } else if (e.key === "0" || e.key === "Backspace" || e.key === "Delete") {
    edit(() => engine.setCell(sel.r, sel.c, 0));
  }
}

// ---- Boot -----------------------------------------------------------------
function boot() {
  buildGrid();
  newGame();
  input.start();
  els.mute.addEventListener("click", toggleMute);
  // Meta controls handled directly on the window, outside the intent layer:
  // M toggles mute; 0–9 / Backspace / Delete edit the selected cell.
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") { toggleMute(); return; }
    onKeyEntry(e);
  });
}

boot();
