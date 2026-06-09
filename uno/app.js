// Uno for Space Console — entry point.
// Wires the shared intent stream + always-visible controls to the pure Uno
// engine, renders the table (three AI bots, the discard/stock pile, your hand),
// drives the bots on a short timer with a running status line, and runs the
// colour chooser for wilds. The engine owns all the rules; this file is input +
// render + the simple AI.
//
// Rule simplifications (documented):
//   - Starting card: if the turned-up stock card is a Wild or any action card,
//     we bury it and turn another, so every round opens on a plain number with
//     nothing to resolve (engine.reset()).
//   - Wild Draw Four is playable at any time — we drop the official "only when
//     you hold no card matching the active colour" challenge rule, since there
//     is no challenge mechanic here.
//   - No "Uno!" call: a player simply wins by emptying their hand; there is no
//     missed-call penalty to handle.

import {
  Engine,
  COLORS,
  VALUE_GLYPH,
  PLAYER_NAMES,
  cardName,
} from "./engine.js?v=2f1a10a6-2493-4ae8-b2e2-30fc078e9638";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=2f1a10a6-2493-4ae8-b2e2-30fc078e9638";
import { Sound } from "../assets/js/shared/sound.js?v=2f1a10a6-2493-4ae8-b2e2-30fc078e9638";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  bots: document.getElementById("bots"),
  discard: document.getElementById("discard"),
  stock: document.getElementById("stock"),
  stockCount: document.getElementById("stockCount"),
  dir: document.getElementById("dir"),
  you: document.getElementById("you"),
  actions: document.getElementById("actions"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  chooser: document.getElementById("chooser"),
  mute: document.getElementById("mute"),
};

// idle | playing | choosing | over.
//   idle     — start overlay up, nothing dealt yet (or after a win)
//   playing  — a round is live; we follow engine.turn
//   choosing — the human played a wild and must pick a colour (overlay chooser)
//   over     — a winner exists; "New game" restarts
let state = "idle";
let cursor = 0;            // index into your hand the keyboard/remote cursor hovers
let botTimer = null;
let pendingWildIndex = null; // hand index of the wild the human is colouring

// ---- Game flow ------------------------------------------------------------
function startGame() {
  sound.resume();        // first interaction unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  state = "playing";
  cursor = 0;
  clampCursor();
  hideOverlay();
  hideChooser();
  render();
  scheduleTurn();
}

// Drive whichever seat is to act: bots act on a short delay; the human waits for
// a card tap / key. A finished round goes to the win overlay.
function scheduleTurn() {
  clearTimeout(botTimer);
  if (state !== "playing") return;

  if (engine.winner !== null) {
    onWin();
    return;
  }

  const seat = engine.turn;
  if (seat === 0) {
    // Human's turn: render and wait for input.
    cursor = preferredCursor();
    render();
    setStatus(humanStatus());
    return;
  }

  // Bot: think briefly, then act, then continue.
  render();
  setStatus(`${PLAYER_NAMES[seat]} is thinking…`);
  botTimer = setTimeout(() => {
    if (state !== "playing") return;
    botAct(seat);
    render();
    scheduleTurn();
  }, 750);
}

// ---- AI -------------------------------------------------------------------
// A light heuristic: play if you can, preferring to shed action/wild cards and
// keep numbers; choose the colour you hold most of for wilds. Otherwise draw,
// then play the drawn card if it became legal.
function botAct(seat) {
  const playable = engine.playableIndices(seat);

  if (playable.length === 0) {
    // Must draw, then maybe play the drawn card.
    engine.drawCard();
    sound.move();
    setStatus(`${PLAYER_NAMES[seat]} draws`);
    if (engine.canPlayDrawn()) {
      const i = engine.hands[seat].length - 1; // the drawn card sits at the end
      playFor(seat, i);
    } else {
      engine.passTurn();
    }
    return;
  }

  // Pick a card: prefer action cards (skip/reverse/draw2), then numbers, and
  // save wilds for when nothing else is playable.
  const idx = chooseBotCard(seat, playable);
  playFor(seat, idx);
}

// Rank playable cards: coloured action > coloured number > wild draw four >
// wild. This sheds disruptive cards first and hoards flexible wilds.
function chooseBotCard(seat, playable) {
  const hand = engine.hands[seat];
  const score = (card) => {
    if (card.value === "wild") return 0;          // keep plain wilds for last
    if (card.value === "wild4") return 1;
    if (["skip", "reverse", "draw2"].includes(card.value)) return 3;
    return 2;                                       // plain numbers
  };
  let best = playable[0];
  for (const i of playable) {
    if (score(hand[i]) > score(hand[best])) best = i;
  }
  return best;
}

// The colour a bot picks for a wild: whichever (non-wild) colour it holds most.
// Falls back to a random colour if it holds only wilds.
function botColor(seat) {
  const counts = { red: 0, yellow: 0, green: 0, blue: 0 };
  for (const c of engine.hands[seat]) {
    if (c.color !== "wild") counts[c.color]++;
  }
  let best = COLORS[Math.floor(Math.random() * COLORS.length)];
  let max = -1;
  for (const c of COLORS) {
    if (counts[c] > max) { max = counts[c]; best = c; }
  }
  return best;
}

// Play a card for any seat, choosing a wild colour automatically for bots,
// emit the right sound, and announce it on the status line.
function playFor(seat, i) {
  const card = engine.hands[seat][i];
  const isWild = card.color === "wild";
  const color = isWild ? botColor(seat) : null;
  const result = engine.play(i, color);
  if (!result) return;
  announcePlay(seat, result, color);
  playSoundFor(result);
}

// Apply a human card play at hand index `i`. Wilds open the colour chooser
// instead of resolving immediately.
function humanPlay(i) {
  if (state !== "playing" || engine.turn !== 0) return;
  const card = engine.hands[0][i];
  if (!card) return;
  // Standard Uno: once you've drawn, you may only play that drawn card (or Pass).
  if (engine.lastDrawn != null && card !== engine.lastDrawn) {
    setStatus("After drawing, play the drawn card or Pass");
    return;
  }
  if (engine.playableIndices(0).indexOf(i) === -1) {
    setStatus("That card can't be played");
    return;
  }
  if (card.color === "wild") {
    pendingWildIndex = i;
    openChooser();
    return;
  }
  const result = engine.play(i);
  if (!result) return;
  announcePlay(0, result, null);
  playSoundFor(result);
  afterHumanMove();
}

// Resolve a wild after the human picks a colour.
function finishWild(color) {
  if (pendingWildIndex == null) return;
  const i = pendingWildIndex;
  pendingWildIndex = null;
  const result = engine.play(i, color);
  hideChooser();
  hideOverlay();
  state = "playing";
  if (!result) { scheduleTurn(); return; }
  announcePlay(0, result, color);
  playSoundFor(result);
  afterHumanMove();
}

// The human chose to draw. Draw one; if it's playable, leave it for them to
// play (the drawn card highlights); otherwise pass automatically.
function humanDraw() {
  if (state !== "playing" || engine.turn !== 0) return;
  engine.drawCard();
  sound.move();
  cursor = engine.hands[0].length - 1; // hover the freshly drawn card
  if (engine.canPlayDrawn()) {
    setStatus(`You drew ${cardName(engine.lastDrawn)} — play it or pass`);
    render();
  } else {
    setStatus(`You drew ${cardName(engine.lastDrawn)} — no play, passing`);
    engine.passTurn();
    afterHumanMove();
  }
}

// Pass after drawing an unplayable (or unwanted) card.
function humanPass() {
  if (state !== "playing" || engine.turn !== 0) return;
  if (engine.lastDrawn == null) return; // can only pass right after drawing
  engine.passTurn();
  afterHumanMove();
}

// Common tail after any human move: check for a win, else continue the loop.
function afterHumanMove() {
  cursor = preferredCursor();
  render();
  if (engine.winner !== null) { onWin(); return; }
  scheduleTurn();
}

function onWin() {
  state = "over";
  clearTimeout(botTimer);
  const seat = engine.winner;
  sound.levelUp();
  render();
  const title = seat === 0 ? "You win!" : `${PLAYER_NAMES[seat]} wins`;
  showOverlay(title, restartMsg());
  setStatus(title);
}

// ---- Announcements + sound -------------------------------------------------
function announcePlay(seat, result, color) {
  const who = PLAYER_NAMES[seat];
  let msg = `${who} plays ${cardName(result.card)}`;
  if (result.card.color === "wild" && color) {
    msg += ` → ${color[0].toUpperCase()}${color.slice(1)}`;
  }
  if (result.drawCount > 0 && result.drewSeat != null) {
    msg += ` · ${PLAYER_NAMES[result.drewSeat]} draws ${result.drawCount}`;
  } else if (result.effect === "skip") {
    msg += " · skip";
  } else if (result.effect === "reverse") {
    msg += " · reverse";
  }
  setStatus(msg);
}

function playSoundFor(result) {
  // Action cards (skip/reverse/draw effects) get the "rotate" blip; plain plays
  // get the "lock" blip.
  if (["skip", "reverse", "draw2", "wild4"].includes(result.effect)) {
    sound.rotate();
  } else {
    sound.lock();
  }
}

// ---- Input ----------------------------------------------------------------
input.on((intent) => {
  // Meta: Back always exits to the hub.
  if (intent === "back") { location.href = "../"; return; }

  // Colour chooser captures left/right/enter while it's open.
  if (state === "choosing") {
    handleChooserIntent(intent);
    return;
  }

  if (state === "idle" || state === "over") {
    if (intent === "enter") startGame();
    return;
  }

  // Playing: only the human's turn is interactive.
  if (state !== "playing" || engine.turn !== 0) return;

  const hand = engine.hands[0];
  switch (intent) {
    case "left":
      cursor = (cursor + hand.length - 1) % hand.length;
      render();
      break;
    case "right":
      cursor = (cursor + 1) % hand.length;
      render();
      break;
    case "up":
      // Up = draw (a discoverable shortcut alongside the Draw button / D key).
      humanDraw();
      break;
    case "enter":
      humanPlay(cursor);
      break;
  }
});

// ---- Colour chooser -------------------------------------------------------
let chooserButtons = [];
let chooserSel = 0;

function openChooser() {
  state = "choosing";
  chooserSel = 0;
  buildChooser();
  els.overlayTitle.textContent = "Choose a colour";
  els.overlayMsg.textContent = isTouchDevice()
    ? "Tap a colour for your wild"
    : "← → then Enter to pick a colour";
  els.overlay.classList.remove("overlay--hidden");
  els.chooser.classList.add("chooser--open");
  highlightChooser();
}

function buildChooser() {
  els.chooser.innerHTML = "";
  chooserButtons = [];
  COLORS.forEach((color, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `chooser__swatch chooser__swatch--${color}`;
    b.setAttribute("data-touch-ignore", "");
    b.setAttribute("aria-label", color);
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      chooserSel = i;
      finishWild(color);
    });
    els.chooser.appendChild(b);
    chooserButtons.push(b);
  });
}

function handleChooserIntent(intent) {
  switch (intent) {
    case "left":
      chooserSel = (chooserSel + COLORS.length - 1) % COLORS.length;
      highlightChooser();
      break;
    case "right":
      chooserSel = (chooserSel + 1) % COLORS.length;
      highlightChooser();
      break;
    case "enter":
      finishWild(COLORS[chooserSel]);
      break;
  }
}

function highlightChooser() {
  chooserButtons.forEach((b, i) => {
    b.classList.toggle("chooser__swatch--sel", i === chooserSel);
  });
}

function hideChooser() {
  els.chooser.classList.remove("chooser--open");
}

// ---- Rendering ------------------------------------------------------------
function render() {
  renderBots();
  renderPile();
  renderHand();
  renderActions();
}

// Build a single card chip element for a face-up card.
function cardChip(card, { small = false } = {}) {
  const el = document.createElement("div");
  el.className = "chip chip--" + card.color;
  if (small) el.classList.add("chip--small");
  if (card.color === "wild") {
    // Wilds show four colour quadrants behind the glyph.
    el.classList.add("chip--wild");
    const quad = document.createElement("div");
    quad.className = "chip__quad";
    el.appendChild(quad);
  }
  const face = document.createElement("span");
  face.className = "chip__face";
  face.textContent = VALUE_GLYPH[card.value] || card.value;
  el.appendChild(face);
  return el;
}

// A face-down card back (for opponents' hands).
function cardBack({ small = false } = {}) {
  const el = document.createElement("div");
  el.className = "chip chip--back";
  if (small) el.classList.add("chip--small");
  return el;
}

function renderBots() {
  els.bots.innerHTML = "";
  for (let seat = 1; seat <= 3; seat++) {
    const wrap = document.createElement("div");
    wrap.className = "bot";
    if (state === "playing" && engine.turn === seat) wrap.classList.add("bot--active");
    if (engine.winner === seat) wrap.classList.add("bot--winner");

    const name = document.createElement("div");
    name.className = "bot__name";
    name.textContent = PLAYER_NAMES[seat];

    const count = document.createElement("div");
    count.className = "bot__count";
    const n = engine.hands[seat].length;
    count.textContent = n + (n === 1 ? " card" : " cards");

    // A small fanned stack of card backs (capped so it never overflows).
    const fan = document.createElement("div");
    fan.className = "bot__fan";
    const show = Math.min(n, 7);
    for (let k = 0; k < show; k++) fan.appendChild(cardBack({ small: true }));

    wrap.append(name, count, fan);
    els.bots.appendChild(wrap);
  }
}

function renderPile() {
  els.stockCount.textContent = String(engine.stock.length);

  els.discard.innerHTML = "";
  const top = engine.top;
  const chip = cardChip(top);
  chip.classList.add("chip--top");
  els.discard.appendChild(chip);

  // A coloured ring around the discard shows the active colour (important after
  // a wild sets a colour that differs from the card's own face).
  els.discard.className = "discard discard--" + engine.activeColor;

  // Direction indicator.
  els.dir.textContent = engine.direction === 1 ? "↻ Clockwise" : "↺ Counter-clockwise";
}

function renderHand() {
  els.you.innerHTML = "";
  const hand = engine.hands[0];
  const myTurn = state === "playing" && engine.turn === 0;
  // After drawing, only the drawn card may be played, so highlight just that one.
  let playable = new Set();
  if (myTurn) {
    if (engine.lastDrawn != null) {
      const di = hand.indexOf(engine.lastDrawn);
      if (di >= 0 && engine.canPlayDrawn()) playable = new Set([di]);
    } else {
      playable = new Set(engine.playableIndices(0));
    }
  }

  hand.forEach((card, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "handcard";
    btn.setAttribute("data-touch-ignore", "");
    btn.setAttribute("aria-label", cardName(card));
    if (myTurn && playable.has(i)) btn.classList.add("handcard--playable");
    if (myTurn && !playable.has(i)) btn.classList.add("handcard--dim");
    if (myTurn && i === cursor) btn.classList.add("handcard--cursor");
    if (engine.lastDrawn && card === engine.lastDrawn) btn.classList.add("handcard--drawn");

    btn.appendChild(cardChip(card));
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (state === "over" || state === "idle") { startGame(); return; }
      if (!myTurn) return;
      cursor = i;
      humanPlay(i);
    });
    els.you.appendChild(btn);
  });
}

// Build the always-visible action bar: a Draw button, a Pass button (enabled
// only right after drawing), and a New Game button when a round is over.
function renderActions() {
  els.actions.innerHTML = "";
  const myTurn = state === "playing" && engine.turn === 0;

  if (state === "over" || state === "idle") {
    addActionButton("New Game", "abtn--primary", false, startGame);
    return;
  }

  addActionButton("Draw", "abtn--draw", !myTurn, humanDraw);
  // Pass is only meaningful after you've drawn and chosen not to play the card.
  const canPass = myTurn && engine.lastDrawn != null;
  addActionButton("Pass", "abtn--pass", !canPass, humanPass);
}

function addActionButton(label, className, disabled, onPress) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "abtn " + className;
  b.textContent = label;
  b.disabled = disabled;
  b.setAttribute("data-touch-ignore", "");
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (disabled) return;
    onPress();
  });
  els.actions.appendChild(b);
}

// ---- Cursor helpers -------------------------------------------------------
function clampCursor() {
  const n = engine.hands[0].length;
  if (n === 0) { cursor = 0; return; }
  cursor = Math.max(0, Math.min(cursor, n - 1));
}

// On the human's turn, prefer to land the cursor on a playable card.
function preferredCursor() {
  const n = engine.hands[0].length;
  if (n === 0) return 0;
  if (engine.turn !== 0) { return Math.min(cursor, n - 1); }
  const playable = engine.playableIndices(0);
  if (engine.lastDrawn) {
    const di = engine.hands[0].indexOf(engine.lastDrawn);
    if (di >= 0) return di;
  }
  if (playable.length && playable.indexOf(cursor) === -1) return playable[0];
  return Math.min(cursor, n - 1);
}

// ---- Copy helpers ---------------------------------------------------------
function humanStatus() {
  if (engine.lastDrawn != null) {
    return engine.canPlayDrawn()
      ? "Your turn — play the drawn card or Pass"
      : "Your turn";
  }
  return engine.hasPlayable(0)
    ? (isTouchDevice() ? "Your turn — tap a card to play" : "Your turn — pick a card")
    : (isTouchDevice() ? "No play — tap Draw" : "No play — press D to draw");
}
function restartMsg() {
  return isTouchDevice() ? "Tap New Game to play again" : "Press <kbd>Enter</kbd> to play again";
}
function startMsg() {
  return isTouchDevice() ? "Tap to start" : "Press <kbd>Enter</kbd> to start";
}

// ---- Overlay helpers ------------------------------------------------------
function showOverlay(title, msg) {
  hideChooser();
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
function toggleMute() { sound.toggleMute(); renderMute(); }

// ---- Boot -----------------------------------------------------------------
// Tapping the overlay (outside the chooser) starts / restarts a game.
els.overlay.addEventListener("pointerdown", (e) => {
  if (state === "choosing") return;     // chooser swatches handle their own taps
  if (e.target.closest(".chooser")) return;
  if (state === "idle" || state === "over") startGame();
});

// The central stock pile is also a Draw button.
els.stock.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (state === "playing" && engine.turn === 0) humanDraw();
});

function boot() {
  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
    else if ((e.key === "d" || e.key === "D") && state === "playing" && engine.turn === 0) humanDraw();
  });

  render();
  setStatus(isTouchDevice() ? "Tap to start" : "Press Enter to start");
  showOverlay("Uno", startMsg());
}

boot();
