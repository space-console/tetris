// Block Blast for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the 8x8 DOM grid + the
// 3-piece tray, handles tap-to-place (with a live green/red preview) and a full
// keyboard/remote scheme, tracks Score/Best, and shows the game-over overlay.
// The engine owns all game logic; this file is input + render only.

import { Engine, SIZE } from "./engine.js?v=4443a5c2-73e7-4249-a4c0-7e4d5fa64797";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=4443a5c2-73e7-4249-a4c0-7e4d5fa64797";
import { Sound } from "../assets/js/shared/sound.js?v=4443a5c2-73e7-4249-a4c0-7e4d5fa64797";

// Colours indexed by the engine's piece colour ids (1..13). 0 = empty (no entry).
const COLORS = [
  null,
  "#2ee6e6", // 1  single   — cyan
  "#4f8cff", // 2  domino   — blue
  "#2ecc71", // 3  line-3   — green
  "#ff9f43", // 4  corner   — orange
  "#2ee6e6", // 5  I tetro  — cyan
  "#f4d03f", // 6  O square — yellow
  "#b14bff", // 7  T        — purple
  "#34e8a0", // 8  S        — mint
  "#ff5a5a", // 9  Z        — red
  "#ff7b3d", // 10 L        — deep orange
  "#5a7bff", // 11 J        — indigo
  "#ffd23f", // 12 3x3      — gold
  "#ff4fa3", // 13 line-5   — pink
];

const BEST_KEY = "blockblast.best";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  tray: document.getElementById("tray"),
  score: document.getElementById("score"),
  best: document.getElementById("best"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  newGame: document.getElementById("newGame"),
};

let cells = [];        // 64 DOM cell nodes (row-major)
let selected = -1;     // index of the selected tray piece, or -1
let cursor = 0;        // board index 0..63 for the keyboard/remote cursor
let preview = null;    // { cells: number[], ok: boolean } currently painted

// Load persisted best.
engine.best = Number(localStorage.getItem(BEST_KEY)) || 0;

// ---- Board construction ---------------------------------------------------
// Build the 8x8 DOM grid once. Each cell owns its own taps (data-touch-ignore
// keeps the global gesture layer off the board) and reports hover for the
// placement preview, mirroring the minesweeper tappable-cell pattern.
function buildGrid() {
  els.grid.textContent = "";
  cells = [];
  for (let i = 0; i < SIZE * SIZE; i++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.setAttribute("role", "gridcell");
    cell.setAttribute("data-touch-ignore", "");
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;

    // Hover/move preview (mouse + pen + touch-drag).
    cell.addEventListener("pointerenter", () => showPreviewAt(r, c));
    cell.addEventListener("pointermove", () => showPreviewAt(r, c));
    // pointerup (not click) keeps placement snappy and reliable on touch.
    cell.addEventListener("pointerup", (e) => { e.preventDefault(); tapCell(r, c); });

    els.grid.appendChild(cell);
    cells.push(cell);
  }
}

// ---- Selection + placement ------------------------------------------------
function selectPiece(index) {
  if (index < 0 || index >= engine.tray.length || !engine.tray[index]) return;
  if (selected === index) { selected = -1; clearPreview(); }  // tap again toggles off
  else { selected = index; sound.lock(); }
  renderTray();
  refreshPreview();
  setStatus(promptText());
}

// A tap on a board cell. With a piece selected, anchor its bounding-box
// top-left at the tapped cell, clamping so it stays in-bounds if possible,
// then place if valid.
function tapCell(r, c) {
  if (engine.over) return;
  if (selected < 0) { setStatus("Pick a piece first"); return; }
  const a = anchorFor(selected, r, c);
  if (a && engine.canPlace(selected, a.r, a.c)) placeSelected(a.r, a.c);
}

// Clamp the anchor so a piece tapped near an edge still lands on-board.
function anchorFor(index, r, c) {
  const piece = engine.tray[index];
  if (!piece) return null;
  let maxR = 0, maxC = 0;
  for (const [dr, dc] of piece.cells) { if (dr > maxR) maxR = dr; if (dc > maxC) maxC = dc; }
  const ar = Math.max(0, Math.min(r, SIZE - 1 - maxR));
  const ac = Math.max(0, Math.min(c, SIZE - 1 - maxC));
  return { r: ar, c: ac };
}

function placeSelected(r, c) {
  const res = engine.place(selected, r, c);
  if (!res) return;

  if (res.lines >= 3) sound.levelUp();        // big combo
  else if (res.lines > 0) sound.clear(res.lines);
  else sound.move();                          // plain placement

  selected = -1;
  clearPreview();

  if (res.refilled) {
    sound.move();
    // Move the cursor onto the first live piece for keyboard players.
    selected = firstPlayable();
  }
  cursor = clamp(cursor, 0, SIZE * SIZE - 1);

  persistBest();
  draw();

  if (res.over) {
    sound.gameOver();
    showOverlay("Game Over", overMsg());
    setStatus(`Game over · Score ${engine.score}`);
  } else {
    setStatus(promptText());
  }
}

// ---- Preview --------------------------------------------------------------
// Paint the would-be target cells green (valid) or red (invalid).
function showPreviewAt(r, c) {
  if (engine.over || selected < 0) return;
  const a = anchorFor(selected, r, c);
  if (!a) return;
  const piece = engine.tray[selected];
  const targets = piece.cells.map(([dr, dc]) => (a.r + dr) * SIZE + (a.c + dc));
  preview = { cells: targets, ok: engine.canPlace(selected, a.r, a.c) };
  paintPreview();
}

// Re-evaluate the preview at the current cursor (used after selection / cursor
// moves), so keyboard players see validity without a pointer.
function refreshPreview() {
  if (selected < 0) { clearPreview(); return; }
  const r = Math.floor(cursor / SIZE);
  const c = cursor % SIZE;
  showPreviewAt(r, c);
}

function clearPreview() { preview = null; paintPreview(); }

// Apply only the preview/cursor layer without rebuilding fills (cheap, called
// on every pointermove).
function paintPreview() {
  for (let i = 0; i < cells.length; i++) {
    cells[i].classList.remove("cell--ok", "cell--bad", "cell--cursor");
  }
  if (preview) {
    const cls = preview.ok ? "cell--ok" : "cell--bad";
    for (const i of preview.cells) cells[i].classList.add(cls);
  }
  // Cursor ring only matters for keyboard/remote (no pointer hover).
  if (!isTouchDevice() && !engine.over) cells[cursor].classList.add("cell--cursor");
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.score.textContent = engine.score;
  els.best.textContent = engine.best;

  for (let i = 0; i < cells.length; i++) {
    const r = Math.floor(i / SIZE);
    const c = i % SIZE;
    const id = engine.grid[r][c];
    const cell = cells[i];
    cell.classList.remove("cell--ok", "cell--bad", "cell--cursor");
    if (id) {
      cell.classList.add("cell--fill");
      cell.style.setProperty("--fill", COLORS[id]);
    } else {
      cell.classList.remove("cell--fill");
      cell.style.removeProperty("--fill");
    }
  }
  renderTray();
  paintPreview();
}

// Render the 3-piece tray as tappable mini-grid previews.
function renderTray() {
  els.tray.textContent = "";
  for (let index = 0; index < engine.tray.length; index++) {
    const piece = engine.tray[index];
    const slot = document.createElement("div");
    slot.className = "tray__piece";
    slot.setAttribute("data-touch-ignore", "");
    if (!piece) { slot.hidden = true; els.tray.appendChild(slot); continue; }

    if (index === selected) slot.classList.add("is-selected");
    if (!engine.pieceHasMove(index)) slot.classList.add("is-dead");

    // Lay the piece out in its bounding box.
    let maxR = 0, maxC = 0;
    for (const [dr, dc] of piece.cells) { if (dr > maxR) maxR = dr; if (dc > maxC) maxC = dc; }
    slot.style.gridTemplateColumns = `repeat(${maxC + 1}, var(--mini))`;
    slot.style.gridTemplateRows = `repeat(${maxR + 1}, var(--mini))`;
    const filled = new Set(piece.cells.map(([dr, dc]) => dr * (maxC + 1) + dc));
    for (let k = 0; k < (maxR + 1) * (maxC + 1); k++) {
      const mc = document.createElement("div");
      mc.className = "tray__cell";
      if (filled.has(k)) {
        mc.classList.add("tray__cell--fill");
        mc.style.setProperty("--fill", COLORS[piece.color]);
      }
      slot.appendChild(mc);
    }

    slot.addEventListener("pointerup", (e) => { e.preventDefault(); selectPiece(index); });
    els.tray.appendChild(slot);
  }
}

// ---- Intent handling (keyboard / remote / gamepad) ------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (engine.over) {
    if (intent === "enter") newGame();
    return;
  }
  switch (intent) {
    case "left": cursor = (cursor % SIZE === 0) ? cursor : cursor - 1; refreshPreview(); break;
    case "right": cursor = (cursor % SIZE === SIZE - 1) ? cursor : cursor + 1; refreshPreview(); break;
    case "up": cursor = (cursor < SIZE) ? cursor : cursor - SIZE; refreshPreview(); break;
    case "down": cursor = (cursor >= SIZE * (SIZE - 1)) ? cursor : cursor + SIZE; refreshPreview(); break;
    case "enter": {
      if (selected < 0) { selected = firstPlayable(); renderTray(); refreshPreview(); break; }
      const a = anchorFor(selected, Math.floor(cursor / SIZE), cursor % SIZE);
      if (a && engine.canPlace(selected, a.r, a.c)) placeSelected(a.r, a.c);
      break;
    }
  }
});

// Cycle to the next live tray piece (Tab / keyboard) and number-key selection.
function cyclePiece(dir) {
  const live = engine.tray.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  if (live.length === 0) return;
  if (selected < 0) { selectPiece(live[0]); return; }
  const at = live.indexOf(selected);
  const next = live[(at + dir + live.length) % live.length];
  selectPiece(next);
}

function firstPlayable() {
  for (let i = 0; i < engine.tray.length; i++) {
    if (engine.tray[i] && engine.pieceHasMove(i)) return i;
  }
  for (let i = 0; i < engine.tray.length; i++) if (engine.tray[i]) return i;
  return -1;
}

// ---- Game-state transitions ----------------------------------------------
function newGame() {
  sound.resume();   // first gesture unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  selected = -1;
  cursor = 0;
  clearPreview();
  hideOverlay();
  draw();
  setStatus(promptText());
}

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function promptText() {
  if (isTouchDevice()) {
    return selected >= 0 ? "Tap a cell to place · tap piece to cancel" : "Tap a piece to select";
  }
  return selected >= 0
    ? "Arrows move · Enter places · 1·2·3 / Tab switch"
    : "1·2·3 or Tab to pick a piece";
}
function overMsg() {
  return isTouchDevice() ? "Tap New game to play again" : "Press <kbd>Enter</kbd> for a new game";
}

// ---- Overlay helpers ------------------------------------------------------
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(text) { els.status.textContent = text; }

function persistBest() {
  try { localStorage.setItem(BEST_KEY, String(engine.best)); } catch { /* ignore */ }
}

// ---- Mute control (meta, deliberately outside the gameplay intent layer) ---
function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() { sound.toggleMute(); renderMute(); }

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ---- Boot -----------------------------------------------------------------
function boot() {
  input.start();

  buildGrid();
  draw();
  selected = firstPlayable();
  renderTray();
  setStatus(promptText());

  els.newGame.addEventListener("click", newGame);
  els.mute.addEventListener("click", toggleMute);

  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") { toggleMute(); return; }
    if (e.key === "n" || e.key === "N") { e.preventDefault(); newGame(); return; }
    // Number keys pick a tray slot directly.
    if (e.key === "1" || e.key === "2" || e.key === "3") {
      e.preventDefault(); selectPiece(Number(e.key) - 1); return;
    }
    // Tab cycles through the live pieces.
    if (e.key === "Tab") { e.preventDefault(); cyclePiece(e.shiftKey ? -1 : 1); }
  });
}

boot();
