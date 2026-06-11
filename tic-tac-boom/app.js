// Tic-Tac-Boom for Space Console — entry point.
// Wires the shared intent stream to the pure engine, renders the bomb/combo/
// players, owns the hidden random fuse (the engine is clock-free), and manages a
// native <input> for typing words. The engine owns all rules; this file is
// input + render + the timer loop only.
//
// Game states: loading → menu → pass → playing → over.
//   - pass: a "Ready" gate between hot-seat turns / after a boom, so the next
//     player can take the device before the (live) fuse keeps burning.
//   - playing: the fuse runs; the holder types a word containing the combo.

import { Engine, buildDictionary, buildCombos } from "./engine.js?v=857ce26d-ee18-4390-96f8-6d29d2db3b03";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=857ce26d-ee18-4390-96f8-6d29d2db3b03";
import { Sound } from "../assets/js/shared/sound.js?v=857ce26d-ee18-4390-96f8-6d29d2db3b03";

const input = new Input();
const sound = new Sound();
let engine = null;          // built once the word list loads
let dict = null;            // validation Set, reused across games
let combos = null;          // satisfiable combos, reused across games

const els = {
  status: document.getElementById("status"),
  turn: document.getElementById("turn"),
  bomb: document.getElementById("bomb"),
  combo: document.getElementById("combo"),
  entry: document.getElementById("entry"),
  wordInput: document.getElementById("wordInput"),
  submitBtn: document.getElementById("submitBtn"),
  feedback: document.getElementById("feedback"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  menu: document.getElementById("menu"),
  playersChoices: document.getElementById("playersChoices"),
  livesChoices: document.getElementById("livesChoices"),
  startBtn: document.getElementById("startBtn"),
  readyBtn: document.getElementById("readyBtn"),
  players: document.getElementById("players"),
  usedCount: document.getElementById("usedCount"),
  mute: document.getElementById("mute"),
};

// loading | menu | pass | playing | over
let state = "loading";

// Start-menu choices.
let numPlayers = 3;         // 2–4, default 3
let numLives = 2;           // 1–4, default 2

// ---- The hidden, random fuse ----------------------------------------------
// The bomb timer is intentionally hidden: players feel tension from a pulsing
// bomb, never an exact countdown. A round's fuse is a random duration; the
// remaining time CARRIES OVER between turns (a fast answer leaves a short fuse
// for the next player). We only expose coarse visual urgency (calm → tense).
const FUSE_MIN = 10;        // seconds — shortest a fresh round's fuse can be
const FUSE_MAX = 30;        // seconds — longest
let fuse = 0;               // seconds remaining on the current bomb
let fuseTotal = 0;          // the fuse length when this round started (for ratio)
let lastTick = 0;           // performance.now() of the previous animation frame
let rafId = 0;

function freshFuse() {
  fuseTotal = FUSE_MIN + Math.random() * (FUSE_MAX - FUSE_MIN);
  fuse = fuseTotal;
}

// ---- Cross-folder word list (documented dependency) -----------------------
// We reuse the Scrabble bundle's word list from the SIBLING folder. On the
// deployed site and the dev server every game is served from the same origin,
// so this relative fetch resolves to /scrabble/words.txt. We never modify the
// scrabble folder — only read its ~168k-word list to build our validation Set
// and the satisfiable-combo list.
function loadWords() {
  setStatus("Loading words…");
  showOverlay("Tic-Tac-Boom", "Loading words…");
  hide(els.menu);
  hide(els.readyBtn);
  fetch("../scrabble/words.txt")
    .then((r) => r.text())
    .then((text) => {
      dict = buildDictionary(text);
      combos = buildCombos(dict);          // common, satisfiable 2–3 letter combos
      state = "menu";
      showMenu();
    })
    .catch(() => {
      setStatus("Failed to load words");
      showOverlay("Tic-Tac-Boom", "Could not load the word list. Reload to retry.");
    });
}

// ---- Start menu -----------------------------------------------------------
function buildMenuChoices() {
  // Player-count chips: 2–4.
  els.playersChoices.innerHTML = "";
  for (let n = 2; n <= 4; n++) {
    els.playersChoices.appendChild(chip(String(n), () => { numPlayers = n; renderMenu(); }, "players"));
  }
  // Lives chips: 1–4.
  els.livesChoices.innerHTML = "";
  for (let n = 1; n <= 4; n++) {
    els.livesChoices.appendChild(chip(String(n), () => { numLives = n; renderMenu(); }, "lives"));
  }
}

function chip(label, onPress, group) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip";
  b.textContent = label;
  b.dataset.group = group;
  b.dataset.value = label;
  b.setAttribute("data-touch-ignore", "");
  b.addEventListener("click", onPress);
  return b;
}

function renderMenu() {
  for (const c of els.playersChoices.children) {
    c.classList.toggle("chip--active", Number(c.dataset.value) === numPlayers);
  }
  for (const c of els.livesChoices.children) {
    c.classList.toggle("chip--active", Number(c.dataset.value) === numLives);
  }
}

function showMenu() {
  state = "menu";
  stopLoop();
  setStatus("Choose players & lives");
  els.overlayTitle.textContent = "Tic-Tac-Boom";
  els.overlayMsg.textContent = "Pass the device — a word bomb!";
  show(els.menu);
  hide(els.readyBtn);
  showOverlayEl();
  renderMenu();
  renderPlayers();
}

// ---- Game lifecycle -------------------------------------------------------
function startGame() {
  sound.resume();   // first user gesture unlocks audio (autoplay policy)
  sound.start();
  engine = new Engine({ dict, combos, players: numPlayers, lives: numLives });
  state = "pass";
  hide(els.menu);
  freshFuse();      // a fresh round gets a fresh random fuse
  goToPass(true);
}

// Pass gate: hide the live playfield behind a "Ready" button so the incoming
// player can take the device before the fuse resumes burning.
function goToPass(firstTurn) {
  state = "pass";
  stopLoop();
  blurInput();
  const p = engine.current + 1;
  els.overlayTitle.textContent = `Player ${p}`;
  els.overlayMsg.textContent = firstTurn
    ? "You're up first. The bomb is ticking!"
    : "Pass the device. The bomb is still ticking!";
  hide(els.menu);
  show(els.readyBtn);
  showOverlayEl();
  setStatus(`Player ${p} — get ready`);
  renderPlayers();
  draw();
}

// Begin the live turn for the current holder: hide the overlay, run the fuse,
// focus the input so the native keyboard is ready.
function beginTurn() {
  state = "playing";
  hideOverlay();
  els.feedback.innerHTML = "&nbsp;";
  els.wordInput.value = "";
  draw();
  focusInput();
  lastTick = performance.now();
  startLoop();
}

function endGame() {
  state = "over";
  stopLoop();
  blurInput();
  const p = engine.winner + 1;
  sound.levelUp();
  els.overlayTitle.textContent = `Player ${p} wins!`;
  els.overlayMsg.textContent = isTouchDevice()
    ? "Tap Ready for a new game"
    : "Press Enter for a new game";
  hide(els.menu);
  show(els.readyBtn);
  els.readyBtn.textContent = "New game";
  showOverlayEl();
  setStatus(`Player ${p} wins`);
  renderPlayers();
}

// ---- Word submission ------------------------------------------------------
function submitWord() {
  if (state !== "playing") return;
  const raw = els.wordInput.value;
  const res = engine.submit(raw);
  if (res.ok) {
    sound.clear(1);                 // valid word
    sound.move();                   // ...and the bomb passes on
    flash(`✓ ${res.word}`, "good");
    els.usedCount.textContent = engine.used.size;
    // The fuse CARRIES OVER; we do not reset it on a pass. Hand off to the next
    // surviving player behind a pass gate.
    goToPass(false);
    return;
  }
  flash(rejectMsg(res.reason), "bad");
  els.wordInput.value = "";
  focusInput();
}

function rejectMsg(reason) {
  switch (reason) {
    case "empty": return "Type a word";
    case "nocombo": return `✗ must contain ${engine.combo}`;
    case "notword": return "✗ not in the word list";
    case "used": return "✗ already used this round";
    default: return "✗ invalid";
  }
}

// ---- The fuse loop --------------------------------------------------------
function startLoop() {
  if (rafId) return;
  rafId = requestAnimationFrame(tick);
}
function stopLoop() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function tick(nowMs) {
  rafId = requestAnimationFrame(tick);
  if (state !== "playing") return;
  const dt = Math.min(0.1, (nowMs - lastTick) / 1000);  // clamp tab-switch gaps
  lastTick = nowMs;
  fuse -= dt;
  if (fuse <= 0) {
    fuse = 0;
    boom();
    return;
  }
  renderBomb();
}

function boom() {
  stopLoop();
  blurInput();
  const res = engine.explode();
  sound.gameOver();                  // explosion
  if (res.eliminated) sound.drop();  // a player knocked out
  renderPlayers();

  if (res.winner !== null) { endGame(); return; }

  // Fresh round for the next survivor: new random fuse, cleared used words.
  els.usedCount.textContent = engine.used.size;
  freshFuse();
  const holder = engine.current + 1;
  const downed = res.holder + 1;
  state = "pass";
  els.overlayTitle.textContent = "💥 BOOM!";
  els.overlayMsg.textContent = res.eliminated
    ? `Player ${downed} is out! Player ${holder}, you're up.`
    : `Player ${downed} lost a life. Player ${holder}, you're up.`;
  hide(els.menu);
  show(els.readyBtn);
  els.readyBtn.textContent = "Ready";
  showOverlayEl();
  setStatus(`Boom! Player ${holder} — get ready`);
  draw();
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.turn.textContent = `Player ${engine.current + 1}`;
  els.combo.textContent = engine.combo;
  els.usedCount.textContent = engine.used.size;
  renderBomb();
}

// Coarse visual urgency only — NEVER the exact seconds. Below ~30% fuse the
// bomb pulses faster ("tense"); we also vary pulse speed continuously via a CSS
// custom property so it visibly quickens as time runs out.
function renderBomb() {
  if (!engine) return;
  const ratio = fuseTotal > 0 ? Math.max(0, fuse / fuseTotal) : 0;
  // Pulse period shrinks from ~1.1s (calm) to ~0.28s (frantic).
  const period = 0.28 + ratio * 0.82;
  els.bomb.style.setProperty("--pulse", period.toFixed(2) + "s");
  els.bomb.classList.toggle("bomb--tense", ratio < 0.3);
}

function renderPlayers() {
  if (!engine) {
    // Menu preview: show the chosen player count with full lives.
    els.players.innerHTML = "";
    for (let i = 0; i < numPlayers; i++) {
      els.players.appendChild(playerRow(i, numLives, false, false));
    }
    return;
  }
  els.players.innerHTML = "";
  for (let i = 0; i < engine.numPlayers; i++) {
    const lives = engine.lives[i];
    const out = lives === 0;
    const active = state !== "menu" && state !== "over" && i === engine.current && !out;
    els.players.appendChild(playerRow(i, lives, active, out));
  }
}

function playerRow(i, lives, active, out) {
  const li = document.createElement("li");
  li.className = "player" + (active ? " player--active" : "") + (out ? " player--out" : "");
  const name = document.createElement("span");
  name.className = "player__name";
  name.textContent = `Player ${i + 1}`;
  const hearts = document.createElement("span");
  hearts.className = "player__lives";
  hearts.textContent = out ? "☠" : "❤".repeat(lives);
  li.append(name, hearts);
  return li;
}

function flash(msg, kind) {
  els.feedback.textContent = msg;
  els.feedback.className = "feedback feedback--" + kind;
}

// ---- Native input focus handling ------------------------------------------
// The shared Input layer listens on window keydown and preventDefaults mapped
// keys (arrows, Space, Enter, plus WASD). That would BOTH hijack Enter and eat
// "w/a/s/d" letters while typing. Our approach:
//   1) We still call input.start() so the .touch class + the Back gesture work.
//   2) We capture keydown on the window at the CAPTURE phase, BEFORE the shared
//      listener, and stopImmediatePropagation() for any key while the word
//      input is focused — except Escape/Back, which we let flow through to the
//      shared layer so Back still leaves to the menu/hub. This guarantees every
//      letter, Space and Enter reaches the <input> untouched.
//   3) The <input> lives in a <form>; submit (Enter or the Go button) is handled
//      by the form's submit event, so Enter checks the word natively.
// Net effect: typing is fully native; the shared intent stream only drives menu/
// pass/over navigation when the input is NOT focused.
function inputFocused() {
  return document.activeElement === els.wordInput;
}
function focusInput() {
  // Defer so the overlay has fully hidden before the keyboard pops on mobile.
  requestAnimationFrame(() => els.wordInput.focus());
}
function blurInput() {
  els.wordInput.blur();
}

// ---- Shared intent handling (menu / pass / over only) ---------------------
// While playing, typing owns the keyboard; navigation intents are ignored here
// (Enter is handled by the form). Back always works (it's a gesture/Escape that
// bypasses the input via the capture guard below).
input.on((intent) => {
  if (intent === "back") {
    if (state === "menu") { location.href = "../"; return; }
    showMenu();
    return;
  }
  if (intent !== "enter") return;
  switch (state) {
    case "menu": startGame(); break;
    case "pass": beginTurn(); break;
    case "over": showMenu(); break;
    default: break;        // playing: Enter is the form's job
  }
});

// ---- Overlay / status helpers ---------------------------------------------
function show(el) { el.classList.remove("menu--hidden", "menu__item--hidden"); }
function hide(el) {
  el.classList.add(el === els.menu ? "menu--hidden" : "menu__item--hidden");
}
function showOverlayEl() { els.overlay.classList.remove("overlay--hidden"); }
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.textContent = msg;
  showOverlayEl();
}
function setStatus(text) { els.status.textContent = text; }

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
  input.start();   // adds .touch + Back gesture; we guard typing keys below

  // Capture-phase guard: while the word input is focused, keep every typing key
  // (letters/Space/Enter) from reaching the shared Input listener. Escape/Back
  // is allowed through so the player can still bail to the menu.
  window.addEventListener("keydown", (e) => {
    if (!inputFocused()) return;
    if (e.key === "Escape") return;             // let Back reach the shared layer
    e.stopImmediatePropagation();               // typing stays native
  }, true);

  // Form submit = check the word (Enter key or the Go button, natively).
  els.entry.addEventListener("submit", (e) => {
    e.preventDefault();
    submitWord();
  });

  // Menu interactions.
  buildMenuChoices();
  els.startBtn.addEventListener("click", () => { if (state === "menu") startGame(); });
  els.readyBtn.addEventListener("click", () => {
    if (state === "pass") beginTurn();
    else if (state === "over") showMenu();
  });

  // Mute (meta, outside the gameplay intent layer).
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if ((e.key === "m" || e.key === "M") && !inputFocused()) toggleMute();
  });

  loadWords();
}

boot();
