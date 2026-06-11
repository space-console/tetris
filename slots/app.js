// Slot machine for Space Console — entry point. Wires the shared intent stream
// to the engine, renders the paytable, the three reels, the scoreboard, and the
// always-visible controls, and runs the spin animation (a brief blur of random
// glyphs, reels settling one-by-one) with requestAnimationFrame. The engine
// owns all game logic; this file is input + render + animation only.

import {
  Engine,
  SYMBOLS,
  SYMBOL_BY_KEY,
  PAYTABLE,
  PARTIAL_WINS,
  JACKPOT_KEY,
  REELS,
} from "./engine.js?v=0e1028e3-a8ea-4c79-87ba-b07d69c68b68";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=0e1028e3-a8ea-4c79-87ba-b07d69c68b68";
import { mountButtons } from "../assets/js/shared/touch.js?v=0e1028e3-a8ea-4c79-87ba-b07d69c68b68";
import { Sound } from "../assets/js/shared/sound.js?v=0e1028e3-a8ea-4c79-87ba-b07d69c68b68";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  paytableBody: document.getElementById("paytableBody"),
  reels: document.getElementById("reels"),
  reel: [
    document.getElementById("reel0"),
    document.getElementById("reel1"),
    document.getElementById("reel2"),
  ],
  credits: document.getElementById("credits"),
  bet: document.getElementById("bet"),
  win: document.getElementById("win"),
  controls: document.getElementById("controls"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

let started = false;   // has the player taken the first spin this session?
let spinning = false;  // a spin animation is in flight (locks input + SPIN)
let spinBtn = null;    // the primary SPIN button, for disabling mid-spin

// Spin animation timing (ms): how long each reel blurs before it stops, and the
// stagger so reels settle left → right.
const SPIN_TIME = 650;
const REEL_STAGGER = 350;
const FRAME_GLYPH = 70; // how often the blurring glyph cycles while spinning

// ---- Paytable (built once) -----------------------------------------------
// One row per three-of-a-kind, biggest first, then the partial wins. Rows are
// keyed so the engine result can light the matching row after a spin.
const paytableRows = {};
function buildPaytable() {
  // Three-of-a-kind rows, ordered by descending payout.
  const triples = [...SYMBOLS].sort((a, b) => PAYTABLE[b.key] - PAYTABLE[a.key]);
  for (const sym of triples) {
    const glyph = sym.glyph.repeat(REELS);
    const label = sym.key === JACKPOT_KEY ? `${glyph} JACKPOT` : glyph;
    addRow(sym.key, PAYTABLE[sym.key], label);
  }
  // Partial-win rows.
  for (const p of PARTIAL_WINS) {
    const label = p.key === "twoSevens" ? "7️⃣ 7️⃣ (any two)" : "🍒🍋🍊 (mixed fruit)";
    addRow(p.key, p.pay, label);
  }
}
function addRow(key, pay, label) {
  const tr = document.createElement("tr");
  tr.className = "pay-row";

  const value = document.createElement("td");
  value.className = "pay-row__value";
  value.textContent = pay;
  tr.appendChild(value);

  const combo = document.createElement("td");
  combo.className = "pay-row__combo";
  combo.textContent = label;
  tr.appendChild(combo);

  const mult = document.createElement("td");
  mult.className = "pay-row__mult";
  mult.textContent = "× bet";
  tr.appendChild(mult);

  els.paytableBody.appendChild(tr);
  paytableRows[key] = tr;
}

// ---- Actions --------------------------------------------------------------
function betOne() {
  if (spinning) return;
  engine.betOne();
  sound.move();
  render();
}
function betMax() {
  if (spinning) return;
  engine.betMax();
  sound.move();
  render();
}

// The primary action behind Enter / the SPIN button / a tap:
//   broke   → reset the bankroll (free credits) and play on
//   else    → run a spin if affordable
function primaryAction() {
  sound.resume(); // first interaction unlocks audio (autoplay policy)
  if (spinning) return;

  if (engine.isBroke()) {
    restart();
    return;
  }
  if (!engine.canSpin()) {
    setStatus("Not enough credits for that bet");
    return;
  }
  doSpin();
}

// Deduct the bet, get the result from the engine, then animate the reels to it.
function doSpin() {
  if (!started) {
    sound.start();
    started = true;
  }
  const result = engine.spin(); // deducts the bet, picks the symbols
  if (!result) return;

  spinning = true;
  setSpinDisabled(true);
  hideOverlay();
  clearWinFlash();
  render(); // reflect the deducted bet immediately
  setStatus("Spinning…");
  sound.rotate();

  animateReels(result, () => {
    // All reels have settled — evaluate, pay, and react.
    const outcome = engine.settle();
    spinning = false;
    setSpinDisabled(false);
    render();
    reactToOutcome(outcome);
  });
}

// Animate the three reels: each cycles random glyphs, then locks onto its final
// symbol on a stagger (left → right). Uses requestAnimationFrame, never a
// blocking loop. Calls done() once the last reel has stopped.
function animateReels(finalKeys, done) {
  const start = performance.now();
  const stopAt = finalKeys.map((_, i) => SPIN_TIME + i * REEL_STAGGER);
  const stopped = [false, false, false];
  let lastGlyphTime = 0;

  function frame(nowTs) {
    const elapsed = nowTs - start;

    // Cycle the blurring glyphs at a fixed cadence (decoupled from frame rate).
    const showRandom = nowTs - lastGlyphTime >= FRAME_GLYPH;
    if (showRandom) lastGlyphTime = nowTs;

    for (let i = 0; i < REELS; i++) {
      if (stopped[i]) continue;
      const reelEl = els.reels.children[i];
      if (elapsed >= stopAt[i]) {
        // Lock this reel onto its final symbol.
        stopped[i] = true;
        setReel(i, finalKeys[i]);
        reelEl.classList.remove("reel--spinning");
        reelEl.classList.add("reel--stop");
        // Brief pop, then settle.
        setTimeout(() => reelEl.classList.remove("reel--stop"), 220);
        sound.lock();
      } else if (showRandom) {
        reelEl.classList.add("reel--spinning");
        setReel(i, randomKey());
      }
    }

    if (stopped.every(Boolean)) {
      done();
      return;
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// React to a settled spin: flash + sound for wins, jackpot celebration on the
// top line, and game-over handling when the bankroll is gone.
function reactToOutcome(outcome) {
  if (outcome.win > 0) {
    flashWin(outcome);
    if (outcome.jackpot) {
      sound.levelUp();
      setStatus(`💎 JACKPOT! Won ${outcome.win}! 💎`);
    } else if (outcome.key && SYMBOL_BY_KEY[outcome.key] && PAYTABLE[outcome.key] >= 40) {
      // Big (but non-jackpot) three-of-a-kind also gets the level-up fanfare.
      sound.levelUp();
      setStatus(`${outcome.name} — won ${outcome.win}!`);
    } else {
      sound.clear(1);
      setStatus(`${outcome.name} — won ${outcome.win}!`);
    }
  } else {
    sound.drop();
    setStatus("No win — spin again");
  }

  if (engine.isBroke()) {
    sound.gameOver();
    showOverlay("Out of Credits", restartMsg());
    setStatus("Out of credits");
  }
}

function restart() {
  engine.reset();
  started = false;
  hideOverlay();
  clearWinFlash();
  render();
  setStatus("Fresh credits — press Enter to spin");
}

// ---- Win flash ------------------------------------------------------------
function flashWin(outcome) {
  els.reels.classList.add(outcome.jackpot ? "reels--jackpot" : "reels--win");
  // Light the matching paytable row.
  const row = paytableRows[outcome.key];
  if (row) row.classList.add("pay-row--hit");
}
function clearWinFlash() {
  els.reels.classList.remove("reels--win", "reels--jackpot");
  for (const key of Object.keys(paytableRows)) {
    paytableRows[key].classList.remove("pay-row--hit");
  }
}

// ---- Reel helpers ---------------------------------------------------------
function setReel(i, key) {
  els.reel[i].textContent = SYMBOL_BY_KEY[key].glyph;
}
function randomKey() {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)].key;
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (intent === "back") {
    location.href = "../";
    return;
  }
  if (intent === "enter") primaryAction();
  // up/down could nudge the bet too, mirroring the buttons.
  else if (intent === "up") betOne();
  else if (intent === "down") betMax();
});

// ---- Rendering ------------------------------------------------------------
function render() {
  els.credits.textContent = engine.credits;
  els.bet.textContent = engine.bet;
  els.win.textContent = engine.lastWin;

  if (spinBtn) {
    spinBtn.textContent = engine.isBroke() ? "Free Credits" : "SPIN";
  }
}

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function startMsg() {
  return isTouchDevice() ? "Tap SPIN to play" : "Press <kbd>Enter</kbd> to spin";
}
function restartMsg() {
  return isTouchDevice()
    ? "Tap Free Credits to play again"
    : "Press <kbd>Enter</kbd> for free credits";
}

// ---- Overlay + status -----------------------------------------------------
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
function setSpinDisabled(disabled) {
  if (spinBtn) spinBtn.disabled = disabled;
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
  buildPaytable();

  // Always-visible primary controls. They feed the same actions as the keys.
  mountButtons(els.controls, input, [
    { label: "Bet One", onPress: betOne, ariaLabel: "Bet one coin", className: "ctl" },
    { label: "Bet Max", onPress: betMax, ariaLabel: "Bet maximum", className: "ctl" },
    { label: "SPIN", onPress: primaryAction, ariaLabel: "Spin the reels", className: "ctl ctl--primary" },
  ]);
  spinBtn = els.controls.querySelector(".ctl--primary");

  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
    else if (e.key === "b" || e.key === "B") betOne();
    else if (e.key === "n" || e.key === "N") betMax();
  });

  render();
  setStatus(isTouchDevice() ? "Tap SPIN to play" : "Press Enter to spin");
  showOverlay("Slots", startMsg());
}

boot();
