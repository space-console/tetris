// Blackjack (you vs dealer) for Space Console — entry point.
// Wires the shared intent stream to the engine, renders the dealer + player
// hands as DOM cards (the dealer's hole card stays face-down until reveal),
// the scoreboard, and the always-visible controls, and manages the table flow
// (bet → deal → hit/stand/double/split → dealer → settle → repeat, with a
// game-over restart). The engine owns all game logic; this file is input +
// render only.

import {
  Engine,
  SUIT_GLYPH,
  RED_SUITS,
  rankLabel,
  handValue,
  MIN_BET,
} from "./engine.js?v=5ba21505-117f-45c9-976a-45c1c49dccbf";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=5ba21505-117f-45c9-976a-45c1c49dccbf";
import { mountButtons } from "../assets/js/shared/touch.js?v=5ba21505-117f-45c9-976a-45c1c49dccbf";
import { Sound } from "../assets/js/shared/sound.js?v=5ba21505-117f-45c9-976a-45c1c49dccbf";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  dealerHand: document.getElementById("dealerHand"),
  dealerTotal: document.getElementById("dealerTotal"),
  playerHands: document.getElementById("playerHands"),
  playerTotal: document.getElementById("playerTotal"),
  credits: document.getElementById("credits"),
  bet: document.getElementById("bet"),
  result: document.getElementById("result"),
  controls: document.getElementById("controls"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

let started = false; // has the player begun the first deal this session?

// Action buttons, captured at boot so we can enable/disable per legality.
const btn = {};

// ---- Card rendering -------------------------------------------------------
// Build one face-up (or, if faceDown, hidden) card element.
function makeCard(card, faceDown) {
  const el = document.createElement("div");
  el.className = "card";
  if (faceDown) {
    el.classList.add("card--back");
    el.setAttribute("aria-label", "Face-down card");
    return el;
  }
  el.classList.toggle("card--red", RED_SUITS.has(card.suit));
  const rank = document.createElement("span");
  rank.className = "card__rank";
  rank.textContent = rankLabel(card.rank);
  const suit = document.createElement("span");
  suit.className = "card__suit";
  suit.textContent = SUIT_GLYPH[card.suit];
  el.appendChild(rank);
  el.appendChild(suit);
  el.setAttribute("aria-label", `${rankLabel(card.rank)} of ${suitName(card.suit)}`);
  return el;
}

function suitName(s) {
  return { S: "spades", H: "hearts", D: "diamonds", C: "clubs" }[s];
}

// Human-readable total, showing soft hands as e.g. "Soft 17".
function totalLabel(cards) {
  if (!cards.length) return "—";
  const { total, soft } = handValue(cards);
  return soft ? `Soft ${total}` : String(total);
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

// The context action behind Enter / the Deal button:
//   over   → full restart (player then bets and deals)
//   bet    → deal a fresh round
//   done   → clear the table for the next round
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
    sound.move(); // deal
    hideOverlay();
    afterDeal();
    return;
  }

  if (engine.phase === "done") {
    engine.nextRound();
    draw();
    return;
  }
}

// Resolve the post-deal state: naturals settle instantly, otherwise play on.
function afterDeal() {
  draw();
  if (engine.phase === "done") finishRound();
  else setStatus(playStatus());
}

function hit() {
  const r = engine.hit();
  if (!r) return;
  sound.lock();
  if (r.event === "bust") sound.drop();
  draw();
  if (engine.phase === "done") finishRound();
  else setStatus(playStatus());
}

function stand() {
  const r = engine.stand();
  if (!r) return;
  sound.move();
  draw();
  if (engine.phase === "done") finishRound();
  else setStatus(playStatus());
}

function double() {
  const r = engine.double();
  if (!r) return;
  sound.lock();
  if (r.event === "doubleBust") sound.drop();
  draw();
  if (engine.phase === "done") finishRound();
  else setStatus(playStatus());
}

function split() {
  const r = engine.split();
  if (!r) return;
  sound.move();
  draw();
  if (engine.phase === "done") finishRound();
  else setStatus(playStatus());
}

// End-of-round handling: pick the right sound, show the result, and handle
// running out of credits.
function finishRound() {
  draw();
  const net = engine.lastNet || 0;
  if (net > 0) sound.levelUp();
  else if (net < 0) sound.drop();
  else sound.move();
  setStatus(engine.message + nextHint());

  if (engine.isBroke()) {
    sound.gameOver();
    showOverlay("Game Over", restartMsg());
    setStatus("Out of credits");
  }
}

function restart() {
  engine.reset();
  started = false;
  hideOverlay();
  setStatus("Place your bet");
  draw();
}

// ---- Intent handling ------------------------------------------------------
input.on((intent) => {
  if (intent === "back") {
    location.href = "../";
    return;
  }

  if (engine.phase === "player") {
    // Arrow mapping during play: ↑ Hit, ↓ Stand, ← Double, → Split, Enter Hit.
    switch (intent) {
      case "up":
      case "enter":
        hit();
        break;
      case "down":
        stand();
        break;
      case "left":
        double();
        break;
      case "right":
        split();
        break;
    }
    return;
  }

  // bet phase / round-over / game-over: Enter deals, clears, or restarts.
  if (intent === "enter") primaryAction();
});

// ---- Rendering ------------------------------------------------------------
function draw() {
  els.credits.textContent = engine.credits;
  els.bet.textContent = engine.bet;
  els.result.textContent = engine.phase === "done" ? resultWord() : "—";

  // Dealer hand. The hole card (index 1) stays face-down while the player is
  // still acting; it flips up once we hand off to the dealer.
  const hideHole = engine.phase === "player";
  els.dealerHand.replaceChildren();
  engine.dealer.forEach((c, i) => {
    els.dealerHand.appendChild(makeCard(c, hideHole && i === 1));
  });
  if (!engine.dealer.length) {
    els.dealerTotal.textContent = "—";
  } else if (hideHole) {
    // Only the up-card counts while the hole is hidden.
    els.dealerTotal.textContent = totalLabel([engine.dealer[0]]);
  } else {
    els.dealerTotal.textContent = totalLabel(engine.dealer);
  }

  // Player hands (one, or two after a split).
  els.playerHands.replaceChildren();
  engine.hands.forEach((h, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "phand";
    if (engine.phase === "player" && idx === engine.active) {
      wrap.classList.add("phand--active");
    }
    if (h.result) wrap.classList.add(`phand--${h.result}`);

    const cards = document.createElement("div");
    cards.className = "hand";
    h.cards.forEach((c) => cards.appendChild(makeCard(c, false)));
    wrap.appendChild(cards);

    const tag = document.createElement("div");
    tag.className = "phand__tag";
    const parts = [totalLabel(h.cards)];
    if (h.doubled) parts.push("×2");
    if (h.result) parts.push(resultWordFor(h.result));
    tag.textContent = parts.join(" · ");
    wrap.appendChild(tag);

    els.playerHands.appendChild(wrap);
  });

  // Single-hand total mirrors into the seat header; split hands show "—" there
  // (each hand carries its own tag instead).
  els.playerTotal.textContent =
    engine.hands.length === 1 ? totalLabel(engine.hands[0].cards) : "—";

  updateControls();
}

// Enable/disable + relabel the action buttons by legality and phase.
function updateControls() {
  const playing = engine.phase === "player";
  setEnabled(btn.hit, playing && engine.canHit());
  setEnabled(btn.stand, playing && engine.canStand());
  setEnabled(btn.double, playing && engine.canDouble());
  setEnabled(btn.split, playing && engine.canSplit());

  if (engine.isBroke()) btn.deal.textContent = "New Game";
  else if (engine.phase === "done") btn.deal.textContent = "Next";
  else btn.deal.textContent = "Deal";
  // During play the primary "Deal" button is dormant.
  setEnabled(btn.deal, engine.phase !== "player");
  setEnabled(btn.betOne, engine.phase === "bet");
  setEnabled(btn.betMax, engine.phase === "bet");
}

function setEnabled(button, on) {
  if (!button) return;
  button.disabled = !on;
  button.classList.toggle("tbtn--off", !on);
}

// ---- Status / copy helpers ------------------------------------------------
function playStatus() {
  const handNo = engine.hands.length > 1 ? ` (hand ${engine.active + 1}/${engine.hands.length})` : "";
  return `Your move${handNo} — Hit, Stand${engine.canDouble() ? ", Double" : ""}${engine.canSplit() ? ", Split" : ""}`;
}

function resultWord() {
  if (engine.hands.length === 1) return resultWordFor(engine.hands[0].result);
  const net = engine.lastNet || 0;
  return net > 0 ? "Win" : net < 0 ? "Lose" : "Push";
}

function resultWordFor(outcome) {
  return {
    blackjack: "Blackjack",
    win: "Win",
    push: "Push",
    lose: "Lose",
    bust: "Bust",
  }[outcome] || "—";
}

function nextHint() {
  return isTouchDevice() ? "  ·  Tap Next" : "  ·  Enter for next";
}

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
function boot() {
  // Always-visible primary controls. They feed the same actions as the keys.
  mountButtons(els.controls, input, [
    { label: "Hit", onPress: hit, ariaLabel: "Hit", className: "ctl" },
    { label: "Stand", onPress: stand, ariaLabel: "Stand", className: "ctl" },
    { label: "Double", onPress: double, ariaLabel: "Double down", className: "ctl" },
    { label: "Split", onPress: split, ariaLabel: "Split", className: "ctl" },
    { label: "Bet", onPress: betOne, ariaLabel: "Cycle bet", className: "ctl" },
    { label: "Max", onPress: betMax, ariaLabel: "Bet max", className: "ctl" },
    { label: "Deal", onPress: primaryAction, ariaLabel: "Deal or next", className: "ctl ctl--primary" },
  ]);
  const buttons = els.controls.querySelectorAll(".ctl");
  [btn.hit, btn.stand, btn.double, btn.split, btn.betOne, btn.betMax, btn.deal] = buttons;

  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    if (k === "m") toggleMute();
    else if (engine.phase === "player") {
      if (k === "h") hit();
      else if (k === "s") stand();
      else if (k === "d") double();
      else if (k === "p") split();
    } else if (engine.phase === "bet") {
      if (k === "b") betOne();
      else if (k === "n") betMax();
    }
  });

  draw();
  setStatus(`Place your bet (min ${MIN_BET}) — Dealer stands on 17, Blackjack pays 3:2`);
  showOverlay("Blackjack", startMsg());
}

boot();
