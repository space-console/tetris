// Chess for Space Console — entry point.
// Wires the shared intent stream to the pure engine, moves a square cursor over
// a DOM 8×8 grid, renders the pieces / cursor / selection / legal targets /
// last move / check, runs the optional minimax AI, and manages the game states
// (menu → playing → promoting → over). The engine owns all chess logic; this
// file is input + render + modes only.

import { Engine, WHITE, BLACK, rc, idx } from "./engine.js?v=857ce26d-ee18-4390-96f8-6d29d2db3b03";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=857ce26d-ee18-4390-96f8-6d29d2db3b03";
import { Sound } from "../assets/js/shared/sound.js?v=857ce26d-ee18-4390-96f8-6d29d2db3b03";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

// Unicode glyphs keyed by `${color}${type}` (e.g. "wk" → white king).
const GLYPH = {
  wk: "♔", wq: "♕", wr: "♖", wb: "♗", wn: "♘", wp: "♙",
  bk: "♚", bq: "♛", br: "♜", bb: "♝", bn: "♞", bp: "♟",
};

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  turnLabel: document.getElementById("turnLabel"),
  modeLabel: document.getElementById("modeLabel"),
  moveCount: document.getElementById("moveCount"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  menu: document.getElementById("menu"),
  modeTwo: document.getElementById("modeTwo"),
  modeAI: document.getElementById("modeAI"),
  promo: document.getElementById("promo"),
  promoRow: document.getElementById("promoRow"),
  mute: document.getElementById("mute"),
};

// menu | playing | thinking | promoting | over
let state = "menu";
let mode = "two";              // "two" (hot-seat) or "ai" (vs computer)
let menuIndex = 0;             // highlighted menu item (0 = 2 players, 1 = AI)
let cursor = idx(6, 4);        // square the cursor hovers (e2 to start)
let selected = null;           // selected piece's square index, or null
let targets = [];              // legal destination indexes for `selected`
let pendingPromo = null;       // { from, to } awaiting a promotion choice
let promoIndex = 0;            // highlighted promotion option (default Queen)

const PROMO_OPTS = ["q", "r", "b", "n"]; // Queen first (default highlight)
const HUMAN = WHITE;                      // in AI mode the human plays White

// Build the 64 squares once; we only update text/classes thereafter.
const cells = [];
for (let i = 0; i < 64; i++) {
  const [row, col] = rc(i);
  const cell = document.createElement("div");
  cell.className = "sq " + ((row + col) % 2 === 0 ? "sq--light" : "sq--dark");
  cell.setAttribute("role", "gridcell");
  // Squares own their taps, so keep the global gesture layer out (also styled
  // touch-action: manipulation in style.css).
  cell.setAttribute("data-touch-ignore", "");
  cell.addEventListener("pointerdown", () => tapSquare(i));
  els.grid.appendChild(cell);
  cells.push(cell);
}

// ---- Mode menu ------------------------------------------------------------
function startGame(chosenMode) {
  sound.resume();   // first interaction unlocks audio (autoplay policy)
  sound.start();
  mode = chosenMode;
  engine.reset();
  state = "playing";
  selected = null;
  targets = [];
  cursor = idx(6, 4);
  hideOverlay();
  draw();
}

function showMenu() {
  state = "menu";
  selected = null;
  targets = [];
  els.menu.classList.remove("menu--hidden");
  showOverlay("Chess", isTouchDevice() ? "Tap a mode to begin" : "Pick a mode · Enter");
  renderMenu();
  setStatus("Choose a mode");
  draw();
}

function renderMenu() {
  els.modeTwo.classList.toggle("menu__item--active", menuIndex === 0);
  els.modeAI.classList.toggle("menu__item--active", menuIndex === 1);
}

// ---- Tap handling ---------------------------------------------------------
function tapSquare(i) {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return; // not the human's turn
  cursor = i;
  selectOrMove();
}

// Select the piece under the cursor (showing its targets), or — if a piece is
// already selected — move to the cursor if it's a legal target, else reselect /
// deselect. Shared by the Enter intent and by tapping a square.
function selectOrMove() {
  if (state !== "playing") return;

  if (selected !== null && targets.includes(cursor)) {
    commitMove(selected, cursor);
    return;
  }

  const piece = engine.pieceAt(cursor);
  if (piece && piece.color === engine.turn) {
    // Select this piece and light up its legal destinations.
    selected = cursor;
    targets = engine.legalTargets(cursor);
  } else {
    // Empty / enemy square that isn't a legal target: clear the selection.
    selected = null;
    targets = [];
  }
  draw();
}

// Make a move; intercepts a pawn reaching the last rank to ask for a promotion.
function commitMove(from, to) {
  const piece = engine.pieceAt(from);
  const [toRow] = rc(to);
  const promoting = piece.type === "p" && (toRow === 0 || toRow === 7);
  if (promoting) {
    pendingPromo = { from, to };
    promoIndex = 0;
    openPromo();
    return;
  }
  applyMove(from, to, "q");
}

function applyMove(from, to, promo) {
  const capturing = engine.pieceAt(to) !== null ||
    engine.legalMoves(from).find((m) => m.to === to && m.flags.enpassant);
  const result = engine.move(from, to, promo);
  if (!result) return;
  selected = null;
  targets = [];

  // Sound: capture/move, then check, then game over (most significant last).
  const st = engine.status();
  if (st.checkmate || engine.gameOver) sound.gameOver();
  else if (st.inCheck) sound.rotate();
  else if (capturing) sound.lock();
  else sound.move();

  draw();

  if (engine.gameOver) { endGame(); return; }

  // vs Computer: hand off to the AI on its turn, deferred so the board paints
  // and a "thinking…" status shows before the (synchronous) search runs.
  if (mode === "ai" && engine.turn !== HUMAN) {
    state = "thinking";
    setStatus("Computer thinking…");
    setTimeout(aiMove, 30);
  }
}

function endGame() {
  state = "over";
  const st = engine.status();
  if (st.checkmate) {
    const winner = engine.winner === WHITE ? "White" : "Black";
    els.menu.classList.add("menu--hidden");
    showOverlay(`Checkmate — ${winner} wins`, replayMsg());
    setStatus(`${winner} wins`);
  } else if (st.stalemate) {
    els.menu.classList.add("menu--hidden");
    showOverlay("Stalemate — draw", replayMsg());
    setStatus("Stalemate");
  }
}

// ---- Promotion chooser ----------------------------------------------------
function openPromo() {
  state = "promoting";
  promoIndex = 0;
  els.promoRow.innerHTML = "";
  const color = engine.turn; // side to move is the one promoting
  PROMO_OPTS.forEach((type, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "promo__btn";
    b.textContent = GLYPH[color + type];
    b.setAttribute("data-touch-ignore", "");
    b.setAttribute("aria-label", { q: "Queen", r: "Rook", b: "Bishop", n: "Knight" }[type]);
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); choosePromo(i); });
    els.promoRow.appendChild(b);
  });
  renderPromo();
  els.promo.classList.remove("overlay--hidden");
  setStatus("Choose a promotion");
}

function renderPromo() {
  [...els.promoRow.children].forEach((b, i) =>
    b.classList.toggle("promo__btn--active", i === promoIndex));
}

function choosePromo(i) {
  const promo = PROMO_OPTS[i];
  els.promo.classList.add("overlay--hidden");
  const { from, to } = pendingPromo;
  pendingPromo = null;
  state = "playing";
  applyMove(from, to, promo);
}

// ---- AI: minimax + alpha-beta --------------------------------------------
// Material values (centipawns) and small piece-square tables nudge the AI
// toward sane development without a heavy evaluation. Depth 3 stays well under
// ~1s for these positions.
const VALUE = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const AI_DEPTH = 3;

// Pawns: advance and hold the centre. (Indexed 0..63, row 0 = Black's back rank,
// i.e. from White's point of view the table is read top = rank 8.)
const PST_PAWN = [
  0, 0, 0, 0, 0, 0, 0, 0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5, 5, 10, 25, 25, 10, 5, 5,
  0, 0, 0, 20, 20, 0, 0, 0,
  5, -5, -10, 0, 0, -10, -5, 5,
  5, 10, 10, -20, -20, 10, 10, 5,
  0, 0, 0, 0, 0, 0, 0, 0,
];
// Knights: prefer the centre, avoid the rim.
const PST_KNIGHT = [
  -50, -40, -30, -30, -30, -30, -40, -50,
  -40, -20, 0, 0, 0, 0, -20, -40,
  -30, 0, 10, 15, 15, 10, 0, -30,
  -30, 5, 15, 20, 20, 15, 5, -30,
  -30, 0, 15, 20, 20, 15, 0, -30,
  -30, 5, 10, 15, 15, 10, 5, -30,
  -40, -20, 0, 5, 5, 0, -20, -40,
  -50, -40, -30, -30, -30, -30, -40, -50,
];

// Evaluate from White's perspective (positive = good for White).
function evaluate() {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = engine.board[i];
    if (!p) continue;
    let v = VALUE[p.type];
    if (p.type === "p") v += PST_PAWN[p.color === WHITE ? i : 63 - i];
    else if (p.type === "n") v += PST_KNIGHT[p.color === WHITE ? i : 63 - i];
    score += p.color === WHITE ? v : -v;
  }
  return score;
}

// Negamax with alpha-beta. Returns the best score for the side to move; the AI
// (Black) minimises White's score, handled by the sign convention below.
function search(depth, alpha, beta) {
  if (depth === 0) return engine.turn === WHITE ? evaluate() : -evaluate();

  const moves = engine.allLegalMoves(engine.turn);
  if (moves.length === 0) {
    // No legal moves: checkmate (very bad) or stalemate (neutral).
    return engine.inCheck(engine.turn) ? -100000 - depth : 0;
  }

  let best = -Infinity;
  for (const m of moves) {
    const snap = snapshot();
    engine.move(m.from, m.to, m.flags.promote || "q");
    const score = -search(depth - 1, -beta, -alpha);
    restore(snap);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // beta cut-off
  }
  return best;
}

// Lightweight full-state snapshot/restore so the search can explore moves on the
// real engine and undo them (the engine has no public undo).
function snapshot() {
  return {
    board: engine.board.slice(),
    turn: engine.turn,
    castling: { ...engine.castling },
    enPassant: engine.enPassant,
    lastMove: engine.lastMove,
    gameOver: engine.gameOver,
    winner: engine.winner,
    historyLen: engine.history.length,
  };
}
function restore(s) {
  engine.board = s.board;
  engine.turn = s.turn;
  engine.castling = s.castling;
  engine.enPassant = s.enPassant;
  engine.lastMove = s.lastMove;
  engine.gameOver = s.gameOver;
  engine.winner = s.winner;
  engine.history.length = s.historyLen;
}

function aiMove() {
  const moves = engine.allLegalMoves(engine.turn);
  if (moves.length === 0) { endGame(); return; }

  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const snap = snapshot();
    engine.move(m.from, m.to, m.flags.promote || "q");
    const score = -search(AI_DEPTH - 1, -Infinity, Infinity);
    restore(snap);
    if (score > bestScore) { bestScore = score; bestMove = m; }
  }

  state = "playing";
  applyMove(bestMove.from, bestMove.to, bestMove.flags.promote || "q");
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  // Menu: arrows pick a mode, Enter starts it, Back returns to the hub.
  if (state === "menu") {
    if (intent === "up" || intent === "down") {
      menuIndex = menuIndex === 0 ? 1 : 0;
      renderMenu();
    } else if (intent === "enter") {
      startGame(menuIndex === 0 ? "two" : "ai");
    } else if (intent === "back") {
      location.href = "../";
    }
    return;
  }

  // Promotion chooser: arrows move the highlight, Enter confirms, Back cancels.
  if (state === "promoting") {
    if (intent === "left") { promoIndex = (promoIndex + PROMO_OPTS.length - 1) % PROMO_OPTS.length; renderPromo(); }
    else if (intent === "right") { promoIndex = (promoIndex + 1) % PROMO_OPTS.length; renderPromo(); }
    else if (intent === "enter") { choosePromo(promoIndex); }
    else if (intent === "back") {
      // Cancel: dismiss the chooser and keep the piece selected.
      els.promo.classList.add("overlay--hidden");
      pendingPromo = null;
      state = "playing";
      draw();
    }
    return;
  }

  // Game over: Enter returns to the menu, Back too.
  if (state === "over") {
    if (intent === "enter" || intent === "back") showMenu();
    return;
  }

  // The AI is thinking: ignore gameplay input except Back (→ menu).
  if (state === "thinking") {
    if (intent === "back") showMenu();
    return;
  }

  // Playing.
  if (state === "playing") {
    switch (intent) {
      // Arrows move the square cursor, clamped to the board edges.
      case "left": cursor = clampStep(cursor, 0, -1); break;
      case "right": cursor = clampStep(cursor, 0, 1); break;
      case "up": cursor = clampStep(cursor, -1, 0); break;
      case "down": cursor = clampStep(cursor, 1, 0); break;
      case "enter": selectOrMove(); return;
      case "back": showMenu(); return;
    }
    draw();
  }
});

// Move the cursor by (dRow, dCol), staying on the board.
function clampStep(index, dRow, dCol) {
  const [row, col] = rc(index);
  const r = Math.min(7, Math.max(0, row + dRow));
  const c = Math.min(7, Math.max(0, col + dCol));
  return idx(r, c);
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  const st = engine.status();
  const targetSet = new Set(targets);
  const checkSquare = st.inCheck ? findKing(st.turn) : -1;
  const last = engine.lastMove;

  for (let i = 0; i < 64; i++) {
    const cell = cells[i];
    const piece = engine.board[i];
    cell.textContent = piece ? GLYPH[piece.color + piece.type] : "";
    cell.classList.toggle("sq--wp", !!piece && piece.color === WHITE);
    cell.classList.toggle("sq--bp", !!piece && piece.color === BLACK);

    // Cursor only while it's a human's turn to act.
    const showCursor = state === "playing" && i === cursor;
    cell.classList.toggle("sq--cursor", showCursor);
    cell.classList.toggle("sq--selected", selected === i);
    cell.classList.toggle("sq--last", !!last && (last.from === i || last.to === i));
    cell.classList.toggle("sq--check", i === checkSquare);

    // Legal-target markers: a ring for captures, a dot otherwise.
    const isTarget = targetSet.has(i);
    cell.classList.toggle("sq--target", isTarget);
    cell.classList.toggle("sq--capture", isTarget && !!piece);
  }

  // Side panel + status line.
  els.modeLabel.textContent = mode === "ai" ? "vs CPU" : "2P";
  els.moveCount.textContent = engine.history.length;
  els.turnLabel.textContent = engine.turn === WHITE ? "White" : "Black";

  if (state === "playing") {
    const who = engine.turn === WHITE ? "White" : "Black";
    setStatus(st.inCheck ? `${who} in check` : `${who} to move`);
  }
}

function findKing(color) {
  for (let i = 0; i < 64; i++) {
    const p = engine.board[i];
    if (p && p.type === "k" && p.color === color) return i;
  }
  return -1;
}

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function replayMsg() {
  return isTouchDevice() ? "Tap to choose a mode" : "Press <kbd>Enter</kbd> for the menu";
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

  // Menu items are tappable as well as arrow/enter selectable.
  els.modeTwo.addEventListener("pointerdown", (e) => { e.preventDefault(); startGame("two"); });
  els.modeAI.addEventListener("pointerdown", (e) => { e.preventDefault(); startGame("ai"); });

  els.mute.addEventListener("click", toggleMute);
  // Mute is a meta control (M key), handled outside the gameplay intent layer.
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });

  draw();             // render the starting position behind the menu overlay
  showMenu();
}

boot();
