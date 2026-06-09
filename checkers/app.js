// Checkers for Space Console — entry point.
// Wires the shared intent stream to the pure engine, moves a square cursor over
// a DOM 8×8 grid, renders pieces / cursor / selection / legal targets / forced-
// capture pieces / last move, runs the optional minimax AI, and manages the
// game states (menu → playing → thinking → over). The engine owns all checkers
// logic; this file is input + render + modes only.

import { Engine, RED, WHITE, rc, idx } from "./engine.js";
import { Input, isTouchDevice } from "../assets/js/shared/input.js";
import { Sound } from "../assets/js/shared/sound.js";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const CROWN = "♛"; // king crown glyph, layered over the disc

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  turnLabel: document.getElementById("turnLabel"),
  modeLabel: document.getElementById("modeLabel"),
  redCount: document.getElementById("redCount"),
  whiteCount: document.getElementById("whiteCount"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  menu: document.getElementById("menu"),
  modeTwo: document.getElementById("modeTwo"),
  modeAI: document.getElementById("modeAI"),
  mute: document.getElementById("mute"),
};

// menu | playing | thinking | over
let state = "menu";
let mode = "two";          // "two" (hot-seat) or "ai" (vs computer)
let menuIndex = 0;         // highlighted menu item (0 = 2 players, 1 = AI)
let cursor = idx(5, 0);    // square the cursor hovers
let selected = null;       // selected piece's square index, or null
let targets = [];          // legal NEXT landing squares for `selected`
// Multi-jump in progress: the candidate chains that match the partial path the
// human has walked so far, plus the squares already captured. While non-empty,
// the human must keep jumping the same piece.
let jumpChains = null;     // array of move records still consistent, or null
let jumpStep = 0;          // index into each chain's path of the next landing

const HUMAN = RED;         // in AI mode the human plays Red (bottom)

// Build the 64 squares once; we only update text/classes thereafter.
const cells = [];
for (let i = 0; i < 64; i++) {
  const [row, col] = rc(i);
  const cell = document.createElement("div");
  cell.className = "sq " + ((row + col) % 2 === 1 ? "sq--dark" : "sq--light");
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
  clearSelection();
  cursor = idx(5, 0);
  hideOverlay();
  draw();
}

function showMenu() {
  state = "menu";
  clearSelection();
  els.menu.classList.remove("menu--hidden");
  showOverlay("Checkers", isTouchDevice() ? "Tap a mode to begin" : "Pick a mode · Enter");
  renderMenu();
  setStatus("Choose a mode");
  draw();
}

function renderMenu() {
  els.modeTwo.classList.toggle("menu__item--active", menuIndex === 0);
  els.modeAI.classList.toggle("menu__item--active", menuIndex === 1);
}

function clearSelection() {
  selected = null;
  targets = [];
  jumpChains = null;
  jumpStep = 0;
}

// ---- Tap handling ---------------------------------------------------------
function tapSquare(i) {
  if (state !== "playing") return;
  if (mode === "ai" && engine.turn !== HUMAN) return; // not the human's turn
  cursor = i;
  selectOrMove();
}

// Select the piece under the cursor (showing its targets), or — if a piece is
// already selected — advance the move toward the cursor if it's a legal next
// landing square, else reselect / deselect. Shared by Enter and by tapping.
function selectOrMove() {
  if (state !== "playing") return;

  // Mid multi-jump: only the next jump square is accepted.
  if (jumpChains) {
    if (targets.includes(cursor)) advanceJump(cursor);
    return;
  }

  if (selected !== null && targets.includes(cursor)) {
    beginMove(selected, cursor);
    return;
  }

  const piece = engine.pieceAt(cursor);
  if (piece && piece.color === engine.turn) {
    const moves = engine.legalMoves(cursor);
    if (moves.length) {
      selected = cursor;
      targets = moves.map((m) => m.path[1]);
    } else {
      clearSelection(); // a piece with no legal move (e.g. not the forced one)
    }
  } else {
    clearSelection();
  }
  draw();
}

// Start moving `selected` toward landing square `to`. A plain step commits at
// once; a jump enters the step-by-step multi-jump flow.
function beginMove(from, to) {
  const moves = engine.legalMoves(from).filter((m) => m.path[1] === to);
  if (!moves.length) return;
  // Plain step (single non-jump move to this square).
  const step = moves.find((m) => !m.isJump);
  if (step) { commit(step); return; }
  // Jump: keep the chains that start with this landing and walk the path.
  jumpChains = moves;
  jumpStep = 1;          // path[0] is the origin; path[1] was just chosen
  afterJumpHop(to);
}

// The human just chose landing square `to` continuing the current jump.
function advanceJump(to) {
  jumpChains = jumpChains.filter((m) => m.path[jumpStep] === to);
  jumpStep += 1;
  afterJumpHop(to);
}

// After landing on a jump square: if any chain continues, prompt for the next
// hop; otherwise commit the (now fully determined) chain.
function afterJumpHop(landing) {
  const done = jumpChains.filter((m) => m.path.length === jumpStep);
  const more = jumpChains.filter((m) => m.path.length > jumpStep);
  if (more.length) {
    selected = landing;
    targets = [...new Set(more.map((m) => m.path[jumpStep]))];
    cursor = landing;
    setStatus("Keep jumping");
    sound.lock();
    draw();
    return;
  }
  commit(done[0]);
}

// Apply a fully-chosen move record, play sound, and advance the game.
function commit(record) {
  const wasJump = record.isJump;
  const result = engine.move(record);
  clearSelection();
  if (!result) { draw(); return; }

  // Sound: most significant last. Promotion > game over > capture > move.
  if (result.promote) sound.rotate();
  else if (engine.gameOver) sound.gameOver();
  else if (wasJump) sound.lock();
  else sound.move();
  if (engine.gameOver && result.promote) sound.gameOver();

  draw();
  if (engine.gameOver) { endGame(); return; }

  // vs Computer: hand off to the AI on its turn, deferred so the board paints
  // and a "thinking…" status shows before the search runs.
  if (mode === "ai" && engine.turn !== HUMAN) {
    state = "thinking";
    setStatus("Computer thinking…");
    setTimeout(aiMove, 30);
  }
}

function endGame() {
  state = "over";
  const winner = engine.winner === RED ? "Red" : "White";
  els.menu.classList.add("menu--hidden");
  showOverlay(`${winner} wins`, replayMsg());
  setStatus(`${winner} wins`);
}

// ---- AI: minimax + alpha-beta --------------------------------------------
// Checkers branching is low, so a deeper search stays well under ~1s.
const AI_DEPTH = 6;
const KING_VALUE = 175;
const MAN_VALUE = 100;

// Snapshot/restore so the search can explore moves on the real engine and undo
// them (the engine has no public undo).
function snapshot() {
  return {
    board: engine.board.map((p) => (p ? { ...p } : null)),
    turn: engine.turn,
    lastMove: engine.lastMove,
    gameOver: engine.gameOver,
    winner: engine.winner,
    historyLen: engine.history.length,
  };
}
function restore(s) {
  engine.board = s.board;
  engine.turn = s.turn;
  engine.lastMove = s.lastMove;
  engine.gameOver = s.gameOver;
  engine.winner = s.winner;
  engine.history.length = s.historyLen;
}

// Evaluate from RED's perspective (positive = good for Red). Material + king
// bonus + a small advancement term (men are worth more the closer they are to
// promotion) + a centre-control nudge.
function evaluate() {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = engine.board[i];
    if (!p) continue;
    const [row, col] = rc(i);
    let v = p.king ? KING_VALUE : MAN_VALUE;
    if (!p.king) {
      // Advancement: rows toward the far side add up to ~30.
      const adv = p.color === RED ? (7 - row) : row;
      v += adv * 4;
    }
    // Slight centre preference.
    v += (3.5 - Math.abs(3.5 - col)) * 2;
    score += p.color === RED ? v : -v;
  }
  return score;
}

// Negamax with alpha-beta. Returns the best score for the side to move.
function search(depth, alpha, beta) {
  if (engine.gameOver) {
    // Side to move has already lost (no moves): very bad for it.
    return -100000 - depth;
  }
  if (depth === 0) return engine.turn === RED ? evaluate() : -evaluate();

  const moves = engine.allLegalMoves(engine.turn);
  if (moves.length === 0) return -100000 - depth;

  let best = -Infinity;
  for (const m of moves) {
    const snap = snapshot();
    engine.move(m);
    const score = -search(depth - 1, -beta, -alpha);
    restore(snap);
    if (score > best) best = score;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break; // beta cut-off
  }
  return best;
}

function aiMove() {
  const moves = engine.allLegalMoves(engine.turn);
  if (moves.length === 0) { endGame(); return; }

  let bestMove = moves[0];
  let bestScore = -Infinity;
  for (const m of moves) {
    const snap = snapshot();
    engine.move(m);
    const score = -search(AI_DEPTH - 1, -Infinity, Infinity);
    restore(snap);
    if (score > bestScore) { bestScore = score; bestMove = m; }
  }

  state = "playing";
  // Replay the AI's move through the normal commit path for sound + verdict.
  const wasJump = bestMove.isJump;
  engine.move(bestMove);
  if (bestMove.promote) sound.rotate();
  else if (engine.gameOver) sound.gameOver();
  else if (wasJump) sound.lock();
  else sound.move();
  clearSelection();
  draw();
  if (engine.gameOver) { endGame(); return; }
  // Place the cursor on a human piece for convenience.
  cursor = firstHumanPiece();
  draw();
}

function firstHumanPiece() {
  for (let i = 0; i < 64; i++) {
    const p = engine.board[i];
    if (p && p.color === HUMAN) return i;
  }
  return cursor;
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

  // Game over: Enter or Back returns to the menu.
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
  const targetSet = new Set(targets);
  const last = engine.lastMove;
  // Pieces that MUST capture (only when no individual piece is selected and a
  // capture is forced for the side to move).
  const mustSet = forcedCaptureSquares();

  let red = 0, white = 0;
  for (let i = 0; i < 64; i++) {
    const cell = cells[i];
    const piece = engine.board[i];
    if (piece) {
      if (piece.color === RED) red++; else white++;
    }
    cell.textContent = piece && piece.king ? CROWN : "";
    cell.classList.toggle("sq--piece", !!piece);
    cell.classList.toggle("sq--red", !!piece && piece.color === RED);
    cell.classList.toggle("sq--white", !!piece && piece.color === WHITE);
    cell.classList.toggle("sq--king", !!piece && piece.king);

    const showCursor = state === "playing" && i === cursor;
    cell.classList.toggle("sq--cursor", showCursor);
    cell.classList.toggle("sq--selected", selected === i);
    cell.classList.toggle("sq--last", !!last && (last.from === i || last.to === i));
    cell.classList.toggle("sq--target", targetSet.has(i));
    cell.classList.toggle("sq--must", mustSet.has(i));
  }

  els.modeLabel.textContent = mode === "ai" ? "vs CPU" : "2P";
  els.redCount.textContent = red;
  els.whiteCount.textContent = white;
  els.turnLabel.textContent = engine.turn === RED ? "Red" : "White";

  if (state === "playing" && !jumpChains) {
    const who = engine.turn === RED ? "Red" : "White";
    setStatus(mustSet.size ? `${who}: must capture` : `${who} to move`);
  }
}

// Origin squares of forced captures for the side to move, when no piece is
// actively selected. Returns an empty set otherwise so the highlight only nags
// at the start of a turn.
function forcedCaptureSquares() {
  if (state !== "playing" || selected !== null || jumpChains) return new Set();
  const moves = engine.allLegalMoves(engine.turn);
  if (!moves.length || !moves[0].isJump) return new Set();
  return new Set(moves.map((m) => m.from));
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
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });

  draw();             // render the starting position behind the menu overlay
  showMenu();
}

boot();
