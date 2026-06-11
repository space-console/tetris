// Dominoes (Draw, double-six, You vs AI) for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the layout CHAIN (CSS
// pip tiles), your hand, the opponent's face-down count, the boneyard count, and
// the always-visible controls, and manages the turn flow (your move → AI move,
// with draw / pass and round-over restart). The engine owns all game logic; this
// file is input + render only.
//
// SETUP / RULES (see engine.js for the authoritative version):
//   * Double-six set (28 tiles), 7 dealt each, 14-tile boneyard.
//   * Opener = highest double (else heaviest single); they play first and set
//     both open ends. Turn then alternates.
//   * Play a tile whose half matches an open end; if you cannot, DRAW until you
//     can; with an empty boneyard and no move, PASS. Two passes in a row with an
//     empty boneyard = BLOCKED.
//   * Empty your hand → "domino!" win. Blocked → lower pip total wins (tie=draw).

import { Engine, legalMoves, isDouble, handPips, tileId } from "./engine.js?v=6d3a2e24-2deb-4c24-8209-124f5555ff77";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=6d3a2e24-2deb-4c24-8209-124f5555ff77";
import { mountButtons } from "../assets/js/shared/touch.js?v=6d3a2e24-2deb-4c24-8209-124f5555ff77";
import { Sound } from "../assets/js/shared/sound.js?v=6d3a2e24-2deb-4c24-8209-124f5555ff77";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  oppoCount: document.getElementById("oppoCount"),
  boneCount: document.getElementById("boneCount"),
  chain: document.getElementById("chain"),
  endL: document.getElementById("endL"),
  endR: document.getElementById("endR"),
  endLpip: document.getElementById("endLpip"),
  endRpip: document.getElementById("endRpip"),
  hand: document.getElementById("hand"),
  scoreYou: document.getElementById("scoreYou"),
  scoreAi: document.getElementById("scoreAi"),
  yourPips: document.getElementById("yourPips"),
  controls: document.getElementById("controls"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// UI state. The engine owns turns/over; we only track the player's cursor and
// the currently-selected hand tile awaiting an end choice.
let started = false;       // has the player begun the first round this session?
let cursor = 0;            // index into your hand for the keyboard/remote cursor
let selected = null;       // { tile, ends:[...] } selected tile awaiting an end
let aiTimer = null;        // pending AI step timer (so we can cancel on restart)
let drawBtn = null;
let passBtn = null;

// ---- CSS pip layouts (dice-style) ----------------------------------------
// For each value 0..6, which of the nine 3x3 grid cells are lit. Cell indices:
//   0 1 2
//   3 4 5
//   6 7 8
const PIP_CELLS = {
  0: [],
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

// Build one half (a 3x3 pip grid) showing `value` pips.
function buildHalf(value) {
  const half = document.createElement("span");
  half.className = "tile__half";
  const lit = new Set(PIP_CELLS[value]);
  for (let i = 0; i < 9; i++) {
    const pip = document.createElement("span");
    pip.className = lit.has(i) ? "tile__pip" : "tile__pip tile__pip--off";
    half.appendChild(pip);
  }
  return half;
}

// Build a full domino tile element from { a, b }. `topVal` is the half drawn
// first (top); in the chain we orient so the inner/outer faces read naturally,
// but for the hand we simply draw a on top, b below.
function buildTile(topVal, bottomVal, double) {
  const tile = document.createElement("span");
  tile.className = "tile" + (double ? " tile--double" : "");
  tile.appendChild(buildHalf(topVal));
  tile.appendChild(buildHalf(bottomVal));
  return tile;
}

// ---- Turn flow ------------------------------------------------------------
// After a human action that ends your turn, hand off to the AI (with a small
// delay so moves are visible), looping AI turns until it's your turn or over.
function endHumanTurn() {
  selected = null;
  engine.turn = "you" === engine.turn ? "ai" : "you";
  draw();
  scheduleAi();
}

function scheduleAi() {
  if (engine.over || engine.turn !== "ai") return;
  aiTimer = setTimeout(stepAi, 650);
}

// One AI step: draw until it can play (or boneyard empty), then play or pass.
function stepAi() {
  aiTimer = null;
  if (engine.over || engine.turn !== "ai") return;

  // Draw until the AI has a legal move or the boneyard runs dry.
  if (!engine.canPlayNow("ai") && engine.boneyard.length > 0) {
    engine.draw("ai");
    sound.move();
    draw();
    aiTimer = setTimeout(stepAi, 450); // keep drawing on a beat
    return;
  }

  const move = engine.aiChoice();
  if (move) {
    engine.play("ai", move.tile, move.end);
    sound.lock();
  } else {
    engine.pass("ai");
    sound.drop();
  }
  draw();

  if (engine.over) {
    finishRound();
    return;
  }
  // Hand back to you; if you are immediately blocked we surface Draw/Pass.
  engine.turn = "you";
  draw();
}

// Apply a human play of the selected tile onto end "L" or "R".
function playSelected(end) {
  if (!selected || engine.over || engine.turn !== "you") return;
  if (!selected.ends.includes(end)) return;
  engine.play("you", selected.tile, end);
  sound.lock();
  if (engine.over) {
    selected = null;
    draw();
    finishRound();
    return;
  }
  endHumanTurn();
}

function humanDraw() {
  if (engine.over || engine.turn !== "you") return;
  if (engine.canPlayNow("you")) return;        // only draw when you can't play
  if (engine.boneyard.length === 0) return;    // nothing to draw
  engine.draw("you");
  sound.move();
  selected = null;
  // Cursor lands on the freshly drawn tile.
  cursor = engine.hands.you.length - 1;
  draw();
}

function humanPass() {
  if (engine.over || engine.turn !== "you") return;
  if (!engine.mustPass("you")) return;         // only pass when truly blocked
  engine.pass("you");
  sound.drop();
  if (engine.over) {
    draw();
    finishRound();
    return;
  }
  endHumanTurn();
}

function finishRound() {
  const r = engine.result;
  if (r.type === "domino") sound.levelUp();
  else sound.clear(1); // blocked resolution
  let title, msg;
  if (r.winner === "you") {
    title = r.type === "domino" ? "Domino! You win" : "Blocked — You win";
    msg = r.type === "domino"
      ? "You emptied your hand."
      : `Lower pip count: you ${r.youPips} vs AI ${r.aiPips}.`;
  } else if (r.winner === "ai") {
    title = r.type === "domino" ? "AI got Domino" : "Blocked — AI wins";
    msg = r.type === "domino"
      ? "The AI emptied its hand."
      : `Lower pip count: AI ${r.aiPips} vs you ${r.youPips}.`;
  } else {
    title = "Blocked — Draw";
    msg = `Equal pip counts (${r.youPips} each).`;
  }
  draw();
  showOverlay(title, msg + (isTouchDevice() ? "<br>Tap New Round." : "<br>Press <kbd>Enter</kbd> for a new round."));
}

// Start a fresh round (keeps the running score across rounds).
function newRound() {
  if (aiTimer) { clearTimeout(aiTimer); aiTimer = null; }
  engine.newRound();
  selected = null;
  cursor = 0;
  hideOverlay();
  sound.start();
  draw();
  // If the AI opened, it's your turn; if YOU opened, the engine already placed
  // your tile and set turn to the AI — kick it off.
  scheduleAi();
  setStatus(turnStatus());
}

// First start of the session from the overlay.
function startGame() {
  sound.resume();
  if (!started) { started = true; }
  newRound();
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (intent === "back") {
    location.href = "../";
    return;
  }

  // Overlay up (pre-start or round over): Enter starts / advances.
  if (!els.overlay.classList.contains("overlay--hidden")) {
    if (intent === "enter") startGame();
    return;
  }

  if (engine.over || engine.turn !== "you") return; // ignore during AI turn

  const hand = engine.hands.you;
  switch (intent) {
    case "left":
      if (hand.length) { cursor = (cursor - 1 + hand.length) % hand.length; selectAtCursor(); }
      break;
    case "right":
      if (hand.length) { cursor = (cursor + 1) % hand.length; selectAtCursor(); }
      break;
    case "up":
      // Choose the LEFT end for the selected tile (if legal there).
      if (selected && selected.ends.includes("L")) playSelected("L");
      break;
    case "down":
      // Choose the RIGHT end for the selected tile (if legal there).
      if (selected && selected.ends.includes("R")) playSelected("R");
      break;
    case "enter":
      onEnter();
      break;
  }
});

// Enter: if a tile is selected and has exactly one legal end, play it there;
// if it has two, default to the left end; if no tile selected, select at cursor.
function onEnter() {
  if (!selected) { selectAtCursor(); return; }
  if (selected.ends.length === 1) playSelected(selected.ends[0]);
  else playSelected("L");
}

// Select the tile under the cursor if it has any legal move; else clear.
function selectAtCursor() {
  const tile = engine.hands.you[cursor];
  if (!tile) { selected = null; draw(); return; }
  const m = legalMoves([tile], engine.ends)[0];
  selected = m ? { tile, ends: m.ends } : null;
  draw();
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  // Counts.
  els.oppoCount.textContent = engine.hands.ai.length;
  els.boneCount.textContent = engine.boneyard.length;
  els.scoreYou.textContent = engine.scores.you;
  els.scoreAi.textContent = engine.scores.ai;
  els.yourPips.textContent = handPips(engine.hands.you);

  renderChain();
  renderEnds();
  renderHand();
  renderControls();

  if (!engine.over && els.overlay.classList.contains("overlay--hidden")) {
    setStatus(turnStatus());
  }
}

// Build the chain left→right. Doubles carry .tile--double (drawn crosswise).
function renderChain() {
  els.chain.innerHTML = "";
  for (const seg of engine.chain) {
    const tile = buildTile(seg.a, seg.b, seg.double);
    tile.setAttribute("role", "listitem");
    tile.setAttribute("aria-label", `${seg.a} ${seg.b}`);
    els.chain.appendChild(tile);
  }
  // Keep the most recent play in view as the chain grows.
  els.chain.scrollLeft = els.chain.scrollWidth;
}

function renderEnds() {
  const [L, R] = engine.ends;
  els.endLpip.textContent = L === null ? "–" : String(L);
  els.endRpip.textContent = R === null ? "–" : String(R);
  const legalL = !!(selected && selected.ends.includes("L"));
  const legalR = !!(selected && selected.ends.includes("R"));
  els.endL.classList.toggle("endbtn--legal", legalL);
  els.endR.classList.toggle("endbtn--legal", legalR);
  const yourTurn = !engine.over && engine.turn === "you";
  els.endL.disabled = !yourTurn || L === null;
  els.endR.disabled = !yourTurn || R === null;
}

function renderHand() {
  els.hand.innerHTML = "";
  const moves = legalMoves(engine.hands.you, engine.ends);
  const legalSet = new Set(moves.map((m) => tileId(m.tile)));
  const yourTurn = !engine.over && engine.turn === "you";

  engine.hands.you.forEach((t, i) => {
    const tile = buildTile(t.a, t.b, isDouble(t));
    const playable = legalSet.has(tileId(t));
    if (yourTurn && !playable) tile.classList.add("tile--dead");
    if (i === cursor) tile.classList.add("tile--cursor");
    if (selected && selected.tile === t) tile.classList.add("tile--selected");
    tile.setAttribute("aria-label", `Tile ${t.a} ${t.b}${playable ? ", playable" : ""}`);
    tile.setAttribute("data-touch-ignore", "");
    tile.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (engine.over || engine.turn !== "you") return;
      cursor = i;
      selectAtCursor();
    });
    els.hand.appendChild(tile);
  });
}

function renderControls() {
  if (!drawBtn || !passBtn) return;
  const yourTurn = !engine.over && engine.turn === "you";
  const noMove = yourTurn && !engine.canPlayNow("you");
  // Draw is enabled only when you can't play and the boneyard has tiles.
  drawBtn.disabled = !(noMove && engine.boneyard.length > 0);
  // Pass is enabled only when you're truly blocked (no move, empty boneyard).
  passBtn.disabled = !(noMove && engine.boneyard.length === 0);
}

// Status line: whose turn + the last action, or a nudge when you must act.
function turnStatus() {
  if (engine.over) return engine.lastAction;
  if (engine.turn === "ai") return `AI's turn — ${engine.lastAction}`;
  if (!engine.canPlayNow("you")) {
    if (engine.boneyard.length > 0) return "No move — Draw a tile";
    return "No move — Pass";
  }
  const tip = isTouchDevice() ? "tap a tile, then an end" : "pick a tile, then ←/↑/↓→ an end";
  return `Your turn — ${tip}`;
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
  // Open-end play buttons.
  els.endL.addEventListener("pointerdown", (e) => { e.preventDefault(); playSelected("L"); });
  els.endR.addEventListener("pointerdown", (e) => { e.preventDefault(); playSelected("R"); });

  // Always-visible primary controls: Draw, Pass, New Round.
  mountButtons(els.controls, input, [
    { label: "Draw", onPress: humanDraw, ariaLabel: "Draw from boneyard", className: "ctl" },
    { label: "Pass", onPress: humanPass, ariaLabel: "Pass turn", className: "ctl" },
    { label: "New Round", onPress: startGame, ariaLabel: "New round", className: "ctl ctl--primary" },
  ]);
  drawBtn = els.controls.children[0];
  passBtn = els.controls.children[1];

  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
    else if (e.key === "d" || e.key === "D") humanDraw();
    else if (e.key === "p" || e.key === "P") humanPass();
  });

  draw();
  setStatus(isTouchDevice() ? "Tap Start" : "Press Enter to start");
  showOverlay("Dominoes", isTouchDevice() ? "Tap to start · You vs AI" : "Press <kbd>Enter</kbd> to start · You vs AI");
}

boot();
