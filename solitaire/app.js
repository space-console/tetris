// Klondike Solitaire for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the stock/waste, the
// four foundations and the seven downward-fanning tableau piles, and drives the
// table flow (deal → tap-to-move → win, with a New Game restart). The engine
// owns all game logic and move legality; this file is input + render only.
//
// INTERACTION is tap-to-move (not drag — best for both touch and a TV remote):
//   • Tap a face-up card to SELECT it as the source. The selected card plus any
//     cards stacked above it form the moving group (a valid descending,
//     alternating-colour sequence).
//   • Tap a destination pile/foundation to move there if the move is legal.
//   • Tapping the same source again, or an illegal target, deselects.
//   • Tap the stock to draw one card (or recycle the waste when empty).
//   • Double-tap a face-up card to auto-send it to a foundation if legal.
//
// KEYBOARD / REMOTE uses a cursor over 13 zones (left/right): stock, waste, the
// four foundations, then the seven tableau piles. Up/down picks the card depth
// inside a tableau pile. Enter selects a source, then places onto the cursor's
// zone.

import {
  Engine,
  SUIT_GLYPH,
  RED_SUITS,
  rankLabel,
  FOUNDATION_COUNT,
  TABLEAU_COUNT,
} from "./engine.js?v=8da4925f-0672-4ddd-8d28-35a61b56ed69";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=8da4925f-0672-4ddd-8d28-35a61b56ed69";
import { mountButtons } from "../assets/js/shared/touch.js?v=8da4925f-0672-4ddd-8d28-35a61b56ed69";
import { Sound } from "../assets/js/shared/sound.js?v=8da4925f-0672-4ddd-8d28-35a61b56ed69";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  stock: document.getElementById("stock"),
  waste: document.getElementById("waste"),
  foundations: document.getElementById("foundations"),
  tableau: document.getElementById("tableau"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
  controls: document.getElementById("controls"),
};

// ---- Zone model ----------------------------------------------------------
// The keyboard/remote cursor roams 13 zones laid out left→right. We address a
// zone by { type, index } and a card depth for tableau piles.
//   stock(0) waste(1) foundation×4(2..5) tableau×7(6..12)
const ZONES = [
  { type: "stock", index: 0 },
  { type: "waste", index: 0 },
];
for (let i = 0; i < FOUNDATION_COUNT; i++) ZONES.push({ type: "foundation", index: i });
for (let i = 0; i < TABLEAU_COUNT; i++) ZONES.push({ type: "tableau", index: i });

let cursorZone = 6;   // start on the first tableau pile
let cursorDepth = 0;  // card index within a tableau pile (clamped on render)

// The current selection (the source of a pending move), or null. For a tableau
// source we remember the card index so the moving group is everything from there
// up; waste/foundation sources move just their single top card.
let selection = null; // { type: "tableau"|"waste"|"foundation", index, cardIndex? }

let lastTap = { key: null, time: 0 }; // for double-tap-to-foundation detection
const DOUBLE_TAP_MS = 320;

// ---- DOM construction (once) ---------------------------------------------
// Build a single card element. Face-down cards show a patterned back.
function makeCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.setAttribute("data-touch-ignore", "");
  if (!card.faceUp) {
    el.classList.add("card--back");
    el.setAttribute("aria-label", "Face-down card");
    return el;
  }
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

// Build the four foundation slots once (we re-render their contents each draw).
const foundationEls = [];
function buildFoundations() {
  for (let i = 0; i < FOUNDATION_COUNT; i++) {
    const slot = document.createElement("div");
    slot.className = "pile pile--foundation";
    slot.setAttribute("data-touch-ignore", "");
    slot.setAttribute("aria-label", `Foundation ${i + 1}`);
    slot.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      tapFoundation(i);
    });
    els.foundations.appendChild(slot);
    foundationEls.push(slot);
  }
}

// ---- Tap handlers --------------------------------------------------------
// Stock: draw one card to the waste (or recycle when empty).
function tapStock() {
  sound.resume();
  clearSelection();
  const result = engine.drawFromStock();
  if (result) {
    sound.move();
    setStatus(result === "recycle" ? "Recycled the waste" : "Drew a card");
  }
  draw();
}

// Waste: select its top card as a source, or — if a source is already chosen —
// nothing (waste is never a destination). Tapping the selected waste deselects.
function tapWaste() {
  sound.resume();
  if (engine.waste.length === 0) return;
  if (selection && selection.type === "waste") { clearSelection(); draw(); return; }
  if (selection) { clearSelection(); draw(); return; } // waste isn't a valid target
  selection = { type: "waste", index: 0 };
  cursorZone = 1;
  draw();
}

// Foundation: if a source is selected, try to place onto it; otherwise select
// the foundation's top card as a source (to move it back down).
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
  cursorZone = 2 + i;
  draw();
}

// Tableau card / pile tap. cardIndex is the card depth tapped (or the pile's
// length for an empty-pile tap on the slot itself).
function tapTableau(pileIndex, cardIndex) {
  sound.resume();
  const pile = engine.tableau[pileIndex];

  // Double-tap a face-up card → auto-send to a foundation if legal.
  const tapKey = `t${pileIndex}:${cardIndex}`;
  const nowMs = performance.now();
  const isTop = cardIndex === pile.length - 1;
  if (
    isTop &&
    pile.length > 0 &&
    pile[cardIndex].faceUp &&
    lastTap.key === tapKey &&
    nowMs - lastTap.time < DOUBLE_TAP_MS
  ) {
    lastTap = { key: null, time: 0 };
    if (autoToFoundation("tableau", pileIndex)) return;
  }
  lastTap = { key: tapKey, time: nowMs };

  if (selection) {
    // A source is chosen: this tableau pile is a destination.
    if (tryPlaceOnTableau(pileIndex)) return;
    // Re-selecting the very same card deselects; any other illegal target just
    // clears the selection (re-selecting a new source needs a second tap).
    clearSelection();
    draw();
    return;
  }

  // No source yet: select this face-up card (and the run above it) as the source.
  if (pile.length === 0) return;
  if (!pile[cardIndex].faceUp) return;
  if (!engine.isValidSequence(pileIndex, cardIndex)) {
    setStatus("That run isn't a movable sequence");
    return;
  }
  selection = { type: "tableau", index: pileIndex, cardIndex };
  cursorZone = 6 + pileIndex;
  cursorDepth = cardIndex;
  draw();
}

// ---- Move attempts -------------------------------------------------------
function tryPlaceOnTableau(toPile) {
  let ok = false;
  if (selection.type === "tableau") {
    ok = engine.moveTableauToTableau(selection.index, selection.cardIndex, toPile);
  } else if (selection.type === "waste") {
    ok = engine.moveWasteToTableau(toPile);
  } else if (selection.type === "foundation") {
    ok = engine.moveFoundationToTableau(selection.index, toPile);
  }
  if (ok) {
    sound.lock();
    clearSelection();
    afterMove();
    return true;
  }
  return false;
}

function tryPlaceOnFoundation(toFoundation) {
  let ok = false;
  if (selection.type === "tableau") {
    // Only a single top card can go to a foundation.
    const pile = engine.tableau[selection.index];
    if (selection.cardIndex === pile.length - 1) {
      ok = engine.moveTableauToFoundation(selection.index, toFoundation);
    }
  } else if (selection.type === "waste") {
    ok = engine.moveWasteToFoundation(toFoundation);
  }
  if (ok) {
    sound.clear(1);
    clearSelection();
    afterMove();
    return true;
  }
  return false;
}

// Auto-send the top card of a source to the first foundation that accepts it.
function autoToFoundation(type, index) {
  for (let f = 0; f < FOUNDATION_COUNT; f++) {
    let ok = false;
    if (type === "tableau") ok = engine.moveTableauToFoundation(index, f);
    else if (type === "waste") ok = engine.moveWasteToFoundation(f);
    if (ok) {
      sound.clear(1);
      clearSelection();
      afterMove();
      return true;
    }
  }
  return false;
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
  // Land the depth cursor on the top card of a tableau pile by default.
  const z = ZONES[cursorZone];
  if (z.type === "tableau") cursorDepth = Math.max(0, engine.tableau[z.index].length - 1);
  draw();
}

// Up/down only meaningful inside a tableau pile: pick which card (and thus how
// big a sequence) the cursor points at.
function moveDepth(delta) {
  const z = ZONES[cursorZone];
  if (z.type !== "tableau") return;
  const pile = engine.tableau[z.index];
  if (pile.length === 0) return;
  cursorDepth = Math.min(pile.length - 1, Math.max(0, cursorDepth + delta));
  draw();
}

// Enter at the cursor: select a source, or place the pending source here.
function activateCursor() {
  const z = ZONES[cursorZone];
  if (z.type === "stock") { tapStock(); return; }
  if (z.type === "waste") { tapWaste(); return; }
  if (z.type === "foundation") { tapFoundation(z.index); return; }
  if (z.type === "tableau") {
    const pile = engine.tableau[z.index];
    const idx = pile.length === 0 ? 0 : Math.min(cursorDepth, pile.length - 1);
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

  // Stock: a back if it has cards, a recycle hint if empty.
  els.stock.innerHTML = "";
  els.stock.classList.toggle("pile--cursor", isCursor("stock", 0));
  if (engine.stock.length > 0) {
    els.stock.appendChild(makeCardEl({ faceUp: false }));
    els.stock.classList.remove("pile--recycle");
  } else {
    els.stock.classList.add("pile--recycle");
  }

  // Waste: top card face-up (if any). The waste slot itself owns the tap (bound
  // once in boot), so an empty waste is still tappable to deselect.
  els.waste.innerHTML = "";
  els.waste.classList.toggle("pile--cursor", isCursor("waste", 0));
  if (engine.waste.length > 0) {
    const top = engine.waste[engine.waste.length - 1];
    const el = makeCardEl(top);
    el.classList.toggle("card--selected", selection && selection.type === "waste");
    els.waste.appendChild(el);
  }

  // Foundations.
  for (let i = 0; i < FOUNDATION_COUNT; i++) {
    const slot = foundationEls[i];
    slot.innerHTML = "";
    slot.classList.toggle("pile--cursor", isCursor("foundation", i));
    const f = engine.foundations[i];
    if (f.length > 0) {
      const el = makeCardEl(f[f.length - 1]);
      el.classList.toggle("card--selected", selection && selection.type === "foundation" && selection.index === i);
      slot.appendChild(el);
    }
  }

  // Tableau piles: fan downward, overlapping; clicking a card moves the cursor.
  els.tableau.innerHTML = "";
  for (let p = 0; p < TABLEAU_COUNT; p++) {
    const pileEl = document.createElement("div");
    pileEl.className = "pile pile--tableau";
    pileEl.setAttribute("data-touch-ignore", "");
    pileEl.setAttribute("aria-label", `Tableau pile ${p + 1}`);
    const pile = engine.tableau[p];

    // Empty pile: a tappable placeholder slot (a King can land here).
    if (pile.length === 0) {
      pileEl.classList.add("pile--empty");
      if (isCursor("tableau", p)) pileEl.classList.add("pile--cursor");
      pileEl.addEventListener("pointerdown", (e) => { e.preventDefault(); tapTableau(p, 0); });
      els.tableau.appendChild(pileEl);
      continue;
    }

    pile.forEach((card, c) => {
      const el = makeCardEl(card);
      el.classList.add("card--fan");
      // Highlight the whole selected group on the source pile.
      const inSelection =
        selection && selection.type === "tableau" && selection.index === p && c >= selection.cardIndex;
      el.classList.toggle("card--selected", !!inSelection);
      // Keyboard cursor ring sits on the targeted card depth.
      const cursorHere = isCursor("tableau", p) && c === Math.min(cursorDepth, pile.length - 1);
      el.classList.toggle("card--cursor", cursorHere);
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); tapTableau(p, c); });
      pileEl.appendChild(el);
    });
    els.tableau.appendChild(pileEl);
  }
}

function isCursor(type, index) {
  const z = ZONES[cursorZone];
  return z.type === type && z.index === index;
}

// ---- Status / score ------------------------------------------------------
function setStatusScore() {
  if (engine.isWon()) return;
  const base = `Moves ${engine.moves} · Score ${engine.score}`;
  if (selection) {
    setStatus(`${base} — pick a destination`);
  } else {
    setStatus(base);
  }
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
  cursorZone = 6;
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
  buildFoundations();

  // Stock and waste slots own their taps (bound once; contents re-render).
  els.stock.addEventListener("pointerdown", (e) => { e.preventDefault(); tapStock(); });
  els.waste.addEventListener("pointerdown", (e) => { e.preventDefault(); tapWaste(); });

  // Always-visible primary controls (also feed the keyboard actions).
  mountButtons(els.controls, input, [
    { label: "Draw", onPress: tapStock, ariaLabel: "Draw from stock", className: "ctl" },
    { label: "New Game", onPress: newGame, ariaLabel: "Deal a new game", className: "ctl ctl--primary" },
  ]);

  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
    else if (e.key === "d" || e.key === "D") tapStock();
    else if (e.key === "n" || e.key === "N") newGame();
  });

  setStatus(isTouchDevice() ? "Tap a card to move it" : "Move the cursor, Enter to select");
  draw();
}

boot();
