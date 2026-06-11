// Texas Hold'em for Space Console — entry point.
// Wires the shared intent stream + always-visible action buttons to the pure
// poker engine, renders the table (opponents, community, your hole cards, pot,
// last actions), drives the AI bots on a timer, and manages the game states
// (idle → playing → showdown → over). The engine owns all rules and hand
// evaluation; this file is input + render + the AI heuristics.

import { Engine, RANK_LABEL, SUIT_SYMBOL, evaluate, compareScore } from "./engine.js?v=297692ec-9d04-48fc-b8ba-8d23c1efb13f";
import { Input, isTouchDevice } from "../assets/js/shared/input.js?v=297692ec-9d04-48fc-b8ba-8d23c1efb13f";
import { Sound } from "../assets/js/shared/sound.js?v=297692ec-9d04-48fc-b8ba-8d23c1efb13f";

const engine = new Engine();
const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  pot: document.getElementById("pot"),
  community: document.getElementById("community"),
  seatsTop: document.getElementById("seatsTop"),
  seatYou: document.getElementById("seatYou"),
  actions: document.getElementById("actions"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// idle | playing | showdown | over
let state = "idle";
let raiseTo = 0;          // the human's currently-selected total raise amount
let selectedAction = 0;   // index of the keyboard-highlighted action button
let actionList = [];      // [{ key, label, run, disabled, className }]
let botTimer = null;
let bestCardKeys = new Set(); // "seat-i" / "comm-i" keys to highlight at showdown

// ---- AI -------------------------------------------------------------------
// Heuristic strength in [0,1]: preflop from a Chen-style hole-card score, later
// streets from the made hand's category (normalised) plus a little noise.
function preflopStrength(hole) {
  const [a, b] = hole;
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const pair = a.rank === b.rank;
  const suited = a.suit === b.suit;
  const gap = hi - lo;
  // Base on the high card (A=1.0 .. 2≈0.14).
  let s = (hi - 2) / 12 * 0.5;
  if (pair) s += 0.32 + (hi - 2) / 12 * 0.18; // pairs are strong, scale with rank
  else {
    s += (lo - 2) / 12 * 0.15;
    if (suited) s += 0.08;
    if (gap === 1) s += 0.06;       // connected
    else if (gap === 2) s += 0.03;
    else if (gap >= 5) s -= 0.05;   // wide gap penalty
  }
  return Math.max(0.05, Math.min(1, s));
}

function madeStrength(hole, community) {
  const { score } = evaluate([...hole, ...community]);
  const cat = score[0];
  // Map category to a coarse strength; tie-break with the top card.
  const base = [0.18, 0.40, 0.55, 0.66, 0.74, 0.80, 0.88, 0.95, 1.0][cat] ?? 0.2;
  const topCard = (score[1] || 2) / 14 * 0.06;
  return Math.min(1, base + topCard);
}

function botStrength(p) {
  if (engine.community.length === 0) return preflopStrength(p.hole);
  return madeStrength(p.hole, engine.community);
}

// Decide and apply one bot action for the seat to act.
function botAct(seat) {
  const p = engine.players[seat];
  let strength = botStrength(p);
  // A little randomness: occasional bluff (strength bump) or timidity.
  const roll = Math.random();
  if (roll < 0.08) strength = Math.min(1, strength + 0.35); // bluff
  else strength += (Math.random() - 0.5) * 0.12;            // jitter
  strength = Math.max(0, Math.min(1, strength));

  const owe = engine.callAmount(seat);
  const canCheck = engine.canCheck(seat);
  const pot = engine.pot();
  const potOdds = owe / Math.max(1, pot + owe);

  if (canCheck) {
    // No bet to face: mostly check, sometimes bet/raise with a strong hand.
    if (strength > 0.62 && Math.random() < 0.6) {
      const to = engine.minRaiseTo(seat);
      const bet = pickBetSize(seat, strength);
      if (to != null && bet >= to) { engine.act("raise", bet); onChips(); return; }
      if (to != null) { engine.act("raise", to); onChips(); return; }
    }
    engine.act("check");
    return;
  }

  // Facing a bet. Fold weak hands when the price is high.
  if (strength < 0.30 + potOdds * 0.4) {
    // ...but defend cheaply sometimes (don't fold for tiny calls every time).
    if (owe <= engine.bigBlind && Math.random() < 0.5) { engine.act("call"); onChips(); return; }
    engine.act("fold");
    return;
  }

  // Strong hands raise; medium hands call.
  if (strength > 0.72 && Math.random() < 0.55) {
    const to = engine.minRaiseTo(seat);
    const bet = pickBetSize(seat, strength);
    if (to != null && bet >= to) { engine.act("raise", bet); onChips(); return; }
    if (to != null) { engine.act("raise", to); onChips(); return; }
  }
  // Shove with a monster occasionally.
  if (strength > 0.92 && Math.random() < 0.3 && engine.minRaiseTo(seat) == null) {
    engine.act("allin"); onChips(); return;
  }
  engine.act("call");
  onChips();
}

// Choose a raise total roughly proportional to pot + hand strength, clamped to
// the legal [minRaiseTo, all-in] range.
function pickBetSize(seat, strength) {
  const pot = engine.pot();
  const min = engine.minRaiseTo(seat) ?? 0;
  const max = engine.allInTo(seat);
  const target = engine.currentBet + Math.round(pot * (0.4 + strength * 0.5));
  return Math.max(min, Math.min(max, target));
}

// ---- Game flow ------------------------------------------------------------
function startGame() {
  sound.resume();
  sound.start();
  engine.resetGame();
  state = "playing";
  hideOverlay();
  dealHand();
}

function dealHand() {
  if (engine.isGameOver()) { endGame(); return; }
  bestCardKeys = new Set();
  engine.startHand();
  state = "playing";
  sound.move(); // the deal
  raiseTo = 0;
  selectedAction = 0;
  hideOverlay();
  render();
  scheduleTurn();
}

// Drive whichever seat is to act: bots act on a short delay; the human waits for
// a button / key.
function scheduleTurn() {
  clearTimeout(botTimer);
  if (state !== "playing") return;
  if (engine.street === "showdown") { onShowdown(); return; }
  const seat = engine.toAct;
  if (seat < 0) return;
  if (engine.players[seat].isHuman) {
    render();
    return;
  }
  // Bot: think briefly, then act, then continue.
  render();
  botTimer = setTimeout(() => {
    if (state !== "playing") return;
    botAct(seat);
    render();
    scheduleTurn();
  }, 650);
}

// Apply a human action, then hand control back to the loop.
function humanAct(action, amount) {
  if (state !== "playing") return;
  const seat = engine.toAct;
  if (seat < 0 || !engine.players[seat].isHuman) return;
  let ok;
  if (action === "raise") ok = engine.act("raise", amount);
  else ok = engine.act(action);
  if (!ok) return;
  if (action === "raise" || action === "allin" || action === "call") onChips();
  raiseTo = 0;
  render();
  scheduleTurn();
}

function onChips() { sound.lock(); }

function onShowdown() {
  state = "showdown";
  clearTimeout(botTimer);
  computeBestCards();
  render();

  const res = engine.results;
  const names = res.winnersBySeat.map((s) => engine.players[s].name);
  const human = res.winnersBySeat.includes(0);
  if (human) sound.levelUp();

  let title, msg;
  if (!res.showdown) {
    title = names[0] + " wins";
    msg = "Everyone else folded.";
  } else {
    const parts = res.winnersBySeat.map((s) => {
      const e = res.evaluations[s];
      return `${engine.players[s].name} (${e.name})`;
    });
    title = names.length > 1 ? "Split pot" : names[0] + " wins";
    msg = parts.join(" · ");
  }

  if (engine.isGameOver()) {
    if (engine.players[0].out) sound.gameOver();
    // Show the hand result first; the overlay's "Enter / tap" then starts a new
    // game (handled by the showdown branch in the input handler via isGameOver).
    state = "showdown";
    gameOverOverlay();
    return;
  }

  showOverlay(title, msg + "<br>" + nextMsg());
  setStatus(title);
}

function gameOverOverlay() {
  const winner = engine.gameWinner();
  if (engine.players[0].out) {
    showOverlay("Busted", "You ran out of chips.<br>" + restartMsg());
  } else if (winner) {
    showOverlay(winner.isHuman ? "You win!" : winner.name + " wins", "Last player standing.<br>" + restartMsg());
  } else {
    showOverlay("Game over", restartMsg());
  }
  setStatus("Game over");
}

function endGame() {
  state = "over";
  gameOverOverlay();
}

// ---- Input ----------------------------------------------------------------
input.on((intent) => {
  // Meta: Back always exits to the hub.
  if (intent === "back") { location.href = "../"; return; }

  if (state === "idle" || state === "over") {
    if (intent === "enter") startGame();
    return;
  }

  if (state === "showdown") {
    if (intent === "enter") {
      if (engine.isGameOver()) startGame(); else dealHand();
    }
    return;
  }

  // Playing: only meaningful when it's the human's turn.
  if (state !== "playing") return;
  const seat = engine.toAct;
  if (seat < 0 || !engine.players[seat].isHuman) return;

  switch (intent) {
    case "left":
      selectedAction = (selectedAction + actionList.length - 1) % actionList.length;
      while (actionList[selectedAction].disabled) selectedAction = (selectedAction + actionList.length - 1) % actionList.length;
      render();
      break;
    case "right":
      selectedAction = (selectedAction + 1) % actionList.length;
      while (actionList[selectedAction].disabled) selectedAction = (selectedAction + 1) % actionList.length;
      render();
      break;
    case "up": adjustRaise(+1); break;
    case "down": adjustRaise(-1); break;
    case "enter": {
      const a = actionList[selectedAction];
      if (a && !a.disabled) a.run();
      break;
    }
  }
});

// Step the raise sizer by one big blind (clamped to legal range).
function adjustRaise(dir) {
  const seat = engine.toAct;
  if (seat < 0 || !engine.players[seat].isHuman) return;
  const min = engine.minRaiseTo(seat);
  if (min == null) return; // can't raise (would only be an all-in)
  const max = engine.allInTo(seat);
  if (raiseTo < min) raiseTo = min;
  raiseTo = Math.max(min, Math.min(max, raiseTo + dir * engine.bigBlind));
  render();
}

// ---- Rendering ------------------------------------------------------------
function render() {
  els.pot.textContent = "Pot " + engine.pot();
  renderCommunity();
  renderSeats();
  renderActions();
  if (state === "playing") {
    const seat = engine.toAct;
    if (seat >= 0 && engine.players[seat].isHuman) setStatus("Your move");
    else if (seat >= 0) setStatus(engine.players[seat].name + " thinking…");
  }
}

function cardEl(card, { faceDown = false, best = false } = {}) {
  const el = document.createElement("div");
  el.className = "card";
  if (faceDown) {
    el.classList.add("card--back");
    el.textContent = "";
    return el;
  }
  const red = card.suit === "h" || card.suit === "d";
  if (red) el.classList.add("card--red");
  if (best) el.classList.add("card--best");
  const r = document.createElement("span");
  r.className = "card__rank";
  r.textContent = RANK_LABEL[card.rank];
  const s = document.createElement("span");
  s.className = "card__suit";
  s.textContent = SUIT_SYMBOL[card.suit];
  el.append(r, s);
  return el;
}

function placeholderCard() {
  const el = document.createElement("div");
  el.className = "card card--placeholder";
  return el;
}

function renderCommunity() {
  els.community.innerHTML = "";
  for (let i = 0; i < 5; i++) {
    if (i < engine.community.length) {
      els.community.appendChild(
        cardEl(engine.community[i], { best: bestCardKeys.has("comm-" + i) })
      );
    } else {
      els.community.appendChild(placeholderCard());
    }
  }
}

function seatEl(seat) {
  const p = engine.players[seat];
  const wrap = document.createElement("div");
  wrap.className = "seat";
  if (state === "playing" && engine.toAct === seat) wrap.classList.add("seat--active");
  if (p.folded && !p.out) wrap.classList.add("seat--folded");
  if (state === "showdown" && engine.results && engine.results.winnersBySeat.includes(seat))
    wrap.classList.add("seat--winner");

  const name = document.createElement("div");
  name.className = "seat__name";
  name.textContent = p.name;
  if (engine.button === seat && !p.out) {
    const d = document.createElement("span");
    d.className = "seat__dealer";
    d.textContent = "D";
    d.title = "Dealer button";
    name.appendChild(d);
  }

  const chips = document.createElement("div");
  chips.className = "seat__chips";
  chips.textContent = p.chips + " chips";

  const cards = document.createElement("div");
  cards.className = "cards";
  const reveal = state === "showdown" && engine.results && engine.results.showdown
    && !p.folded && !p.out;
  if (p.hole.length === 2 && !p.out) {
    if (p.isHuman || reveal) {
      cards.appendChild(cardEl(p.hole[0], { best: bestCardKeys.has(seat + "-0") }));
      cards.appendChild(cardEl(p.hole[1], { best: bestCardKeys.has(seat + "-1") }));
    } else if (!p.folded) {
      cards.appendChild(cardEl(p.hole[0], { faceDown: true }));
      cards.appendChild(cardEl(p.hole[1], { faceDown: true }));
    }
  }

  const bet = document.createElement("div");
  bet.className = "seat__bet";
  bet.textContent = p.bet > 0 ? "Bet " + p.bet : "";

  const action = document.createElement("div");
  action.className = "seat__action";
  action.textContent = p.lastAction || "";

  wrap.append(name, chips, cards, bet, action);
  return wrap;
}

function renderSeats() {
  els.seatsTop.innerHTML = "";
  for (let seat = 1; seat < engine.players.length; seat++) {
    els.seatsTop.appendChild(seatEl(seat));
  }
  els.seatYou.innerHTML = "";
  els.seatYou.appendChild(seatEl(0));
}

// Build the human action buttons (always visible). Illegal actions are disabled.
function renderActions() {
  els.actions.innerHTML = "";
  const seat = engine.toAct;
  const myTurn = state === "playing" && seat === 0 && engine.players[0].isHuman
    && !engine.players[0].folded && !engine.players[0].allIn;

  if (!myTurn) {
    actionList = [];
    // Show a hint instead of buttons when it isn't the human's turn.
    const msg = document.createElement("div");
    msg.className = "raise-sizer__label";
    if (state === "showdown") msg.textContent = isTouchDevice() ? "Tap for next hand" : "Enter for next hand";
    else if (state === "playing") msg.textContent = "Waiting…";
    else msg.textContent = isTouchDevice() ? "Tap to start" : "Press Enter to start";
    els.actions.appendChild(msg);
    return;
  }

  const owe = engine.callAmount(0);
  const canCheck = engine.canCheck(0);
  const minTo = engine.minRaiseTo(0);
  const maxTo = engine.allInTo(0);

  // Clamp the working raise amount into the legal window.
  if (minTo != null) {
    if (raiseTo < minTo) raiseTo = minTo;
    if (raiseTo > maxTo) raiseTo = maxTo;
  }

  actionList = [];

  // Fold.
  actionList.push({
    label: "Fold", className: "abtn--fold", disabled: false,
    run: () => humanAct("fold"),
  });

  // Check / Call (label adapts).
  actionList.push({
    label: canCheck ? "Check" : "Call " + owe,
    className: "abtn--call", disabled: false,
    run: () => humanAct(canCheck ? "check" : "call"),
  });

  // Raise (only when a full raise is legal and it isn't simply an all-in).
  const canRaise = minTo != null && minTo < maxTo;
  actionList.push({
    label: canRaise ? "Raise " + raiseTo : "Raise",
    className: "abtn--raise", disabled: !canRaise,
    run: () => humanAct("raise", raiseTo),
  });

  // All-in (always available while we have chips).
  actionList.push({
    label: "All-in " + maxTo,
    className: "abtn--allin", disabled: engine.players[0].chips <= 0,
    run: () => humanAct("allin"),
  });

  // Keep the highlighted index on a legal button.
  if (selectedAction >= actionList.length) selectedAction = 0;
  if (actionList[selectedAction].disabled) {
    selectedAction = actionList.findIndex((a) => !a.disabled);
    if (selectedAction < 0) selectedAction = 0;
  }

  // Render the buttons.
  actionList.forEach((a, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "abtn " + a.className + (i === selectedAction ? " abtn--selected" : "");
    b.textContent = a.label;
    b.disabled = a.disabled;
    b.setAttribute("data-touch-ignore", "");
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (a.disabled) return;
      selectedAction = i;
      a.run();
    });
    els.actions.appendChild(b);
  });

  // Raise sizer with +/- (only meaningful when a raise is legal).
  if (canRaise) {
    const sizer = document.createElement("div");
    sizer.className = "raise-sizer";

    const minus = document.createElement("button");
    minus.type = "button";
    minus.className = "abtn abtn--step";
    minus.textContent = "−";
    minus.setAttribute("data-touch-ignore", "");
    minus.setAttribute("aria-label", "Decrease raise");
    minus.addEventListener("pointerdown", (e) => { e.preventDefault(); adjustRaise(-1); });

    const amount = document.createElement("div");
    amount.className = "raise-sizer__amount";
    amount.textContent = raiseTo;

    const plus = document.createElement("button");
    plus.type = "button";
    plus.className = "abtn abtn--step";
    plus.textContent = "+";
    plus.setAttribute("data-touch-ignore", "");
    plus.setAttribute("aria-label", "Increase raise");
    plus.addEventListener("pointerdown", (e) => { e.preventDefault(); adjustRaise(+1); });

    const label = document.createElement("span");
    label.className = "raise-sizer__label";
    label.textContent = "Raise to";

    sizer.append(label, minus, amount, plus);
    els.actions.appendChild(sizer);
  }
}

// Work out which hole + community cards form each winner's best 5 so we can
// highlight them at showdown.
function computeBestCards() {
  bestCardKeys = new Set();
  const res = engine.results;
  if (!res || !res.showdown) return;
  for (const seat of res.winnersBySeat) {
    const p = engine.players[seat];
    const cards = [
      ...p.hole.map((c, i) => ({ c, key: seat + "-" + i })),
      ...engine.community.map((c, i) => ({ c, key: "comm-" + i })),
    ];
    const best = bestFiveKeys(cards);
    for (const k of best) bestCardKeys.add(k);
  }
}

// Brute-force the best 5-of-7 and return the keys of the chosen cards.
function bestFiveKeys(tagged) {
  let bestScore = null;
  let bestKeys = [];
  const n = tagged.length;
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const pick = [tagged[a], tagged[b], tagged[c], tagged[d], tagged[e]];
            const score = evaluate(pick.map((x) => x.c)).score;
            if (!bestScore || compareScore(score, bestScore) > 0) {
              bestScore = score;
              bestKeys = pick.map((x) => x.key);
            }
          }
  return bestKeys;
}

// ---- Copy helpers (touch vs keyboard) -------------------------------------
function nextMsg() {
  return isTouchDevice() ? "Tap to deal the next hand" : "Press <kbd>Enter</kbd> for the next hand";
}
function restartMsg() {
  return isTouchDevice() ? "Tap to play again" : "Press <kbd>Enter</kbd> to play again";
}
function startMsg() {
  return isTouchDevice() ? "Tap to start" : "Press <kbd>Enter</kbd> to start";
}

// ---- Overlay helpers ------------------------------------------------------
function showOverlay(title, msg) {
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
// Tapping the overlay starts / advances (matches the other games' feel).
els.overlay.addEventListener("pointerdown", () => {
  if (state === "idle" || state === "over") startGame();
  else if (state === "showdown") { if (engine.isGameOver()) startGame(); else dealHand(); }
});

function boot() {
  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });
  render();
  setStatus(isTouchDevice() ? "Tap to start" : "Press Enter to start");
  showOverlay("Texas Hold'em", startMsg());
}

boot();
