// FreeCell for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the four free cells, the
// four foundations and the eight downward-fanning tableau columns, and drives the
// table flow (deal → tap-to-move → win, with a New Game restart). The engine owns
// all game logic, move legality and the supermove math; this file is input +
// render only.
//
// INTERACTION is tap-to-move (not drag — best for both touch and a TV remote):
//   • Tap a face-up card to SELECT it as the source. For a tableau card, the
//     selection grabs that card plus the valid descending alternating-colour run
//     beneath it.
//   • Tap a destination (a tableau column, a free cell or a foundation) to move
//     there if legal (multi-card tableau moves obey the supermove limit).
//   • Tapping the same source again, or an illegal target, deselects.
//   • Double-tap a card to auto-send it to a foundation if legal.
//
// KEYBOARD / REMOTE uses a cursor over 16 zones (left/right): the four free
// cells, the four foundations, then the eight tableau columns. Up/down adjusts
// the grabbed depth inside a tableau column. Enter selects a source, then places
// onto the cursor's zone.

import {
  Engine,
  SUIT_GLYPH,
  RED_SUITS,
  rankLabel,
  FREE_COUNT,
  FOUNDATION_COUNT,
  TABLEAU_COUNT,
} from "./engine.js?v=77450023-12b6-42df-bd2d-07c0642eb6d4";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=77450023-12b6-42df-bd2d-07c0642eb6d4";
import { mountButtons } from "../assets/js/shared/touch.js?v=77450023-12b6-42df-bd2d-07c0642eb6d4";
import { Sound } from "../assets/js/shared/sound.js?v=77450023-12b6-42df-bd2d-07c0642eb6d4";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  cells: document.getElementById("cells"),
  foundations: document.getElementById("foundations"),
  tableau: document.getElementById("tableau"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  controls: document.getElementById("controls"),
};

// ---- Zone model ----------------------------------------------------------
// The keyboard/remote cursor roams 16 zones laid out left→right:
//   free×4(0..3) foundation×4(4..7) tableau×8(8..15)
const ZONES = [];
for (let i = 0; i < FREE_COUNT; i++) ZONES.push({ type: "free", index: i });
for (let i = 0; i < FOUNDATION_COUNT; i++) ZONES.push({ type: "foundation", index: i });
for (let i = 0; i < TABLEAU_COUNT; i++) ZONES.push({ type: "tableau", index: i });

const FIRST_TABLEAU_ZONE = FREE_COUNT + FOUNDATION_COUNT; // 8

let cursorZone = FIRST_TABLEAU_ZONE; // start on the first tableau column
let cursorDepth = 0;                 // card index within a tableau column

// The current selection (the source of a pending move), or null. For a tableau
// source we remember the card index so the moving group is everything from there
// down; free/foundation sources move just their single card.
let selection = null; // { type: "tableau"|"free"|"foundation", index, cardIndex? }

let lastTap = { key: null, time: 0 }; // for double-tap-to-foundation detection
const DOUBLE_TAP_MS = 320;

// ---- DOM construction (cards) --------------------------------------------
// Build a single face-up card element. Every FreeCell card is face-up.
function makeCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.setAttribute("data-touch-ignore", "");
  const red = RED_SUITS.has(card.suit);
  el.classList.toggle("card--red", red);
  el.innerHTML =
    '<span class="card__corner card__corner--tl">' +
    `<span class="card__rank">${rankLabel(card.rank)}</span>` +
    `<span class="card__suit">${SUIT_GLYPH[card.suit]}</span></span>` +
    `<span class="card__pip">${SUIT_GLYPH[card.suit]}</span>`;
  el.setAttribute("aria-label", `${rankLabel(card.rank)} of ${suitName(card.suit)}`);
  return el;
}

function suitName(s) {
  return { S: "spades", H: "hearts", D: "diamonds", C: "clubs" }[s];
}

// Build the four free-cell + four foundation slots once (contents re-rendered
// each draw). Each slot owns its own tap.
const cellEls = [];
const foundationEls = [];
function buildSlots() {
  for (let i = 0; i < FREE_COUNT; i++) {
    const slot = document.createElement("div");
    slot.className = "pile pile--free";
    slot.setAttribute("data-touch-ignore", "");
    slot.setAttribute("aria-label", `Free cell ${i + 1}`);
    slot.addEventListener("pointerdown", (e) => { e.preventDefault(); tapFree(i); });
    els.cells.appendChild(slot);
    cellEls.push(slot);
  }
  for (let i = 0; i < FOUNDATION_COUNT; i++) {
    const slot = document.createElement("div");
    slot.className = "pile pile--foundation";
    slot.setAttribute("data-touch-ignore", "");
    slot.setAttribute("aria-label", `Foundation ${i + 1}`);
    slot.addEventListener("pointerdown", (e) => { e.preventDefault(); tapFoundation(i); });
    els.foundations.appendChild(slot);
    foundationEls.push(slot);
  }
}

// ---- Tap handlers --------------------------------------------------------
// Free cell: place the selected source here, or select the cell's card to move.
function tapFree(i) {
  sound.resume();
  if (selection) {
    if (tryPlaceOnFree(i)) return;
    if (selection.type === "free" && selection.index === i) { clearSelection(); draw(); return; }
    clearSelection();
    draw();
    return;
  }
  if (engine.free[i] == null) return;
  selection = { type: "free", index: i };
  cursorZone = i;
  draw();
}

// Foundation: place the selected source here, or select its top card (to move it
// back down to a tableau column).
function tapFoundation(i) {
  sound.resume();
  if (selection) {
    if (tryPlaceOnFoundation(i)) return;
    if (selection.type === "foundation" && selection.index === i) { clearSelection(); draw(); return; }
    clearSelection();
    draw();
    return;
  }
  if (engine.foundations[i].length === 0) return;
  selection = { type: "foundation", index: i };
  cursorZone = FREE_COUNT + i;
  draw();
}

// Tableau card / column tap. cardIndex is the depth tapped (or 0 for an empty
// column tapped on its slot).
function tapTableau(colIndex, cardIndex) {
  sound.resume();
  const col = engine.cols[colIndex];

  // Double-tap the bottom card → auto-send to a foundation if legal.
  const tapKey = `t${colIndex}:${cardIndex}`;
  const nowMs = performance.now();
  const isBottom = cardIndex === col.length - 1;
  if (
    isBottom &&
    col.length > 0 &&
    lastTap.key === tapKey &&
    nowMs - lastTap.time < DOUBLE_TAP_MS
  ) {
    lastTap = { key: null, time: 0 };
    if (autoToFoundation("tableau", colIndex)) return;
  }
  lastTap = { key: tapKey, time: nowMs };

  if (selection) {
    // A source is chosen: this column is a destination.
    if (tryPlaceOnTableau(colIndex)) return;
    clearSelection();
    draw();
    return;
  }

  // No source yet: select this card and the run beneath it.
  if (col.length === 0) return;
  if (!engine.isValidRun(colIndex, cardIndex)) {
    setStatus("That run isn't a movable sequence");
    return;
  }
  selection = { type: "tableau", index: colIndex, cardIndex };
  cursorZone = FIRST_TABLEAU_ZONE + colIndex;
  cursorDepth = cardIndex;
  draw();
}

// ---- Move attempts -------------------------------------------------------
function tryPlaceOnTableau(toCol) {
  let ok = false;
  if (selection.type === "tableau") {
    ok = engine.moveTableauToTableau(selection.index, selection.cardIndex, toCol);
  } else if (selection.type === "free") {
    ok = engine.moveFreeToTableau(selection.index, toCol);
  } else if (selection.type === "foundation") {
    ok = engine.moveFoundationToTableau(selection.index, toCol);
  }
  if (ok) {
    sound.lock();
    clearSelection();
    afterMove();
    return true;
  }
  invalid();
  return false;
}

function tryPlaceOnFoundation(toFoundation) {
  let ok = false;
  if (selection.type === "tableau") {
    // Only a single bottom card can go to a foundation.
    const col = engine.cols[selection.index];
    if (selection.cardIndex === col.length - 1) {
      ok = engine.moveTableauToFoundation(selection.index, toFoundation);
    }
  } else if (selection.type === "free") {
    ok = engine.moveFreeToFoundation(selection.index, toFoundation);
  }
  if (ok) {
    sound.clear(1);
    clearSelection();
    afterMove();
    return true;
  }
  invalid();
  return false;
}

function tryPlaceOnFree(toCell) {
  let ok = false;
  if (selection.type === "tableau") {
    // Only a single bottom card can go to a free cell.
    const col = engine.cols[selection.index];
    if (selection.cardIndex === col.length - 1) {
      ok = engine.moveTableauToFree(selection.index, toCell);
    }
  } else if (selection.type === "free") {
    ok = engine.moveFreeToFree(selection.index, toCell);
  } else if (selection.type === "foundation") {
    ok = engine.moveFoundationToFree(selection.index, toCell);
  }
  if (ok) {
    sound.move();
    clearSelection();
    afterMove();
    return true;
  }
  invalid();
  return false;
}

// Auto-send a source card to the first foundation that accepts it.
function autoToFoundation(type, index) {
  for (let f = 0; f < FOUNDATION_COUNT; f++) {
    let ok = false;
    if (type === "tableau") ok = engine.moveTableauToFoundation(index, f);
    else if (type === "free") ok = engine.moveFreeToFoundation(index, f);
    if (ok) {
      sound.clear(1);
      clearSelection();
      afterMove();
      return true;
    }
  }
  return false;
}

// A move was attempted but rejected.
function invalid() {
  sound.drop();
}

// Shared post-move bookkeeping: re-render and check for a win.
function afterMove() {
  draw();
  if (engine.isWon()) {
    sound.levelUp();
    showOverlay("You win!", winMsg());
    setStatus("Solved!");
  }
}

function clearSelection() {
  selection = null;
}

// ---- Keyboard / remote: cursor + Enter -----------------------------------
function moveCursor(delta) {
  cursorZone = (cursorZone + delta + ZONES.length) % ZONES.length;
  // Land the depth cursor on the bottom card of a tableau column by default.
  const z = ZONES[cursorZone];
  if (z.type === "tableau") cursorDepth = Math.max(0, engine.cols[z.index].length - 1);
  draw();
}

// Up/down only meaningful inside a tableau column: pick which card (and thus how
// big a run) the cursor grabs.
function moveDepth(delta) {
  const z = ZONES[cursorZone];
  if (z.type !== "tableau") return;
  const col = engine.cols[z.index];
  if (col.length === 0) return;
  cursorDepth = Math.min(col.length - 1, Math.max(0, cursorDepth + delta));
  draw();
}

// Enter at the cursor: select a source, or place the pending source here.
function activateCursor() {
  const z = ZONES[cursorZone];
  if (z.type === "free") { tapFree(z.index); return; }
  if (z.type === "foundation") { tapFoundation(z.index); return; }
  if (z.type === "tableau") {
    const col = engine.cols[z.index];
    const idx = col.length === 0 ? 0 : Math.min(cursorDepth, col.length - 1);
    tapTableau(z.index, idx);
  }
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  switch (intent) {
    case "left": moveCursor(-1); break;
    case "right": moveCursor(1); break;
    case "up": moveDepth(-1); break;
    case "down": moveDepth(1); break;
    case "enter": activateCursor(); break;
  }
});

// ---- Rendering ------------------------------------------------------------
function draw() {
  setStatusScore();

  // Free cells.
  for (let i = 0; i < FREE_COUNT; i++) {
    const slot = cellEls[i];
    slot.innerHTML = "";
    const card = engine.free[i];
    slot.classList.toggle("pile--filled", card != null);
    slot.classList.toggle("pile--cursor", isCursor("free", i));
    slot.classList.toggle("pile--target", !!selection && card == null && legalFreeTarget(i));
    if (card != null) {
      const el = makeCardEl(card);
      el.classList.toggle("card--selected", selection && selection.type === "free" && selection.index === i);
      slot.appendChild(el);
    }
  }

  // Foundations.
  for (let i = 0; i < FOUNDATION_COUNT; i++) {
    const slot = foundationEls[i];
    slot.innerHTML = "";
    const f = engine.foundations[i];
    slot.classList.toggle("pile--filled", f.length > 0);
    slot.classList.toggle("pile--cursor", isCursor("foundation", i));
    slot.classList.toggle("pile--target", !!selection && legalFoundationTarget(i));
    if (f.length > 0) {
      const el = makeCardEl(f[f.length - 1]);
      el.classList.toggle("card--selected", selection && selection.type === "foundation" && selection.index === i);
      slot.appendChild(el);
    }
  }

  // Tableau columns: fan downward, overlapping.
  els.tableau.innerHTML = "";
  for (let p = 0; p < TABLEAU_COUNT; p++) {
    const colEl = document.createElement("div");
    colEl.className = "pile pile--tableau";
    colEl.setAttribute("data-touch-ignore", "");
    colEl.setAttribute("aria-label", `Tableau column ${p + 1}`);
    const col = engine.cols[p];

    if (col.length === 0) {
      colEl.classList.add("pile--empty");
      if (isCursor("tableau", p)) colEl.classList.add("pile--cursor");
      if (selection && legalTableauTarget(p)) colEl.classList.add("pile--target");
      colEl.addEventListener("pointerdown", (e) => { e.preventDefault(); tapTableau(p, 0); });
      els.tableau.appendChild(colEl);
      continue;
    }

    if (selection && legalTableauTarget(p)) colEl.classList.add("pile--target");

    col.forEach((card, c) => {
      const el = makeCardEl(card);
      el.classList.add("card--fan");
      // Highlight the whole selected group on the source column.
      const inSelection =
        selection && selection.type === "tableau" && selection.index === p && c >= selection.cardIndex;
      el.classList.toggle("card--selected", !!inSelection);
      // Keyboard cursor ring on the targeted depth.
      const cursorHere = isCursor("tableau", p) && c === Math.min(cursorDepth, col.length - 1);
      el.classList.toggle("card--cursor", cursorHere);
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); tapTableau(p, c); });
      colEl.appendChild(el);
    });
    els.tableau.appendChild(colEl);
  }
}

function isCursor(type, index) {
  const z = ZONES[cursorZone];
  return z.type === type && z.index === index;
}

// ---- Legal-destination hints (mirror the engine's would-be move) ----------
function selectedCard() {
  if (!selection) return null;
  if (selection.type === "tableau") {
    return engine.cols[selection.index][selection.cardIndex] || null;
  }
  if (selection.type === "free") return engine.free[selection.index];
  if (selection.type === "foundation") {
    const f = engine.foundations[selection.index];
    return f[f.length - 1] || null;
  }
  return null;
}

function isSingleSelection() {
  if (!selection) return false;
  if (selection.type !== "tableau") return true;
  const col = engine.cols[selection.index];
  return selection.cardIndex === col.length - 1;
}

function legalTableauTarget(toCol) {
  if (!selection) return false;
  if (selection.type === "tableau") {
    if (selection.index === toCol) return false;
    const card = selectedCard();
    if (!card || !engine.canToTableau(card, toCol)) return false;
    const runLen = engine.cols[selection.index].length - selection.cardIndex;
    return runLen <= engine.maxSupermove(engine.cols[toCol].length === 0);
  }
  const card = selectedCard();
  return !!card && engine.canToTableau(card, toCol);
}

function legalFoundationTarget(i) {
  if (!selection || !isSingleSelection() || selection.type === "foundation") return false;
  const card = selectedCard();
  return !!card && engine.canToFoundation(card, i);
}

function legalFreeTarget(i) {
  if (!selection || !isSingleSelection()) return false;
  if (selection.type === "free" && selection.index === i) return false;
  return engine.canToFree(i);
}

// ---- Status --------------------------------------------------------------
function setStatusScore() {
  if (engine.isWon()) return;
  const base = `Moves ${engine.moves}`;
  if (selection) setStatus(`${base} — pick a destination`);
  else setStatus(base);
}
function setStatus(text) {
  els.status.textContent = text;
}

// ---- Copy helpers (touch vs keyboard) ------------------------------------
function winMsg() {
  return isTouchDevice() ? "Tap New Game to deal again" : "Press <kbd>N</kbd> for a new game";
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

// ---- New game ------------------------------------------------------------
function newGame() {
  sound.resume();
  sound.start();
  engine.reset();
  clearSelection();
  cursorZone = FIRST_TABLEAU_ZONE;
  cursorDepth = 0;
  hideOverlay();
  setStatus(isTouchDevice() ? "Tap a card to move it" : "Move the cursor, Enter to select");
  draw();
}

// ---- Mute control (meta, deliberately outside the gameplay intent layer) ---
function toggleMute() {
  sound.toggleMute();
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}

// ---- Boot -----------------------------------------------------------------
function boot() {
  buildSlots();

  mountButtons(els.controls, input, [
    { label: "New Game", onPress: newGame, ariaLabel: "Deal a new game", className: "ctl ctl--primary" },
  ]);

  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
    else if (e.key === "n" || e.key === "N") newGame();
  });

  setStatus(isTouchDevice() ? "Tap a card to move it" : "Move the cursor, Enter to select");
  draw();
}

boot();
