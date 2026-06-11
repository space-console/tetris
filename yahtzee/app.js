// Yahtzee (solo) for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the five pip-dice, the
// scorecard (with live previews for unused categories + section totals), and the
// always-visible Roll control, and manages the turn flow (roll → hold → re-roll
// → score, repeated for 13 categories → grand-total summary). The engine owns
// all game logic; this file is input + render only.

import {
  Engine,
  CATEGORIES,
  UPPER_BONUS_THRESHOLD,
} from "./engine.js?v=b62f12be-4d82-4f89-a3e5-c2f1e4b92207";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=b62f12be-4d82-4f89-a3e5-c2f1e4b92207";
import { mountButtons } from "../assets/js/shared/touch.js?v=b62f12be-4d82-4f89-a3e5-c2f1e4b92207";
import { Sound } from "../assets/js/shared/sound.js?v=b62f12be-4d82-4f89-a3e5-c2f1e4b92207";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  dice: document.getElementById("dice"),
  controls: document.getElementById("controls"),
  rollsLabel: document.getElementById("rollsLabel"),
  cardBody: document.getElementById("cardBody"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// Which pip positions light up for each face (1..6), using the 3×3 grid slots.
const PIP_LAYOUT = {
  1: ["cc"],
  2: ["tl", "br"],
  3: ["tl", "cc", "br"],
  4: ["tl", "tr", "bl", "br"],
  5: ["tl", "tr", "cc", "bl", "br"],
  6: ["tl", "tr", "cl", "cr", "bl", "br"],
};
const ALL_POS = ["tl", "tc", "tr", "cl", "cc", "cr", "bl", "bc", "br"];

// Cube rotation (degrees [rotateX, rotateY]) that brings each face to the front,
// matching the face placement in style.css (1 front, 6 back, 2 right, 5 left,
// 3 top, 4 bottom). Used to land a tumbling die on its rolled value.
const DIE_ORIENT = {
  1: [0, 0],
  2: [0, -90],
  3: [-90, 0],
  4: [90, 0],
  5: [0, 90],
  6: [0, 180],
};

// "How to score" hints shown on the scorecard (mirrors the printed Yahtzee card).
const HOW_TO = {
  ones: "Count and add only 1s",
  twos: "Count and add only 2s",
  threes: "Count and add only 3s",
  fours: "Count and add only 4s",
  fives: "Count and add only 5s",
  sixes: "Count and add only 6s",
  threeKind: "Add total of all dice",
  fourKind: "Add total of all dice",
  fullHouse: "Score 25",
  smallStraight: "Score 30",
  largeStraight: "Score 40",
  yahtzee: "Score 50",
  chance: "Total of all 5 dice",
};

// ---- UI state -------------------------------------------------------------
let started = false;       // has the first roll of the game happened?
let focus = "dice";        // "dice" or "card" — which group the cursor lives in
let dieCursor = 0;         // 0..4 die the keyboard/remote cursor hovers
let catCursor = 0;         // index into the OPEN categories the card cursor hovers
let rollBtn = null;        // the always-visible Roll button

// ---- Build the dice (once) ------------------------------------------------
// Each die is a 3D cube: a perspective scene (.die, the tappable button) holding
// a .die-cube with six pip faces. Faces are static; a roll tumbles the cube to
// land the rolled value toward the viewer.
const dieEls = [];     // the .die scene buttons
const cubeEls = [];    // the .die-cube inside each
const dieSpin = [0, 0, 0, 0, 0]; // per-die full-turn counter so repeats still tumble

function buildDice() {
  for (let i = 0; i < 5; i++) {
    const die = document.createElement("button");
    die.type = "button";
    die.className = "die";
    // Dice own their taps; keep the global gesture layer out of them.
    die.setAttribute("data-touch-ignore", "");
    die.setAttribute("aria-label", `Die ${i + 1}`);

    const cube = document.createElement("div");
    cube.className = "die-cube";
    for (let v = 1; v <= 6; v++) {
      const face = document.createElement("div");
      face.className = "die-face die-face--" + v;
      const on = new Set(PIP_LAYOUT[v]);
      for (const pos of ALL_POS) {
        const pip = document.createElement("span");
        pip.className = "pip" + (on.has(pos) ? " pip--on" : "");
        pip.setAttribute("data-pos", pos);
        face.appendChild(pip);
      }
      cube.appendChild(face);
    }
    die.appendChild(cube);

    // pointerdown covers mouse/touch/pen and feels snappier than click.
    die.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      tapDie(i);
    });
    els.dice.appendChild(die);
    dieEls.push(die);
    cubeEls.push(cube);
  }
}

// Orient die `i` to show `value`. When `animate`, add a full extra revolution so
// the cube visibly tumbles (and lands on the value); otherwise snap silently.
function setDieFace(i, value, animate) {
  if (animate) dieSpin[i] += 1;
  const [rx, ry] = DIE_ORIENT[value];
  cubeEls[i].style.transform =
    `rotateX(${rx + 360 * dieSpin[i]}deg) rotateY(${ry + 360 * dieSpin[i]}deg)`;
}

// Tumble the non-held dice to their freshly rolled values; held dice just hold.
function animateRoll() {
  for (let i = 0; i < 5; i++) {
    setDieFace(i, engine.dice[i], !engine.held[i]);
  }
}

// Snap every die to its current value with no animation (boot / new game).
function syncDice() {
  for (let i = 0; i < 5; i++) setDieFace(i, engine.dice[i], false);
}

// ---- Build the scorecard (once) -------------------------------------------
// Section header + one row per category, plus subtotal / bonus / total rows.
// We keep a key → <tr> map for fast updates, and the value <td> for previews.
const catRows = {};   // category key → { tr, valueTd }
let upperSubTd, upperBonusTd, totalTd;

function buildCard() {
  appendSectionHeader("Upper section");
  for (const cat of CATEGORIES) {
    if (cat.section === "upper") appendCatRow(cat);
  }
  appendSubRow("upperSub", "Upper subtotal", (td) => (upperSubTd = td));
  appendSubRow("upperBonus", `Bonus (≥${UPPER_BONUS_THRESHOLD} → +35)`, (td) => (upperBonusTd = td), "sub-row--bonus");

  appendSectionHeader("Lower section");
  for (const cat of CATEGORIES) {
    if (cat.section === "lower") appendCatRow(cat);
  }
  appendTotalRow();
}

function appendSectionHeader(label) {
  const tr = document.createElement("tr");
  tr.className = "section-row";
  const th = document.createElement("th");
  th.textContent = label;
  const how = document.createElement("th");
  how.className = "section-row__how";
  how.textContent = "How to score";
  const val = document.createElement("th");
  val.className = "section-row__score";
  val.textContent = "Score";
  tr.append(th, how, val);
  els.cardBody.appendChild(tr);
}

// A small printed-style die face (used as the upper-section row icon).
function miniDie(face) {
  const d = document.createElement("span");
  d.className = "minidie";
  const on = new Set(PIP_LAYOUT[face]);
  for (const pos of ALL_POS) {
    const pip = document.createElement("span");
    pip.className = "minipip" + (on.has(pos) ? " minipip--on" : "");
    pip.setAttribute("data-pos", pos);
    d.appendChild(pip);
  }
  return d;
}

function appendCatRow(cat) {
  const tr = document.createElement("tr");
  tr.className = "cat-row";
  tr.setAttribute("data-key", cat.key);

  const th = document.createElement("th");
  th.scope = "row";
  th.className = "cat-row__name";
  if (cat.section === "upper") th.appendChild(miniDie(cat.face));
  const label = document.createElement("span");
  label.className = "cat-row__label";
  label.textContent = cat.name;
  th.appendChild(label);
  tr.appendChild(th);

  const how = document.createElement("td");
  how.className = "cat-row__how";
  how.textContent = HOW_TO[cat.key] || "";
  tr.appendChild(how);

  const td = document.createElement("td");
  td.className = "cat-row__value";
  tr.appendChild(td);

  // Tapping a category row scores the current dice there (same as Enter on it).
  tr.setAttribute("data-touch-ignore", "");
  tr.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    tapCategory(cat.key);
  });

  els.cardBody.appendChild(tr);
  catRows[cat.key] = { tr, valueTd: td };
}

function appendSubRow(id, label, assign, extra = "") {
  const tr = document.createElement("tr");
  tr.className = ("sub-row " + extra).trim();
  const th = document.createElement("th");
  th.scope = "row";
  th.colSpan = 2;
  th.textContent = label;
  const td = document.createElement("td");
  assign(td);
  tr.appendChild(th);
  tr.appendChild(td);
  els.cardBody.appendChild(tr);
}

function appendTotalRow() {
  const tr = document.createElement("tr");
  tr.className = "total-row";
  const th = document.createElement("th");
  th.scope = "row";
  th.colSpan = 2;
  th.textContent = "Grand total";
  totalTd = document.createElement("td");
  tr.appendChild(th);
  tr.appendChild(totalTd);
  els.cardBody.appendChild(tr);
}

// ---- The list of currently OPEN (unused) categories, in scorecard order ----
function openKeys() {
  return CATEGORIES.filter((c) => engine.scores[c.key] === null).map((c) => c.key);
}

// ---- Actions --------------------------------------------------------------
function rollAction() {
  sound.resume(); // first interaction unlocks audio (autoplay policy)
  if (engine.isGameOver()) return;
  if (!engine.canRoll()) return;
  if (!started) started = true;

  engine.roll();
  sound.rotate();
  animateRoll();          // tumble the cubes to their new faces
  // After a roll, default the focus to the dice so the player can hold.
  focus = "dice";
  hideOverlay();
  draw();
}

function toggleHoldAtCursor() {
  if (engine.toggleHold(dieCursor)) {
    sound.lock();
    draw();
  }
}

function tapDie(i) {
  sound.resume();
  // Before any roll this turn a die tap acts as a roll (mirrors Enter).
  if (!engine.hasRolled) {
    rollAction();
    return;
  }
  focus = "dice";
  dieCursor = i;
  toggleHoldAtCursor();
}

function tapCategory(key) {
  sound.resume();
  if (engine.scores[key] !== null) return; // already filled
  if (!engine.hasRolled) {
    setStatus("Roll first, then score");
    return;
  }
  scoreCategory(key);
}

// Score the current dice into `key`, fire feedback, and either set up the next
// turn or, if the card is full, show the grand-total summary.
function scoreCategory(key) {
  const result = engine.score(key);
  if (!result) return;

  const cat = CATEGORIES.find((c) => c.key === key);
  if (result.scoredYahtzee) {
    sound.levelUp();
    setStatus(`Yahtzee! ${cat.name} = 50`);
  } else if (result.yahtzeeBonus > 0) {
    sound.levelUp();
    setStatus(`Yahtzee bonus +100! ${cat.name} = ${result.points}`);
  } else {
    sound.clear(1);
    setStatus(`${cat.name} = ${result.points}`);
  }

  // Reposition the card cursor onto the first still-open category.
  catCursor = 0;
  focus = "dice";

  if (engine.isGameOver()) {
    sound.levelUp(); // final fanfare
    showOverlay("Game complete!", grandTotalMsg());
    setStatus(`Final score: ${engine.total()}`);
  }
  draw();
}

function newGame() {
  sound.start();
  engine.reset();
  started = false;
  focus = "dice";
  dieCursor = 0;
  catCursor = 0;
  syncDice();          // reset the cubes to show the fresh dice (no tumble)
  hideOverlay();
  setStatus(isTouchDevice() ? "Tap Roll to start" : "Press Enter to roll");
  draw();
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (intent === "back") {
    location.href = "../";
    return;
  }

  // Game over: any Enter starts a new game.
  if (engine.isGameOver()) {
    if (intent === "enter") newGame();
    return;
  }

  // Before the first roll of a turn, only rolling is meaningful.
  if (!engine.hasRolled) {
    if (intent === "enter") rollAction();
    return;
  }

  if (focus === "dice") {
    switch (intent) {
      case "left":
        dieCursor = (dieCursor + 4) % 5;
        draw();
        break;
      case "right":
        dieCursor = (dieCursor + 1) % 5;
        draw();
        break;
      case "up":
        toggleHoldAtCursor();
        break;
      case "down":
        // Drop into the scorecard to choose where to score.
        focus = "card";
        catCursor = 0;
        draw();
        break;
      case "enter":
        rollAction();
        break;
    }
    return;
  }

  // focus === "card": navigate open categories, Enter scores, up off the top
  // returns to the dice.
  const open = openKeys();
  switch (intent) {
    case "up":
      if (catCursor === 0) {
        focus = "dice";
      } else {
        catCursor -= 1;
      }
      draw();
      break;
    case "down":
      catCursor = Math.min(open.length - 1, catCursor + 1);
      draw();
      break;
    case "enter":
      if (open[catCursor]) scoreCategory(open[catCursor]);
      break;
    case "left":
    case "right":
      // Quick way back to the dice without scoring.
      focus = "dice";
      draw();
      break;
  }
});

// Tab toggles focus between the dice and the scorecard (keyboard convenience).
window.addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !engine.isGameOver() && engine.hasRolled) {
    e.preventDefault();
    focus = focus === "dice" ? "card" : "dice";
    if (focus === "card") catCursor = 0;
    draw();
  } else if (e.key === "r" || e.key === "R") {
    e.preventDefault();
    if (!engine.isGameOver()) rollAction();
  } else if (e.key === "m" || e.key === "M") {
    toggleMute();
  }
});

// ---- Rendering ------------------------------------------------------------
function draw() {
  drawDice();
  drawCard();
  drawRollControl();
  drawStatus();
}

function drawDice() {
  // Dim the tray before the first roll of a turn.
  els.dice.classList.toggle("dice--idle", !engine.hasRolled);

  // Faces are baked into the cubes; the rolled value is shown by orienting the
  // cube (see animateRoll/syncDice). Here we only reflect hold/cursor state.
  for (let i = 0; i < 5; i++) {
    const el = dieEls[i];
    const face = engine.dice[i];
    const held = engine.hasRolled && engine.held[i];
    el.classList.toggle("die--held", held);
    el.classList.toggle(
      "die--cursor",
      focus === "dice" && engine.hasRolled && i === dieCursor && !engine.isGameOver()
    );
    el.setAttribute(
      "aria-label",
      `Die ${i + 1}, showing ${face}${held ? ", held" : ""}`
    );
  }
}

function drawCard() {
  const preview = engine.hasRolled ? engine.previewScores() : {};
  const open = openKeys();
  const cursorKey = focus === "card" ? open[catCursor] : null;

  for (const cat of CATEGORIES) {
    const { tr, valueTd } = catRows[cat.key];
    const filled = engine.scores[cat.key] !== null;
    tr.classList.toggle("cat-row--filled", filled);
    tr.classList.toggle("cat-row--open", !filled);
    tr.classList.toggle("cat-row--cursor", cat.key === cursorKey);

    if (filled) {
      valueTd.textContent = String(engine.scores[cat.key]);
    } else if (engine.hasRolled) {
      // Live preview (greyed): what this category would score with current dice.
      valueTd.textContent = String(preview[cat.key]);
    } else {
      valueTd.textContent = "—";
    }
  }

  upperSubTd.textContent = `${engine.upperSubtotal()} / ${UPPER_BONUS_THRESHOLD}`;
  upperBonusTd.textContent = String(engine.upperBonus());
  totalTd.textContent = String(engine.total());
}

function drawRollControl() {
  const over = engine.isGameOver();
  // At game over the button becomes "New game" and stays enabled to restart;
  // otherwise it's enabled only while rolls remain this turn.
  const enabled = over || engine.canRoll();
  if (rollBtn) {
    rollBtn.disabled = !enabled;
    rollBtn.setAttribute("aria-disabled", String(!enabled));
    rollBtn.textContent = over ? "New game" : engine.hasRolled ? "Re-roll" : "Roll";
  }
  els.rollsLabel.textContent = engine.isGameOver()
    ? "Game complete"
    : `Roll ${engine.rollNumber()} · ${engine.rollsLeft} roll${engine.rollsLeft === 1 ? "" : "s"} left`;
}

function drawStatus() {
  if (engine.isGameOver()) return; // status set by the summary
  if (!started) return;            // keep the start prompt
  if (!engine.hasRolled) {
    setStatus(isTouchDevice() ? "Tap Roll for a new turn" : "Press Enter to roll");
    return;
  }
  if (engine.rollsLeft > 0) {
    setStatus(
      isTouchDevice()
        ? "Tap dice to hold · tap a category to score"
        : "Hold dice (↑), re-roll, or pick a category to score"
    );
  } else {
    setStatus("No rolls left — score a category");
  }
}

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function startMsg() {
  return isTouchDevice() ? "Tap Roll to start" : "Press <kbd>Enter</kbd> to roll";
}
function grandTotalMsg() {
  const restart = isTouchDevice()
    ? "Tap Roll for a new game"
    : "Press <kbd>Enter</kbd> for a new game";
  return `Grand total <strong>${engine.total()}</strong>${
    engine.yahtzeeBonus ? ` · Yahtzee bonus ${engine.yahtzeeBonus}` : ""
  }<br />${restart}`;
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
  buildDice();
  buildCard();
  syncDice();          // show the initial faces on the cubes

  // Always-visible primary control. The button is also the game-over restart
  // (it stays enabled to roll the first turn of the next game via newGame()).
  mountButtons(els.controls, input, [
    {
      label: "Roll",
      onPress: () => (engine.isGameOver() ? newGame() : rollAction()),
      ariaLabel: "Roll dice",
      className: "ctl ctl--primary",
    },
  ]);
  rollBtn = els.controls.querySelector(".ctl--primary");

  input.start();
  els.mute.addEventListener("click", toggleMute);

  draw();
  setStatus(isTouchDevice() ? "Tap Roll to start" : "Press Enter to roll");
  showOverlay("Yahtzee", startMsg());
}

boot();
