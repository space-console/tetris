// Scrabble for Space Console — entry point.
// Wires the shared intent stream to the pure engine, renders the 15×15 board,
// the active player's rack and the action buttons, manages tentative tile
// placement (tap / type), the blank-tile chooser, exchange mode, hot-seat pass
// screens and the async anchor-based AI, and drives the game states
// (loading → menu → playing → thinking → over). The engine owns all rules,
// scoring and move generation; this file is input + render + modes only.

import {
  Engine, buildDictionary, premiumAt, letterValue, PREMIUM,
  SIZE, CENTER, RACK_SIZE,
} from "./engine.js?v=9fa42cb0-cff6-42c8-b3d6-39334e207fcd";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=9fa42cb0-cff6-42c8-b3d6-39334e207fcd";
import { Sound } from "../assets/js/shared/sound.js?v=9fa42cb0-cff6-42c8-b3d6-39334e207fcd";

const input = new Input();
const sound = new Sound();
let engine = null; // built once the dictionary loads

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  rack: document.getElementById("rack"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  menu: document.getElementById("menu"),
  modeTwo: document.getElementById("modeTwo"),
  modeAI: document.getElementById("modeAI"),
  blankPick: document.getElementById("blankPick"),
  blankGrid: document.getElementById("blankGrid"),
  passScreen: document.getElementById("passScreen"),
  passTitle: document.getElementById("passTitle"),
  passMsg: document.getElementById("passMsg"),
  passReady: document.getElementById("passReady"),
  btnPlay: document.getElementById("btnPlay"),
  btnRecall: document.getElementById("btnRecall"),
  btnShuffle: document.getElementById("btnShuffle"),
  btnExchange: document.getElementById("btnExchange"),
  btnPass: document.getElementById("btnPass"),
  p1name: document.getElementById("p1name"),
  p2name: document.getElementById("p2name"),
  p1score: document.getElementById("p1score"),
  p2score: document.getElementById("p2score"),
  bagLeft: document.getElementById("bagLeft"),
  turnInfo: document.getElementById("turnInfo"),
  lastPlay: document.getElementById("lastPlay"),
  mute: document.getElementById("mute"),
};

// loading | menu | playing | thinking | passwait | over
let state = "loading";
let mode = "two";                 // "two" (hot-seat) or "ai" (vs computer)
let menuIndex = 0;                // highlighted menu item (0 = 2P, 1 = AI)
const HUMAN = 0;                  // in AI mode the human is player 0

// Tentative tiles the active player has placed this turn but not committed:
//   { row, col, rackIndex, letter, blank }   (letter = effective A–Z letter)
let tentative = [];
let selectedRack = null;          // selected rack index, or null
let cursor = { row: CENTER, col: CENTER };
let dirHorizontal = true;         // typing direction for the keyboard cursor
let exchangeMode = false;         // arming exchange: tap tiles to mark
let exchangeMarks = new Set();    // rack indices marked for exchange
let blankPending = null;          // { row, col, rackIndex } awaiting a letter
let blankPickIndex = 0;           // highlighted letter in the blank chooser
let lastPlayText = "—";           // remembered for the side panel

// ---- Cells: build the 225 squares once; only update text/classes after. -----
const cells = [];
for (let i = 0; i < SIZE * SIZE; i++) {
  const row = Math.floor(i / SIZE);
  const col = i % SIZE;
  const cell = document.createElement("div");
  cell.className = "cell " + premiumClass(premiumAt(row, col));
  if (row === CENTER && col === CENTER) cell.classList.add("cell--center");
  cell.setAttribute("role", "gridcell");
  // Squares own their taps, so keep the global gesture layer out (also styled
  // touch-action: manipulation in style.css).
  cell.setAttribute("data-touch-ignore", "");
  cell.addEventListener("pointerdown", () => tapSquare(row, col));
  els.grid.appendChild(cell);
  cells.push(cell);
}

function premiumClass(p) {
  switch (p) {
    case PREMIUM.TW: return "cell--tw";
    case PREMIUM.DW: return "cell--dw";
    case PREMIUM.TL: return "cell--tl";
    case PREMIUM.DL: return "cell--dl";
    default: return "";
  }
}
function premiumLabel(p) {
  switch (p) {
    case PREMIUM.TW: return "TW";
    case PREMIUM.DW: return "DW";
    case PREMIUM.TL: return "TL";
    case PREMIUM.DL: return "DL";
    default: return "";
  }
}

// ---- Dictionary loading (async; do not block the UI) -----------------------
function loadDictionary() {
  setStatus("Loading dictionary…");
  showOverlay("Scrabble", "Loading dictionary…");
  els.menu.classList.add("menu--hidden");
  fetch("./words.txt")
    .then((r) => r.text())
    .then((text) => {
      const dict = buildDictionary(text);
      engine = new Engine(dict);
      state = "menu";
      showMenu();
    })
    .catch(() => {
      setStatus("Failed to load dictionary");
      showOverlay("Scrabble", "Could not load the word list. Reload to retry.");
    });
}

// ---- Mode menu ------------------------------------------------------------
function showMenu() {
  state = "menu";
  resetTurnState();
  els.menu.classList.remove("menu--hidden");
  hideAuxOverlays();
  showOverlay("Scrabble", isTouchDevice() ? "Tap a mode to begin" : "Pick a mode · Enter");
  renderMenu();
  setStatus("Choose a mode");
  draw();
}

function renderMenu() {
  els.modeTwo.classList.toggle("menu__item--active", menuIndex === 0);
  els.modeAI.classList.toggle("menu__item--active", menuIndex === 1);
}

function startGame(chosenMode) {
  sound.resume(); // first interaction unlocks audio (autoplay policy)
  sound.start();
  mode = chosenMode;
  engine.reset(2);
  resetTurnState();
  cursor = { row: CENTER, col: CENTER };
  dirHorizontal = true;
  hideOverlay();
  hideAuxOverlays();
  state = "playing";
  sound.move();
  draw();
}

function resetTurnState() {
  tentative = [];
  selectedRack = null;
  exchangeMode = false;
  exchangeMarks = new Set();
  blankPending = null;
  els.btnExchange.classList.remove("abtn--armed");
}

// ---- Placement helpers ----------------------------------------------------
// Effective letter shown on a square right now (board tile or tentative tile).
function effectiveAt(row, col) {
  const t = tentative.find((p) => p.row === row && p.col === col);
  if (t) return { letter: t.letter, blank: t.blank, tentative: true };
  const b = engine.tileAt(row, col);
  return b ? { letter: b.letter, blank: b.blank, tentative: false } : null;
}

// Which rack indices are currently committed to tentative tiles.
function usedRackIndices() {
  return new Set(tentative.map((t) => t.rackIndex));
}

// Place the selected rack tile at (row,col) tentatively. Blanks open the chooser.
function placeTentative(row, col, rackIndex) {
  if (effectiveAt(row, col)) return; // square already filled
  const tile = engine.current.rack[rackIndex];
  if (tile === undefined) return;
  if (tile === "?") {
    // A blank: ask which letter it represents before committing the square.
    blankPending = { row, col, rackIndex };
    openBlankPicker();
    return;
  }
  tentative.push({ row, col, rackIndex, letter: tile, blank: false });
  selectedRack = null;
  sound.lock();
  draw();
}

// Remove the tentative tile at (row,col), if any.
function recallAt(row, col) {
  const i = tentative.findIndex((p) => p.row === row && p.col === col);
  if (i === -1) return false;
  tentative.splice(i, 1);
  sound.move();
  return true;
}

function recallAll() {
  if (tentative.length === 0) return;
  tentative = [];
  selectedRack = null;
  sound.move();
  draw();
}

// ---- Tap handling ---------------------------------------------------------
function tapSquare(row, col) {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return;
  cursor = { row, col };

  // Tap a tentative tile to recall it.
  const occ = effectiveAt(row, col);
  if (occ && occ.tentative) { recallAt(row, col); draw(); return; }
  if (occ) { draw(); return; } // board tile: just move the cursor

  // Empty square: drop the selected rack tile, or the first free rack tile.
  if (selectedRack !== null && !usedRackIndices().has(selectedRack)) {
    placeTentative(row, col, selectedRack);
  } else {
    const used = usedRackIndices();
    const free = engine.current.rack.findIndex((t, i) => t !== undefined && !used.has(i));
    if (free !== -1) { selectedRack = free; placeTentative(row, col, free); }
  }
  draw();
}

function tapRack(i) {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return;
  if (exchangeMode) {
    if (exchangeMarks.has(i)) exchangeMarks.delete(i);
    else exchangeMarks.add(i);
    draw();
    return;
  }
  if (usedRackIndices().has(i)) return; // tile already on the board this turn
  selectedRack = selectedRack === i ? null : i;
  draw();
}

// ---- Blank-tile chooser ---------------------------------------------------
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
function openBlankPicker() {
  blankPickIndex = 0;
  els.blankGrid.innerHTML = "";
  ALPHABET.forEach((L) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "blank__btn";
    b.textContent = L;
    b.setAttribute("data-touch-ignore", "");
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); chooseBlank(L); });
    els.blankGrid.appendChild(b);
  });
  renderBlankPicker();
  els.blankPick.classList.remove("overlay--hidden");
  setStatus("Pick the blank's letter");
}
function renderBlankPicker() {
  [...els.blankGrid.children].forEach((b, i) =>
    b.classList.toggle("blank__btn--active", i === blankPickIndex));
}
function chooseBlank(letter) {
  if (!blankPending) return;
  const { row, col, rackIndex } = blankPending;
  tentative.push({ row, col, rackIndex, letter, blank: true });
  blankPending = null;
  selectedRack = null;
  els.blankPick.classList.add("overlay--hidden");
  sound.lock();
  draw();
}
function cancelBlank() {
  blankPending = null;
  els.blankPick.classList.add("overlay--hidden");
  draw();
}

// ---- Actions: Play / Recall / Shuffle / Exchange / Pass --------------------
function doPlay() {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return;
  if (exchangeMode) { commitExchange(); return; }
  if (tentative.length === 0) { flash("Place some tiles first"); return; }

  const placements = tentative.map((t) => ({
    row: t.row, col: t.col, letter: t.letter, blank: t.blank,
  }));
  const res = engine.commitPlay(placements);
  if (!res.ok) {
    sound.drop();
    flash(res.reason);
    return;
  }
  // Success.
  const by = res.by !== undefined ? res.by : engine.lastPlay.by;
  recordLastPlay(by, res);
  if (res.bingo) sound.levelUp();
  else sound.clear(1);
  tentative = [];
  selectedRack = null;
  afterTurn();
}

function doShuffle() {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return;
  // Shuffle the visible rack order (cosmetic) by shuffling the engine rack.
  const rack = engine.current.rack;
  for (let i = rack.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rack[i], rack[j]] = [rack[j], rack[i]];
  }
  // Tentative tiles point at rack indices, so recall them to stay consistent.
  recallAll();
  exchangeMode = false;
  exchangeMarks = new Set();
  els.btnExchange.classList.remove("abtn--armed");
  sound.move();
  draw();
}

function toggleExchange() {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return;
  if (engine.bagCount < RACK_SIZE) { flash("Bag too low to exchange"); return; }
  if (exchangeMode) {
    // Second press = cancel.
    exchangeMode = false;
    exchangeMarks = new Set();
    els.btnExchange.classList.remove("abtn--armed");
    setStatus("Exchange cancelled");
  } else {
    recallAll();
    exchangeMode = true;
    exchangeMarks = new Set();
    els.btnExchange.classList.add("abtn--armed");
    setStatus("Tap tiles to swap, then Play");
  }
  draw();
}

function commitExchange() {
  if (exchangeMarks.size === 0) { flash("Mark tiles to exchange"); return; }
  const letters = [...exchangeMarks].map((i) => engine.current.rack[i]);
  const res = engine.exchange(letters);
  exchangeMode = false;
  exchangeMarks = new Set();
  els.btnExchange.classList.remove("abtn--armed");
  if (!res.ok) { sound.drop(); flash(res.reason); return; }
  lastPlayText = `${playerName(engine.lastPlay.by)} exchanged ${res.exchanged}`;
  sound.move();
  afterTurn();
}

function doPass() {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return;
  recallAll();
  const by = engine.turn;
  engine.pass();
  lastPlayText = `${playerName(by)} passed`;
  sound.move();
  afterTurn();
}

function recordLastPlay(by, res) {
  const words = res.words.map((w) => `${w.word} (${w.score})`).join(", ");
  lastPlayText = `${playerName(by)}: ${words} = ${res.total}${res.bingo ? " · BINGO!" : ""}`;
}

// ---- Turn flow ------------------------------------------------------------
function afterTurn() {
  resetTurnState();
  if (engine.gameOver) { endGame(); return; }

  if (mode === "ai" && engine.turn !== HUMAN) {
    // Hand off to the AI, deferred so the board paints and a status shows.
    state = "thinking";
    cursor = { row: CENTER, col: CENTER };
    setStatus("Computer thinking…");
    draw();
    setTimeout(aiMove, 40);
    return;
  }

  if (mode === "two") {
    // Hot-seat: show a pass-device screen so the next player's rack stays hidden
    // until they're ready.
    state = "passwait";
    els.passTitle.textContent = `${playerName(engine.turn)}'s turn`;
    els.passMsg.innerHTML = isTouchDevice() ? "Tap Ready when seated" : "Press Enter when ready";
    els.passScreen.classList.remove("overlay--hidden");
    setStatus(`${playerName(engine.turn)} — pass the device`);
    draw();
    return;
  }

  // AI mode, human's turn.
  state = "playing";
  cursor = { row: CENTER, col: CENTER };
  sound.move();
  draw();
}

function readyForTurn() {
  els.passScreen.classList.add("overlay--hidden");
  state = "playing";
  cursor = { row: CENTER, col: CENTER };
  draw();
}

function endGame() {
  state = "over";
  els.menu.classList.add("menu--hidden");
  hideAuxOverlays();
  const w = engine.winners;
  let title;
  if (w.length > 1) title = "It's a tie!";
  else title = `${playerName(w[0])} wins!`;
  const scores = engine.players.map((p, i) => `${playerName(i)} ${p.score}`).join("  ·  ");
  showOverlay(title, `${scores} — ${replayMsg()}`);
  setStatus(title);
  // Win sound (or a neutral tone for ties).
  sound.gameOver();
  draw();
}

// ---- AI (anchor-based generation in the engine) ---------------------------
// Strategy: generate all legal plays, then pick from the top of the score
// distribution. We don't always take the single best play — sampling among the
// top few keeps the opponent strong but beatable (documented choice). If no play
// exists, exchange (when possible) or pass.
function aiMove() {
  if (!engine || state !== "thinking") return;
  const rack = engine.current.rack.slice();
  const moves = engine.generateMoves(rack, { limit: 30000 });

  if (moves.length === 0) {
    // No legal play: exchange a few tiles if the bag allows, else pass.
    const by = engine.turn;
    if (engine.bagCount >= RACK_SIZE) {
      const swap = rack.slice(0, Math.min(3, rack.length));
      engine.exchange(swap);
      lastPlayText = `${playerName(by)} exchanged ${swap.length}`;
    } else {
      engine.pass();
      lastPlayText = `${playerName(by)} passed`;
    }
    sound.move();
    afterTurn();
    return;
  }

  moves.sort((a, b) => b.total - a.total);
  // Sample among the top ~5 plays for a beatable-but-strong opponent.
  const topN = Math.min(5, moves.length);
  const pick = moves[Math.floor(Math.random() * topN)];

  const by = engine.turn;
  const res = engine.commitPlay(pick.placements);
  if (!res.ok) {
    // Should never happen (every candidate is validated), but fail safe.
    engine.pass();
    lastPlayText = `${playerName(by)} passed`;
    sound.move();
    afterTurn();
    return;
  }
  recordLastPlay(by, res);
  if (res.bingo) sound.levelUp(); else sound.clear(1);
  afterTurn();
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  // Menu: arrows pick a mode, Enter starts it, Back returns to the hub.
  if (state === "menu") {
    if (intent === "up" || intent === "down") { menuIndex = menuIndex === 0 ? 1 : 0; renderMenu(); }
    else if (intent === "enter") startGame(menuIndex === 0 ? "two" : "ai");
    else if (intent === "back") location.href = "../";
    return;
  }

  if (state === "loading") {
    if (intent === "back") location.href = "../";
    return;
  }

  // Blank chooser: arrows move the highlight, Enter confirms, Back cancels.
  if (blankPending) {
    if (intent === "left") { blankPickIndex = (blankPickIndex + 25) % 26; renderBlankPicker(); }
    else if (intent === "right") { blankPickIndex = (blankPickIndex + 1) % 26; renderBlankPicker(); }
    else if (intent === "up") { blankPickIndex = (blankPickIndex + 19) % 26; renderBlankPicker(); }
    else if (intent === "down") { blankPickIndex = (blankPickIndex + 7) % 26; renderBlankPicker(); }
    else if (intent === "enter") chooseBlank(ALPHABET[blankPickIndex]);
    else if (intent === "back") cancelBlank();
    return;
  }

  // Pass-device screen: Enter / Back reveal the next player's turn.
  if (state === "passwait") {
    if (intent === "enter" || intent === "back") readyForTurn();
    return;
  }

  // Game over: Enter / Back return to the menu.
  if (state === "over") {
    if (intent === "enter" || intent === "back") showMenu();
    return;
  }

  // AI thinking: ignore gameplay except Back (→ menu).
  if (state === "thinking") {
    if (intent === "back") showMenu();
    return;
  }

  // Playing.
  if (state === "playing") {
    switch (intent) {
      case "left": cursor.col = Math.max(0, cursor.col - 1); break;
      case "right": cursor.col = Math.min(SIZE - 1, cursor.col + 1); break;
      case "up": cursor.row = Math.max(0, cursor.row - 1); break;
      case "down": cursor.row = Math.min(SIZE - 1, cursor.row + 1); break;
      case "enter": doPlay(); return;
      case "back": showMenu(); return;
    }
    draw();
  }
});

// Keyboard typing: place a letter from the rack at the cursor and advance; the
// shared Input layer only emits direction/enter/back intents, so letters and a
// few editing keys are handled here directly (a meta layer, like the M mute key).
function onTypeKey(e) {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return;
  if (blankPending || exchangeMode) return;

  // Toggle typing direction with space.
  if (e.key === " ") { e.preventDefault(); dirHorizontal = !dirHorizontal; draw(); return; }

  if (e.key === "Backspace") {
    e.preventDefault();
    // Recall the tile at the cursor, or step back and recall.
    if (!recallAt(cursor.row, cursor.col)) {
      stepCursor(-1);
      recallAt(cursor.row, cursor.col);
    }
    draw();
    return;
  }

  const k = e.key.toUpperCase();
  if (/^[A-Z]$/.test(k)) {
    e.preventDefault();
    typeLetter(k);
  }
}

// Place a rack tile matching letter `L` at the cursor (preferring a real tile,
// falling back to a blank), then advance the cursor in the typing direction.
function typeLetter(L) {
  if (effectiveAt(cursor.row, cursor.col)) { stepCursor(1); return; }
  const used = usedRackIndices();
  const rack = engine.current.rack;
  let idx = rack.findIndex((t, i) => t === L && !used.has(i));
  let isBlank = false;
  if (idx === -1) { idx = rack.findIndex((t, i) => t === "?" && !used.has(i)); isBlank = true; }
  if (idx === -1) { flash(`No ${L} on the rack`); return; }
  tentative.push({ row: cursor.row, col: cursor.col, rackIndex: idx, letter: L, blank: isBlank });
  sound.lock();
  stepCursor(1);
  draw();
}

// Move the cursor one step along the typing direction, skipping nothing (the
// player can place over multiple turns/positions freely).
function stepCursor(delta) {
  if (dirHorizontal) cursor.col = Math.min(SIZE - 1, Math.max(0, cursor.col + delta));
  else cursor.row = Math.min(SIZE - 1, Math.max(0, cursor.row + delta));
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  if (!engine) return;
  const aiTurn = mode === "ai" && engine.turn !== HUMAN;
  // Hide the rack contents during the AI's turn / pass-wait / non-play states.
  const hideRack = state === "passwait" || state === "thinking" || state === "over" ||
    state === "menu" || aiTurn;

  // Board.
  for (let i = 0; i < cells.length; i++) {
    const row = Math.floor(i / SIZE);
    const col = i % SIZE;
    const cell = cells[i];
    const occ = effectiveAt(row, col);

    cell.classList.toggle("cell--filled", !!occ);
    cell.classList.toggle("cell--tentative", !!occ && occ.tentative);
    const showCursor = state === "playing" && row === cursor.row && col === cursor.col;
    cell.classList.toggle("cell--cursor", showCursor);
    cell.classList.toggle("dir-h", showCursor && dirHorizontal);
    cell.classList.toggle("dir-v", showCursor && !dirHorizontal);

    if (occ) {
      const val = occ.blank ? 0 : letterValue(occ.letter);
      cell.innerHTML =
        `<div class="tile${occ.blank ? " tile--blank" : ""}">` +
        `<span class="tile__letter">${occ.letter}</span>` +
        `<span class="tile__pts">${val}</span></div>`;
    } else {
      // Empty: show the premium label (the center star is drawn via ::after).
      cell.innerHTML = premiumLabel(premiumAt(row, col));
    }
  }

  // Rack.
  renderRack(hideRack);

  // Buttons enabled only on the human's live turn.
  const live = state === "playing" && !aiTurn;
  els.btnPlay.disabled = !live;
  els.btnRecall.disabled = !live || tentative.length === 0;
  els.btnShuffle.disabled = !live;
  els.btnExchange.disabled = !live || engine.bagCount < RACK_SIZE;
  els.btnPass.disabled = !live;
  els.btnPlay.textContent = exchangeMode ? "Swap" : "Play";

  // Panel.
  els.p1name.textContent = playerName(0);
  els.p2name.textContent = playerName(1);
  els.p1score.textContent = engine.players[0].score;
  els.p2score.textContent = engine.players[1].score;
  els.bagLeft.textContent = engine.bagCount;
  els.p1name.parentElement.classList.toggle("score--active", state !== "over" && engine.turn === 0);
  els.p2name.parentElement.classList.toggle("score--active", state !== "over" && engine.turn === 1);
  els.turnInfo.textContent = state === "over"
    ? "Game over"
    : `${playerName(engine.turn)} to move`;
  els.lastPlay.textContent = lastPlayText;

  if (state === "playing" && !aiTurn) {
    setStatus(exchangeMode
      ? "Exchange: tap tiles, then Swap"
      : `${playerName(engine.turn)}: place tiles · Play`);
  }
}

function renderRack(hide) {
  els.rack.innerHTML = "";
  const rack = engine ? engine.current.rack : [];
  const used = usedRackIndices();
  for (let i = 0; i < RACK_SIZE; i++) {
    const tile = rack[i];
    const slot = document.createElement("div");
    slot.setAttribute("data-touch-ignore", "");
    if (tile === undefined || used.has(i)) {
      // Empty slot (no tile, or tile currently placed tentatively).
      slot.className = "rtile rtile--empty";
      els.rack.appendChild(slot);
      continue;
    }
    if (hide) {
      // Hide the letter (face-down) during the opponent's / pass screens.
      slot.className = "rtile";
      slot.innerHTML = `<span class="tile__letter">?</span>`;
      els.rack.appendChild(slot);
      continue;
    }
    const isBlank = tile === "?";
    slot.className = "rtile" + (isBlank ? " rtile--blank" : "") +
      (selectedRack === i ? " rtile--selected" : "") +
      (exchangeMarks.has(i) ? " rtile--exchange" : "");
    const val = isBlank ? 0 : letterValue(tile);
    slot.innerHTML =
      `<span class="tile__letter">${isBlank ? " " : tile}</span>` +
      `<span class="tile__pts">${val}</span>`;
    slot.addEventListener("pointerdown", () => tapRack(i));
    els.rack.appendChild(slot);
  }
}

function playerName(i) {
  if (mode === "ai") return i === HUMAN ? "You" : "Computer";
  return `Player ${i + 1}`;
}

// ---- Status / overlay helpers ---------------------------------------------
function setStatus(text) { els.status.textContent = text; }

// Briefly show a message in the status line (e.g. an invalid-move reason).
let flashTimer = null;
function flash(msg) {
  setStatus(msg);
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (state === "playing") draw(); }, 2200);
}

function replayMsg() {
  return isTouchDevice() ? "Tap to play again" : "Press Enter for the menu";
}
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() {
  els.overlay.classList.add("overlay--hidden");
}
function hideAuxOverlays() {
  els.blankPick.classList.add("overlay--hidden");
  els.passScreen.classList.add("overlay--hidden");
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

  // Menu items: tappable as well as arrow/enter selectable.
  els.modeTwo.addEventListener("pointerdown", (e) => { e.preventDefault(); if (engine) startGame("two"); });
  els.modeAI.addEventListener("pointerdown", (e) => { e.preventDefault(); if (engine) startGame("ai"); });
  els.passReady.addEventListener("pointerdown", (e) => { e.preventDefault(); readyForTurn(); });

  // Action buttons.
  els.btnPlay.addEventListener("pointerdown", (e) => { e.preventDefault(); doPlay(); });
  els.btnRecall.addEventListener("pointerdown", (e) => { e.preventDefault(); recallAll(); });
  els.btnShuffle.addEventListener("pointerdown", (e) => { e.preventDefault(); doShuffle(); });
  els.btnExchange.addEventListener("pointerdown", (e) => { e.preventDefault(); toggleExchange(); });
  els.btnPass.addEventListener("pointerdown", (e) => { e.preventDefault(); doPass(); });

  // Keyboard letter typing + editing (meta layer alongside the intent stream).
  window.addEventListener("keydown", onTypeKey);

  els.mute.addEventListener("click", toggleMute);
  // Mute is a meta control (M key), handled outside the gameplay intent layer.
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });

  loadDictionary();
}

boot();
