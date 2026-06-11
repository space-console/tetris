// Video Poker (Jacks or Better) for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the five-card hand, the
// paytable, the scoreboard, and the always-visible controls, and manages the
// table flow (bet → deal → hold → draw → repeat, with a game-over restart). The
// engine owns all game logic; this file is input + render only.

import {
  Engine,
  HAND_RANKS,
  PAYTABLE,
  ROYAL_FLUSH_BET5_BONUS,
  SUIT_GLYPH,
  RED_SUITS,
  rankLabel,
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
  hand: document.getElementById("hand"),
  credits: document.getElementById("credits"),
  bet: document.getElementById("bet"),
  win: document.getElementById("win"),
  handName: document.getElementById("handName"),
  controls: document.getElementById("controls"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// idle | draw | over.  "idle" = waiting to deal (engine.phase === "bet" with
// the overlay up before the very first deal or after game over); once dealt we
// follow engine.phase. We keep a small UI state for cursor + started flags.
let started = false;       // has the player begun the first deal this session?
let cursor = 0;            // 0..4 card the keyboard/remote cursor hovers
const paytableRows = {};   // hand key → <tr> for highlight toggling

// ---- Build the paytable (once) -------------------------------------------
// One row per paying hand (skip "nothing"); each shows the per-coin payout.
function buildPaytable() {
  for (const { key, name } of HAND_RANKS) {
    if (key === "nothing") continue;
    const tr = document.createElement("tr");
    tr.className = "pay-row";

    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = name;
    tr.appendChild(th);

    const td = document.createElement("td");
    // Royal Flush carries the bet-5 jackpot note inline.
    td.textContent =
      key === "royal"
        ? `${PAYTABLE[key]}  (${ROYAL_FLUSH_BET5_BONUS} @ bet 5)`
        : String(PAYTABLE[key]);
    td.className = "pay-row__value";
    tr.appendChild(td);

    els.paytableBody.appendChild(tr);
    paytableRows[key] = tr;
  }
}

// ---- Build the five cards (once) -----------------------------------------
const cardEls = [];
function buildHand() {
  for (let i = 0; i < 5; i++) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card";
    // Cards own their taps; keep the global gesture layer out of them.
    card.setAttribute("data-touch-ignore", "");
    card.setAttribute("aria-label", `Card ${i + 1}`);
    card.innerHTML =
      '<span class="card__held">HELD</span>' +
      '<span class="card__rank"></span>' +
      '<span class="card__suit"></span>';
    // pointerdown covers mouse/touch/pen and feels snappier than click.
    card.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      tapCard(i);
    });
    els.hand.appendChild(card);
    cardEls.push(card);
  }
}

// Tapping a card: in draw phase it jumps the cursor there and toggles HOLD;
// otherwise (idle / over) a tap deals / restarts, matching the Enter path.
function tapCard(i) {
  if (engine.phase === "draw") {
    cursor = i;
    toggleHoldAtCursor();
    return;
  }
  primaryAction();
}

// ---- Actions --------------------------------------------------------------
function betOne() {
  if (engine.betOne()) {
    sound.move();
    draw();
  }
}
function betMax() {
  if (engine.betMax()) {
    sound.move();
    draw();
  }
}

function toggleHoldAtCursor() {
  if (engine.toggleHold(cursor)) {
    sound.lock();
    draw();
  }
}

// The context action behind Enter / the Deal·Draw button:
//   over   → full restart, then nothing else (player bets, then deals)
//   bet    → deal a fresh hand
//   draw   → draw (replace non-held), evaluate, pay
function primaryAction() {
  sound.resume(); // first interaction unlocks audio (autoplay policy)

  if (engine.isBroke()) {
    restart();
    return;
  }

  if (engine.phase === "bet") {
    if (!engine.canDeal()) {
      setStatus("Not enough credits for that bet");
      return;
    }
    if (!started) {
      sound.start();
      started = true;
    }
    engine.deal();
    cursor = 0;
    sound.move(); // deal
    hideOverlay();
    draw();
    return;
  }

  if (engine.phase === "draw") {
    const result = engine.draw();
    sound.drop(); // draw
    draw();
    if (result.win > 0) {
      sound.levelUp();
      setStatus(`${result.name} — won ${result.win}!`);
    } else {
      setStatus(`${result.name} — no win`);
    }
    if (engine.isBroke()) {
      sound.gameOver();
      showOverlay("Game Over", restartMsg());
      setStatus("Out of credits");
    }
  }
}

function restart() {
  engine.reset();
  started = false;
  cursor = 0;
  hideOverlay();
  setStatus("Jacks or Better");
  draw();
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (intent === "back") {
    location.href = "../";
    return;
  }

  if (engine.phase === "draw") {
    switch (intent) {
      case "left":
        cursor = (cursor + 4) % 5;
        draw();
        break;
      case "right":
        cursor = (cursor + 1) % 5;
        draw();
        break;
      case "up":
        toggleHoldAtCursor();
        break;
      case "enter":
        primaryAction();
        break;
    }
    return;
  }

  // bet phase / game over: Enter deals or restarts.
  if (intent === "enter") primaryAction();
});

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.credits.textContent = engine.credits;
  els.bet.textContent = engine.bet;
  els.win.textContent = engine.lastWin;
  els.handName.textContent = engine.lastHandKey
    ? HAND_RANKS.find((h) => h.key === engine.lastHandKey).name
    : "—";

  // Highlight the paytable row we just hit (only on a completed paying hand).
  for (const key of Object.keys(paytableRows)) {
    paytableRows[key].classList.toggle(
      "pay-row--hit",
      engine.phase === "bet" && engine.lastHandKey === key && key !== "nothing"
    );
  }

  // Cards.
  for (let i = 0; i < 5; i++) {
    const el = cardEls[i];
    const card = engine.hand[i];
    if (!card) {
      el.classList.add("card--empty");
      el.classList.remove("card--red", "card--held", "card--cursor");
      el.querySelector(".card__rank").textContent = "";
      el.querySelector(".card__suit").textContent = "";
      el.setAttribute("aria-label", `Card ${i + 1}, empty`);
      continue;
    }
    el.classList.remove("card--empty");
    el.querySelector(".card__rank").textContent = rankLabel(card.rank);
    el.querySelector(".card__suit").textContent = SUIT_GLYPH[card.suit];
    el.classList.toggle("card--red", RED_SUITS.has(card.suit));
    const held = engine.phase === "draw" && engine.held[i];
    el.classList.toggle("card--held", held);
    el.classList.toggle(
      "card--cursor",
      engine.phase === "draw" && i === cursor
    );
    el.setAttribute(
      "aria-label",
      `${rankLabel(card.rank)} of ${suitName(card.suit)}${held ? ", held" : ""}`
    );
  }

  // Context button label: "Deal" before a hand, "Draw" during holds.
  if (dealDrawBtn) {
    if (engine.isBroke()) dealDrawBtn.textContent = "New Game";
    else dealDrawBtn.textContent = engine.phase === "draw" ? "Draw" : "Deal";
  }

  // Status line during play.
  if (engine.phase === "draw") {
    setStatus(isTouchDevice() ? "Tap cards to hold, then Draw" : "Hold cards, then Draw");
  }
}

function suitName(s) {
  return { S: "spades", H: "hearts", D: "diamonds", C: "clubs" }[s];
}

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function startMsg() {
  return isTouchDevice() ? "Tap Deal to start" : "Press <kbd>Enter</kbd> to deal";
}
function restartMsg() {
  return isTouchDevice()
    ? "Tap New Game to play again"
    : "Press <kbd>Enter</kbd> to play again";
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
let dealDrawBtn = null;

function boot() {
  buildPaytable();
  buildHand();

  // Always-visible primary controls. They feed the same actions as the keys.
  mountButtons(els.controls, input, [
    { label: "Bet One", onPress: betOne, ariaLabel: "Bet one coin", className: "ctl" },
    { label: "Bet Max", onPress: betMax, ariaLabel: "Bet maximum", className: "ctl" },
    { label: "Deal", onPress: primaryAction, ariaLabel: "Deal or draw", className: "ctl ctl--primary" },
  ]);
  dealDrawBtn = els.controls.querySelector(".ctl--primary");

  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
    else if (e.key === "b" || e.key === "B") betOne();
    else if (e.key === "n" || e.key === "N") betMax();
  });

  draw();
  setStatus(isTouchDevice() ? "Tap Deal to start" : "Press Enter to deal");
  showOverlay("Video Poker", startMsg());
}

boot();
