// Ludo for Space Console — entry point.
// Wires the shared intent stream to the pure engine, renders the cross-shaped
// board on a 15×15 DOM grid (coloured yards in the corners, the shared ring,
// the home columns, the centre finish), draws tokens as coloured discs, runs
// the three AI opponents with short delays + "thinking" status, and manages the
// game states (start → human roll → human pick → AI turns → over). The engine
// owns all Ludo logic; this file is layout + input + render + AI scheduling.

import {
  Engine, COLORS, START, SAFE_SQUARES, TRACK_LEN, PATH_HOME_ENTRY, PATH_FINISH,
} from "./engine.js?v=297692ec-9d04-48fc-b8ba-8d23c1efb13f";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=297692ec-9d04-48fc-b8ba-8d23c1efb13f";
import { Sound } from "../assets/js/shared/sound.js?v=297692ec-9d04-48fc-b8ba-8d23c1efb13f";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const HUMAN = "red"; // the human always plays Red; green/yellow/blue are AI

// Player colours as concrete hex (for inline tints the CSS can't reach, e.g. the
// centre home triangles built per-cell).
const COLORHEX = { red: "#e23b4e", green: "#2fb86b", yellow: "#e7b53b", blue: "#3b7de2" };

// ---- 3D die ---------------------------------------------------------------
// Pip layout per face, on a 3×3 grid numbered 1..9 (row-major). Each value lights
// a fixed set of those nine slots.
const PIP_MAP = {
  1: [5],
  2: [1, 9],
  3: [1, 5, 9],
  4: [1, 3, 7, 9],
  5: [1, 3, 5, 7, 9],
  6: [1, 3, 4, 6, 7, 9],
};

// Cube rotation (degrees [rotateX, rotateY]) that brings each face to the front.
// Mirrors the face placement in style.css (1 front, 6 back, 2 right, 5 left,
// 3 top, 4 bottom).
const DIE_ORIENT = {
  1: [0, 0],
  2: [0, -90],
  3: [-90, 0],
  4: [90, 0],
  5: [0, 90],
  6: [0, 180],
};

let dieSpin = 0; // ever-increasing full-turn counter so every roll visibly tumbles

// Build the six pip faces inside the cube (once, at boot).
function buildDie() {
  els.dieCube.innerHTML = "";
  for (let value = 1; value <= 6; value++) {
    const face = document.createElement("div");
    face.className = "die-face die-face--" + value;
    for (let slot = 1; slot <= 9; slot++) {
      const cell = document.createElement("span");
      cell.className = "pipcell";
      if (PIP_MAP[value].includes(slot)) {
        const pip = document.createElement("span");
        pip.className = "pip";
        cell.appendChild(pip);
      }
      face.appendChild(cell);
    }
    els.dieCube.appendChild(face);
  }
}

// Spin the cube and land `value` facing the viewer. Each call adds a full extra
// revolution so repeated values still tumble.
function rollDieAnim(value) {
  dieSpin += 1;
  const [rx, ry] = DIE_ORIENT[value];
  els.dieCube.style.transform =
    `rotateX(${rx + 360 * dieSpin}deg) rotateY(${ry + 360 * dieSpin}deg)`;
  els.dieCube.setAttribute("aria-label", "Die showing " + value);
}

// Settle the cube to a neutral resting pose (face 1) without a reverse spin.
function showDieResting() {
  const [rx, ry] = DIE_ORIENT[1];
  els.dieCube.style.transform =
    `rotateX(${rx + 360 * dieSpin}deg) rotateY(${ry + 360 * dieSpin}deg)`;
  els.dieCube.setAttribute("aria-label", "Die");
}

// ---- Board geometry (15×15) ----------------------------------------------
// The 52 ring squares in clockwise order, starting at Red's START. Indexed by
// the engine's ring step 0..51. Each entry is [row, col] on the 15×15 grid.
const RING = [
  [6, 1], [6, 2], [6, 3], [6, 4], [6, 5], [5, 6], [4, 6], [3, 6], [2, 6], [1, 6],
  [0, 6], [0, 7], [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [6, 9], [6, 10],
  [6, 11], [6, 12], [6, 13], [6, 14], [7, 14], [8, 14], [8, 13], [8, 12], [8, 11],
  [8, 10], [8, 9], [9, 8], [10, 8], [11, 8], [12, 8], [13, 8], [14, 8], [14, 7],
  [14, 6], [13, 6], [12, 6], [11, 6], [10, 6], [9, 6], [8, 5], [8, 4], [8, 3],
  [8, 2], [8, 1], [8, 0], [7, 0], [6, 0],
];

// Each colour's 5 home-column cells (step 0..4); the finish is the centre (7,7).
const HOME = {
  red: [[7, 1], [7, 2], [7, 3], [7, 4], [7, 5]],
  green: [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7]],
  yellow: [[7, 13], [7, 12], [7, 11], [7, 10], [7, 9]],
  blue: [[13, 7], [12, 7], [11, 7], [10, 7], [9, 7]],
};
const FINISH_CELL = [7, 7];

// Yard corner blocks (6×6) and the four disc nests inside each.
const YARD_ORIGIN = {
  red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0],
};
const YARD_NESTS = [[1, 1], [1, 4], [4, 1], [4, 4]]; // offsets within the 6×6

// The 6×6 corner cells that get the colour wash (full yard block).
const YARD_BLOCK_RANGE = 6;

const els = {
  status: document.getElementById("status"),
  grid: document.getElementById("grid"),
  dieScene: document.getElementById("dieScene"),
  dieCube: document.getElementById("dieCube"),
  rollBtn: document.getElementById("rollBtn"),
  turnLabel: document.getElementById("turnLabel"),
  homeLabel: document.getElementById("homeLabel"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// idle | rolling | choosing | ai | over
let state = "idle";
let started = false;
let legal = [];        // legal moves for the human's current die
let cursorIdx = 0;     // index into `legal` for the keyboard cursor

// Build the 15×15 cells once; only text/classes/discs update thereafter.
const cellAt = new Map(); // "r,c" -> cell element
for (let r = 0; r < 15; r++) {
  for (let c = 0; c < 15; c++) {
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.r = String(r);
    cell.dataset.c = String(c);
    // Cells own their taps (a tap on a movable token moves it); keep the global
    // gesture layer out (also styled touch-action: manipulation in style.css).
    cell.setAttribute("data-touch-ignore", "");
    cell.addEventListener("pointerdown", () => tapCell(r, c));
    els.grid.appendChild(cell);
    cellAt.set(r + "," + c, cell);
  }
}

// Pre-compute static cell styling (yards, track, home columns, centre, safe).
function paintStatic() {
  // Yards (full 6×6 colour wash + nest pads).
  for (const color of COLORS) {
    const [r0, c0] = YARD_ORIGIN[color];
    for (let dr = 0; dr < YARD_BLOCK_RANGE; dr++) {
      for (let dc = 0; dc < YARD_BLOCK_RANGE; dc++) {
        const cell = cellAt.get((r0 + dr) + "," + (c0 + dc));
        cell.classList.add("cell--yard", "cell--" + color);
      }
    }
    for (const [dr, dc] of YARD_NESTS) {
      cellAt.get((r0 + dr) + "," + (c0 + dc)).classList.add("cell--yardpad");
    }
  }

  // Track ring: pale bordered squares, with each colour's START tinted and the
  // star "safe" squares marked. cell--path draws the gridline border so every
  // step is individually visible.
  RING.forEach(([r, c], step) => {
    const cell = cellAt.get(r + "," + c);
    cell.classList.add("cell--track", "cell--path");
    if (SAFE_SQUARES.has(step)) cell.classList.add("cell--safe");
  });
  // Tint each colour's START square and give it a travel-direction arrow (which
  // replaces the safe star there, so it reads as the launch square).
  const START_ARROW = { red: "right", green: "down", yellow: "left", blue: "up" };
  for (const color of COLORS) {
    const [r, c] = RING[START[color]];
    const cell = cellAt.get(r + "," + c);
    cell.classList.remove("cell--track", "cell--safe");
    cell.classList.add("cell--" + color, "cell--start", "cell--start-" + START_ARROW[color]);
  }

  // Home columns, tinted to the owner (also path-bordered).
  for (const color of COLORS) {
    for (const [r, c] of HOME[color]) {
      const cell = cellAt.get(r + "," + c);
      cell.classList.remove("cell--track");
      cell.classList.add("cell--" + color, "cell--path");
    }
  }

  // Centre home: four colour triangles converging on the finish, with the four
  // diagonal corners and the finish itself as a light pad. Each triangle points
  // inward toward the centre; its colour matches the home column that feeds it.
  const CENTER_TRI = [
    { rc: [7, 6], color: "red", dir: "right" },
    { rc: [6, 7], color: "green", dir: "down" },
    { rc: [7, 8], color: "yellow", dir: "left" },
    { rc: [8, 7], color: "blue", dir: "up" },
  ];
  for (const { rc, color, dir } of CENTER_TRI) {
    const cell = cellAt.get(rc[0] + "," + rc[1]);
    cell.classList.add("cell--center", "cell--homein", "cell--homein-" + dir);
    cell.style.setProperty("--tri", COLORHEX[color]);
  }
  for (const rc of [[6, 6], [6, 8], [8, 6], [8, 8]]) {
    cellAt.get(rc[0] + "," + rc[1]).classList.add("cell--center");
  }
  cellAt.get(FINISH_CELL[0] + "," + FINISH_CELL[1]).classList.add("cell--center");
}
paintStatic();

// ---- Cell → token resolution ---------------------------------------------
// Where does a (color, token) sit on the grid? Returns [row, col].
function tokenCell(color, token) {
  const pos = engine.position(color, token);
  if (pos.zone === "yard") {
    const [r0, c0] = YARD_ORIGIN[color];
    const [dr, dc] = YARD_NESTS[token];
    return [r0 + dr, c0 + dc];
  }
  if (pos.zone === "track") return RING[pos.step];
  if (pos.zone === "home") return HOME[color][pos.step];
  return FINISH_CELL; // finish
}

// Grid cell a token would occupy at a given path progress (its move target).
function destCellFor(color, toProgress) {
  if (toProgress >= PATH_FINISH) return FINISH_CELL;
  if (toProgress >= PATH_HOME_ENTRY) return HOME[color][toProgress - PATH_HOME_ENTRY];
  return RING[(START[color] + toProgress) % TRACK_LEN];
}

// Find the legal move (if any) whose moving token currently sits on (r,c).
function legalMoveAtCell(r, c) {
  for (const m of legal) {
    const [tr, tc] = tokenCell(HUMAN, m.token);
    if (tr === r && tc === c) return m;
  }
  return null;
}

// ---- Tap handling ---------------------------------------------------------
function tapCell(r, c) {
  if (!started) { startGame(); return; }
  if (state === "over") { startGame(); return; }
  if (state !== "choosing") return;       // only tappable while picking a token
  const m = legalMoveAtCell(r, c);
  if (m) humanMove(m);
}

// ---- Game flow ------------------------------------------------------------
function startGame() {
  sound.resume();   // first interaction unlocks audio (autoplay policy)
  sound.start();
  engine.reset();
  started = true;
  state = "idle";
  legal = [];
  cursorIdx = 0;
  showDieResting();
  hideOverlay();
  setStatus("Your turn — tap Roll");
  draw();
}

// Human rolls the die. doRoll routes to token selection, a pass, or a re-roll.
function humanRoll() {
  if (state !== "idle") return;
  if (engine.turn !== HUMAN) return;
  doRoll(HUMAN);
}

// Shared roll: rolls, plays the roll sound, then routes to move selection or a
// pass. `color` is whose turn it is.
function doRoll(color) {
  const die = engine.roll();
  sound.rotate();
  rollDieAnim(die);
  draw();

  // Third consecutive six forfeits the whole turn.
  if (engine.isThirdSix()) {
    setStatus(label(color) + " rolled three 6s — turn forfeit");
    endTurn();
    return;
  }

  const moves = engine.legalMoves(color, die);
  if (moves.length === 0) {
    // No legal move (even a 6 can't help if nothing can move): pass the turn
    // after a short beat so the die/status is visible.
    setStatus(label(color) + " rolled " + die + " — no move");
    scheduleEndTurn(color);
    return;
  }

  if (color === HUMAN) {
    legal = moves;
    cursorIdx = 0;
    state = "choosing";
    setStatus(isTouchDevice() ? "Tap a glowing token" : "Pick a token · Enter");
    draw();
  } else {
    // AI: choose and move automatically after a short delay.
    state = "ai";
    setTimeout(() => aiMove(color, moves, die), 480);
  }
}

// Human commits a chosen move.
function humanMove(m) {
  applyMove(HUMAN, m.token, engine.die);
}

// Apply a move for `color`, play sounds, and route the turn flow.
function applyMove(color, token, die) {
  const res = engine.move(color, token, die);
  if (!res) return;

  if (res.captured) sound.clear(1);
  else if (res.finished) sound.levelUp();
  else sound.move();

  legal = [];
  draw();

  if (res.won) {
    sound.levelUp();
    endGame(color);
    return;
  }

  if (res.extraRoll) {
    // Another roll for the same colour.
    if (color === HUMAN) {
      state = "idle";
      setStatus("Rolled a 6 — roll again");
      draw();
    } else {
      state = "ai";
      setTimeout(() => doRoll(color), 520);
    }
    return;
  }

  endTurn();
}

// End the current colour's turn and advance to the next player.
function endTurn() {
  if (engine.winner) return;
  engine.nextTurn();
  beginTurn();
}

function scheduleEndTurn(color) {
  state = color === HUMAN ? "idle" : "ai";
  setTimeout(() => endTurn(), color === HUMAN ? 650 : 700);
}

// Begin whoever's turn it now is: the human gets the Roll button; AI auto-rolls.
function beginTurn() {
  const color = engine.turn;
  if (color === HUMAN) {
    state = "idle";
    setStatus("Your turn — tap Roll");
    draw();
  } else {
    state = "ai";
    setStatus(label(color) + " is thinking…");
    draw();
    setTimeout(() => doRoll(color), 560);
  }
}

// ---- AI -------------------------------------------------------------------
// Heuristic priority: capture an opponent > reach the finish > leave the yard on
// a 6 > advance the furthest-along token (with a nudge toward safe squares).
function aiChoose(color, moves) {
  const cap = moves.filter((m) => m.capture);
  if (cap.length) {
    // Prefer the capture landing furthest along the ring (a rough proxy for the
    // most valuable victim, and progress for our own token too).
    return cap.slice().sort((a, b) => b.toProgress - a.toProgress)[0];
  }
  const fin = moves.filter((m) => m.finishes);
  if (fin.length) return fin[0];

  const leave = moves.filter((m) => m.fromProgress === -1);
  if (leave.length) return leave[0];

  // Otherwise advance a token; prefer one landing on a safe square, else the
  // furthest-along token (closest to home).
  const safe = moves.filter((m) => landsSafe(color, m));
  const pool = safe.length ? safe : moves;
  return pool.slice().sort((a, b) => b.fromProgress - a.fromProgress)[0];
}

function landsSafe(color, m) {
  if (m.toProgress >= PATH_HOME_ENTRY) return true; // home column is private/safe
  const ring = (START[color] + m.toProgress) % TRACK_LEN;
  return SAFE_SQUARES.has(ring);
}

function aiMove(color, moves, die) {
  const choice = aiChoose(color, moves);
  const what = choice.capture
    ? "captures " + label(choice.capture)
    : choice.finishes
      ? "reaches home"
      : choice.fromProgress === -1
        ? "leaves the yard"
        : "advances";
  setStatus(label(color) + " rolled " + die + " — " + what);
  applyMove(color, choice.token, die);
}

function endGame(color) {
  state = "over";
  legal = [];
  const youWon = color === HUMAN;
  showOverlay(
    youWon ? "You win!" : label(color) + " wins",
    replayMsg(),
  );
  setStatus(youWon ? "You win!" : label(color) + " wins");
  draw();
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (!started) {
    if (intent === "back") { location.href = "../"; return; }
    if (intent === "enter") { startGame(); return; }
    return;
  }

  if (intent === "back") { location.href = "../"; return; }

  if (state === "over") {
    if (intent === "enter") startGame();
    return;
  }

  // The human's idle state: Enter rolls the die.
  if (state === "idle" && engine.turn === HUMAN) {
    if (intent === "enter") humanRoll();
    return;
  }

  // Picking a token: ←/→ cycle the cursor through movable tokens, Enter moves.
  if (state === "choosing") {
    if (intent === "left") {
      cursorIdx = (cursorIdx + legal.length - 1) % legal.length;
      draw();
    } else if (intent === "right") {
      cursorIdx = (cursorIdx + 1) % legal.length;
      draw();
    } else if (intent === "enter") {
      humanMove(legal[cursorIdx]);
    }
    return;
  }
  // While the AI plays, gameplay intents are ignored (Back handled above).
});

// ---- Rendering ------------------------------------------------------------
function draw() {
  // Clear all dynamic classes + discs.
  for (const cell of cellAt.values()) {
    cell.classList.remove("cell--movable", "cell--cursor", "cell--dest", "cell--dest-active");
    // Remove any token/badge children.
    while (cell.firstChild) cell.removeChild(cell.firstChild);
  }

  // Group tokens by cell so we can show stack counts.
  const byCell = new Map(); // "r,c" -> [{color, token}]
  for (const color of COLORS) {
    for (let token = 0; token < 4; token++) {
      const [r, c] = tokenCell(color, token);
      const key = r + "," + c;
      if (!byCell.has(key)) byCell.set(key, []);
      byCell.get(key).push({ color, token });
    }
  }

  for (const [key, occupants] of byCell) {
    const cell = cellAt.get(key);
    // Draw one disc per distinct colour at this cell (a stack badge shows the
    // total). Tokens of the same colour sharing a cell read as one disc.
    const stacked = occupants.length > 1;
    const seen = new Set();
    for (const { color } of occupants) {
      if (seen.has(color)) continue;
      seen.add(color);
      const disc = document.createElement("div");
      disc.className = "token token--" + color + (stacked ? " token--stacked" : "");
      cell.appendChild(disc);
    }
    if (occupants.length > 1) {
      const badge = document.createElement("div");
      badge.className = "stackcount";
      badge.textContent = String(occupants.length);
      cell.appendChild(badge);
    }
  }

  // Highlight the human's movable tokens, mark where each can land, and show the
  // keyboard cursor while choosing.
  if (state === "choosing") {
    legal.forEach((m, i) => {
      const [r, c] = tokenCell(HUMAN, m.token);
      const cell = cellAt.get(r + "," + c);
      cell.classList.add("cell--movable");
      if (i === cursorIdx) cell.classList.add("cell--cursor");

      // Destination square: a ghost ring showing where this token would go.
      const [dr, dc] = destCellFor(HUMAN, m.toProgress);
      const dest = cellAt.get(dr + "," + dc);
      dest.classList.add("cell--dest");
      if (i === cursorIdx) dest.classList.add("cell--dest-active");
    });
  }

  // Die scene turn tint (the cube itself is animated separately on each roll).
  els.dieScene.className = "die-scene die-scene--" + engine.turn;

  // Roll button: enabled only when it's the human's turn to roll.
  const canRoll = started && state === "idle" && engine.turn === HUMAN;
  els.rollBtn.disabled = !canRoll;

  // Side panel.
  els.turnLabel.textContent = engine.winner ? label(engine.winner) : label(engine.turn);
  els.homeLabel.textContent = homeCount(HUMAN) + "/4";
}

function homeCount(color) {
  return engine.tokens[color].filter((p) => p >= PATH_FINISH).length;
}

// ---- Copy helpers ---------------------------------------------------------
function label(color) {
  return color.charAt(0).toUpperCase() + color.slice(1);
}
function replayMsg() {
  return isTouchDevice() ? "Tap to play again" : "Press <kbd>Enter</kbd> to play again";
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
  buildDie();
  showDieResting();

  els.rollBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!started) { startGame(); return; }
    humanRoll();
  });

  els.mute.addEventListener("click", toggleMute);
  // Mute is a meta control (M key), handled outside the gameplay intent layer.
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });

  draw();             // render the empty board behind the start overlay
  showOverlay("Ludo", isTouchDevice() ? "Tap to start (you are Red)" : "Press Enter to start (you are Red)");
  setStatus(isTouchDevice() ? "Tap to start" : "Press Enter to start");
}

boot();
