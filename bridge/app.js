// Contract Bridge for Space Console — entry point.
//
// Wires the shared intent stream + always-visible controls (a tappable bidding
// box during the auction, tappable cards during the play) to the pure bridge
// engine, renders the 4-seat table (you South, partner North, opponents W/E),
// the auction history, the contract, the current trick, dummy, and your hand,
// drives the AI seats on short timers, and manages the game states
// (idle → auction → play → result).
//
// The engine (engine.js) owns ALL the rules: legal calls, auction termination,
// declarer determination, follow-suit, trick winners, and scoring. This file is
// input + render + the deliberately simple/heuristic AI. Every AI choice it
// makes is checked for legality against the engine, so the AI can be weak but
// never illegal.

import {
  SEATS, SEAT_NAMES, SUIT_SYMBOL, RANK_LABEL, STRAINS, STRAIN_LABEL,
  SOUTH, NORTH, isRedSuit, sideOf,
  deal, handHCP, suitLength,
  newAuction, isLegalCall, applyCall,
  startPlay, ledSuit, isLegalPlay, legalPlays, playCard,
  scoreContract, contractLabel,
} from "./engine.js";
import { Input, isTouchDevice } from "../assets/js/shared/input.js";
import { Sound } from "../assets/js/shared/sound.js";

const input = new Input();
const sound = new Sound();

const els = {
  status: document.getElementById("status"),
  contract: document.getElementById("contract"),
  trick: document.getElementById("trick"),
  trickCount: document.getElementById("trickCount"),
  seatN: document.getElementById("seatN"),
  seatW: document.getElementById("seatW"),
  seatE: document.getElementById("seatE"),
  seatS: document.getElementById("seatS"),
  auction: document.getElementById("auction"),
  auctionGrid: document.getElementById("auctionGrid"),
  hand: document.getElementById("hand"),
  controls: document.getElementById("controls"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  mute: document.getElementById("mute"),
};

// ── Game state ───────────────────────────────────────────────────────────────
// phase: idle | auction | play | result
let phase = "idle";
let hands = [[], [], [], []]; // dealt hands by seat (S,W,N,E)
let auction = null;
let play = null;
let result = null;            // scoring result object once the play finishes
let aiTimer = null;

// Bidding-box selection (keyboard): the human builds a bid from a level + strain
// or picks Pass/Double/Redouble. We keep a working { level, strain } and a
// cursor over the "special" calls.
let bidLevel = 1;             // 1..7 currently selected level
let bidStrainIdx = 0;         // index into STRAINS for the selected strain
let bidFocus = "bid";         // "bid" | "pass" | "double" | "redouble"

// Play cursor: index into the human-controlled hand currently being chosen from.
let playCursor = 0;

// ── Deal / flow ──────────────────────────────────────────────────────────────
function newDeal() {
  sound.resume();
  sound.start();
  result = null;
  play = null;
  // Dealer is always South (documented simplification in engine.js).
  const d = deal();
  hands = d.hands;
  sound.move(); // the deal
  auction = newAuction(SOUTH);
  phase = "auction";
  bidLevel = 1;
  bidStrainIdx = 0;
  bidFocus = "bid";
  hideOverlay();
  els.auction.hidden = false;
  render();
  scheduleAuction();
}

// Drive the auction: AI seats call on a short delay; the human waits for input.
function scheduleAuction() {
  clearTimeout(aiTimer);
  if (phase !== "auction") return;
  if (auction.ended) { onAuctionEnd(); return; }
  const seat = auction.turn;
  if (seat === SOUTH) { render(); return; } // human's turn
  render();
  aiTimer = setTimeout(() => {
    if (phase !== "auction") return;
    const call = aiChooseCall(seat);
    applyCall(auction, call);
    sound.lock();
    render();
    scheduleAuction();
  }, 700);
}

function onAuctionEnd() {
  clearTimeout(aiTimer);
  if (auction.passedOut) {
    // Four passes → no contract. Show a message and redeal on advance.
    phase = "result";
    sound.gameOver();
    showOverlay("Passed out", "All four players passed.<br>" + advanceMsg("for a new deal"));
    setStatus("Passed out — redeal");
    render();
    return;
  }
  // Begin the play.
  play = startPlay(auction.contract, hands);
  phase = "play";
  playCursor = 0;
  setStatus(SEAT_NAMES[SEATS[play.leader]] + " leads");
  render();
  schedulePlay();
}

// Which seats does the human (South) control? Always South's own hand; and the
// dummy too when South is declarer (declarer plays both hands).
function humanControls(seat) {
  if (seat === SOUTH) return true;
  if (play && play.declarer === SOUTH && seat === play.dummy) return true;
  return false;
}

// Drive the play: AI-controlled seats play on a delay; human-controlled seats
// wait for a tap / keyboard pick.
function schedulePlay() {
  clearTimeout(aiTimer);
  if (phase !== "play") return;
  if (play.done) { onPlayEnd(); return; }
  const seat = play.turn;
  if (humanControls(seat)) {
    // Snap the cursor onto a legal card for this seat.
    const legal = legalPlays(play, seat);
    const hand = play.hands[seat];
    if (legal.length && !legal.some((c) => sameCard(c, hand[playCursor]))) {
      playCursor = hand.findIndex((c) => legal.some((l) => sameCard(l, c)));
      if (playCursor < 0) playCursor = 0;
    }
    setStatus(turnLabel(seat) + " — your card");
    render();
    return;
  }
  setStatus(SEAT_NAMES[SEATS[seat]] + " thinking…");
  render();
  aiTimer = setTimeout(() => {
    if (phase !== "play") return;
    const card = aiChoosePlay(seat);
    doPlay(seat, card);
  }, 650);
}

// Apply one card (engine validates legality), handle trick completion + sounds,
// then continue the loop with an appropriate pause so completed tricks are
// visible before they clear.
function doPlay(seat, card) {
  if (!isLegalPlay(play, seat, card)) return;
  const r = playCard(play, seat, card);
  sound.move();
  render();
  if (r.trickComplete) {
    sound.clear(1);
    setStatus(SEAT_NAMES[SEATS[r.winner]] + " wins the trick");
    // Pause so the full 4-card trick stays on screen before clearing.
    clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      if (phase !== "play") return;
      render();
      schedulePlay();
    }, 900);
  } else {
    schedulePlay();
  }
}

function onPlayEnd() {
  phase = "result";
  const declTricks = play.trickCount[sideOf(auction.contract.declarer)];
  result = scoreContract(auction.contract, declTricks);
  const made = result.made;
  if (made) sound.levelUp(); else sound.gameOver();

  const decl = SEAT_NAMES[SEATS[auction.contract.declarer]];
  const youDeclSide = sideOf(auction.contract.declarer) === sideOf(SOUTH);
  const winnerScore = made ? result.declarerScore : result.defenderScore;
  const scoredBy = made
    ? (youDeclSide ? "Your side" : "Opponents")
    : (youDeclSide ? "Opponents" : "Your side");

  const title = made
    ? `Contract made ${result.result > 0 ? "+" + result.result : ""}`
    : `Contract down ${result.result}`;
  const msg =
    `${contractLabel(auction.contract)}<br>` +
    `${decl}'s side took ${declTricks} trick${declTricks === 1 ? "" : "s"} ` +
    `(needed ${result.tricksNeeded}).<br>` +
    `${scoredBy} score <b>${winnerScore}</b>.<br>` +
    advanceMsg("for a new deal");

  showOverlay(title, msg);
  setStatus(title);
  render();
}

// ── AI: auction ──────────────────────────────────────────────────────────────
// Deliberately SIMPLE and LEGAL. Opening: ~12+ HCP opens its longest suit at the
// 1 level (1NT for balanced 15–17). Responding/raising: a few basic rules. Every
// produced call is verified with isLegalCall; if our heuristic ever yields an
// illegal call we fall back to Pass (always legal). Weak play is acceptable — the
// only hard requirement is legality and that the auction terminates.
function aiChooseCall(seat) {
  const hand = hands[seat];
  const candidate = aiBidHeuristic(seat, hand);
  if (candidate && isLegalCall(auction, candidate)) return candidate;
  // Fall back to the highest legal bid that is still our intended one, else Pass.
  return { type: "pass" };
}

function aiBidHeuristic(seat, hand) {
  const hcp = handHCP(hand);
  const partnerBid = lastBidBy(partnerOf(seat));
  const oppBid = auction.lastBid && sideOf(auction.lastBid.seat) !== sideOf(seat)
    ? auction.lastBid : null;

  // Longest suit (tie → higher-ranking) for simple suit choices.
  const lengths = { C: suitLength(hand, "C"), D: suitLength(hand, "D"),
    H: suitLength(hand, "H"), S: suitLength(hand, "S") };
  let longest = "C";
  for (const s of ["C", "D", "H", "S"]) if (lengths[s] >= lengths[longest]) longest = s;
  const balanced = Object.values(lengths).every((n) => n <= 5) &&
    Object.values(lengths).filter((n) => n <= 1).length <= 1;

  // ── No bid yet from anyone (we might be opening). ──
  if (!auction.lastBid) {
    if (hcp >= 15 && hcp <= 17 && balanced) return { type: "bid", level: 1, strain: "NT" };
    if (hcp >= 12) return { type: "bid", level: 1, strain: longest };
    return { type: "pass" };
  }

  // ── Partner opened/bid and opponents are silent-ish: respond. ──
  if (partnerBid) {
    // Raise partner's suit with support (4+) and some values.
    if (partnerBid.strain !== "NT") {
      const support = lengths[partnerBid.strain];
      if (support >= 4 && hcp >= 6) {
        const raiseLevel = hcp >= 11 ? partnerBid.level + 2 : partnerBid.level + 1;
        const c = { type: "bid", level: Math.min(7, raiseLevel), strain: partnerBid.strain };
        if (isLegalCall(auction, c)) return c;
      }
    }
    // Otherwise bid a new long suit at the cheapest level with enough points.
    if (hcp >= 6) {
      for (let lvl = 1; lvl <= 7; lvl++) {
        const c = { type: "bid", level: lvl, strain: longest };
        if (isLegalCall(auction, c)) return c;
      }
    }
    return { type: "pass" };
  }

  // ── Opponents have the bidding: occasionally compete or double for penalty. ──
  if (oppBid) {
    // Penalty double of a high opponent contract with strong values.
    if (hcp >= 16 && isLegalCall(auction, { type: "double" })) return { type: "double" };
    // Overcall a long, decent suit one step up.
    if (hcp >= 10 && lengths[longest] >= 5) {
      for (let lvl = oppBid.level; lvl <= 7; lvl++) {
        const c = { type: "bid", level: lvl, strain: longest };
        if (isLegalCall(auction, c)) return c;
      }
    }
  }
  return { type: "pass" };
}

function lastBidBy(seat) {
  if (!auction) return null;
  for (let i = auction.calls.length - 1; i >= 0; i--) {
    const { seat: s, call } = auction.calls[i];
    if (s === seat && call.type === "bid") return { level: call.level, strain: call.strain };
  }
  return null;
}
function partnerOf(seat) { return (seat + 2) % 4; }

// ── AI: play ─────────────────────────────────────────────────────────────────
// Simple legal play. Leading: lead the highest card of our longest non-trump
// suit (or anything legal). Following: win cheaply if we can beat the current
// best, otherwise discard our lowest legal card. This is intentionally naive —
// it only needs to be legal and to finish 13 tricks.
function aiChoosePlay(seat) {
  const legal = legalPlays(play, seat);
  if (legal.length === 1) return legal[0];
  const trick = play.currentTrick;
  if (trick.length === 0) {
    // Leading: pick the highest card of our longest suit among legal cards.
    return [...legal].sort((a, b) => b.rank - a.rank)[0];
  }
  // Following: see if we can win the trick.
  const led = ledSuit(play);
  const trump = play.trump;
  // Determine the current winning card.
  let best = trick[0].card;
  for (const t of trick) {
    if (cardBeats(t.card, best, led, trump)) best = t.card;
  }
  // Cards that would win:
  const winners = legal.filter((c) => cardBeats(c, best, led, trump));
  if (winners.length) {
    // Win as cheaply as possible.
    return winners.sort((a, b) => rankForWin(a, trump) - rankForWin(b, trump))[0];
  }
  // Can't win: dump the lowest legal card.
  return [...legal].sort((a, b) => a.rank - b.rank)[0];
}

// Mirror of the engine's private beats() for AI decisions (engine is the source
// of truth for the actual trick winner; this only guides AI choices).
function cardBeats(candidate, best, led, trump) {
  const cT = trump && candidate.suit === trump;
  const bT = trump && best.suit === trump;
  if (cT && !bT) return true;
  if (!cT && bT) return false;
  if (cT && bT) return candidate.rank > best.rank;
  const cL = candidate.suit === led, bL = best.suit === led;
  if (cL && !bL) return true;
  if (!cL && bL) return false;
  if (cL && bL) return candidate.rank > best.rank;
  return false;
}
// Sort key so trumps rank above non-trumps when choosing the cheapest winner.
function rankForWin(card, trump) {
  return (trump && card.suit === trump ? 100 : 0) + card.rank;
}

// ── Human input ──────────────────────────────────────────────────────────────
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }

  if (phase === "idle") { if (intent === "enter") newDeal(); return; }
  if (phase === "result") { if (intent === "enter") newDeal(); return; }

  if (phase === "auction") { handleAuctionIntent(intent); return; }
  if (phase === "play") { handlePlayIntent(intent); return; }
});

function handleAuctionIntent(intent) {
  if (auction.turn !== SOUTH) return; // not your turn
  switch (intent) {
    case "up":
      if (bidFocus === "bid") bidLevel = Math.min(7, bidLevel + 1);
      render();
      break;
    case "down":
      if (bidFocus === "bid") bidLevel = Math.max(1, bidLevel - 1);
      render();
      break;
    case "left":
      cycleBidFocus(-1);
      render();
      break;
    case "right":
      cycleBidFocus(+1);
      render();
      break;
    case "enter":
      submitFocusedCall();
      break;
  }
}

// The keyboard "cursor" walks: strain C,D,H,S,NT (with current level), then the
// special calls Pass / Double / Redouble (those that are legal).
function bidStops() {
  // Each stop is a concrete call we can attempt.
  const stops = [];
  for (let i = 0; i < STRAINS.length; i++) {
    stops.push({ kind: "bid", strainIdx: i });
  }
  stops.push({ kind: "pass" });
  if (isLegalCall(auction, { type: "double" })) stops.push({ kind: "double" });
  if (isLegalCall(auction, { type: "redouble" })) stops.push({ kind: "redouble" });
  return stops;
}

let bidStopIdx = 0; // index into bidStops()
function cycleBidFocus(dir) {
  const stops = bidStops();
  bidStopIdx = (bidStopIdx + dir + stops.length) % stops.length;
  const stop = stops[bidStopIdx];
  if (stop.kind === "bid") { bidFocus = "bid"; bidStrainIdx = stop.strainIdx; }
  else bidFocus = stop.kind;
}

function submitFocusedCall() {
  let call;
  if (bidFocus === "bid") call = { type: "bid", level: bidLevel, strain: STRAINS[bidStrainIdx] };
  else if (bidFocus === "pass") call = { type: "pass" };
  else if (bidFocus === "double") call = { type: "double" };
  else if (bidFocus === "redouble") call = { type: "redouble" };
  makeHumanCall(call);
}

function makeHumanCall(call) {
  if (phase !== "auction" || auction.turn !== SOUTH) return;
  if (!isLegalCall(auction, call)) return;
  applyCall(auction, call);
  sound.lock();
  bidStopIdx = 0;
  bidFocus = "bid";
  bidStrainIdx = 0;
  render();
  scheduleAuction();
}

function handlePlayIntent(intent) {
  const seat = play.turn;
  if (!humanControls(seat)) return;
  const hand = play.hands[seat];
  const legal = legalPlays(play, seat);
  if (!legal.length) return;
  switch (intent) {
    case "left": movePlayCursor(seat, -1); break;
    case "right": movePlayCursor(seat, +1); break;
    case "enter": {
      const card = hand[playCursor];
      if (card && legal.some((c) => sameCard(c, card))) doPlay(seat, card);
      break;
    }
  }
}

// Move the cursor to the next/prev LEGAL card in the controlled hand.
function movePlayCursor(seat, dir) {
  const hand = play.hands[seat];
  const legal = legalPlays(play, seat);
  if (!hand.length) return;
  let i = playCursor;
  for (let step = 0; step < hand.length; step++) {
    i = (i + dir + hand.length) % hand.length;
    if (legal.some((c) => sameCard(c, hand[i]))) { playCursor = i; break; }
  }
  render();
}

function sameCard(a, b) { return a && b && a.suit === b.suit && a.rank === b.rank; }

// ── Rendering ────────────────────────────────────────────────────────────────
function render() {
  renderContract();
  renderTrick();
  renderTrickCount();
  renderSeats();
  renderAuction();
  renderHand();
  renderControls();
}

function renderContract() {
  if (phase === "auction") {
    els.contract.textContent = auction.lastBid
      ? "Auction — high bid " + auction.lastBid.level + STRAIN_LABEL[auction.lastBid.strain]
      : "Auction";
  } else if (phase === "play" || phase === "result") {
    els.contract.textContent = auction && auction.contract
      ? contractLabel(auction.contract)
      : "";
  } else {
    els.contract.textContent = "";
  }
}

// Build a single DOM card element (rank + Unicode suit, red for hearts/diamonds).
function cardEl(card, { faceDown = false, selectable = false, selected = false,
  disabled = false } = {}) {
  const el = document.createElement("div");
  el.className = "card";
  if (faceDown) { el.classList.add("card--back"); return el; }
  if (isRedSuit(card.suit)) el.classList.add("card--red");
  if (selected) el.classList.add("card--selected");
  if (disabled) el.classList.add("card--disabled");
  const r = document.createElement("span");
  r.className = "card__rank";
  r.textContent = RANK_LABEL[card.rank];
  const s = document.createElement("span");
  s.className = "card__suit";
  s.textContent = SUIT_SYMBOL[card.suit];
  el.append(r, s);
  if (selectable) el.setAttribute("data-touch-ignore", "");
  return el;
}

function renderTrick() {
  els.trick.innerHTML = "";
  if (phase !== "play" && phase !== "result") return;
  if (!play) return;
  // Show the current trick cards positioned by seat around the centre.
  for (const { seat, card } of play.currentTrick) {
    const slot = document.createElement("div");
    slot.className = "trick__card trick__card--" + SEATS[seat].toLowerCase();
    slot.appendChild(cardEl(card));
    els.trick.appendChild(slot);
  }
}

function renderTrickCount() {
  if (phase === "play" || phase === "result") {
    const ns = play.trickCount[0], ew = play.trickCount[1];
    els.trickCount.textContent = `Tricks — N/S ${ns} · E/W ${ew}`;
  } else {
    els.trickCount.textContent = "";
  }
}

// Render the four seat boxes (card count, role, last call/played card, active).
function renderSeats() {
  els.seatN.innerHTML = "";
  els.seatW.innerHTML = "";
  els.seatE.innerHTML = "";
  els.seatS.innerHTML = "";
  const slots = { N: els.seatN, W: els.seatW, E: els.seatE, S: els.seatS };
  for (let seat = 0; seat < 4; seat++) {
    slots[SEATS[seat]].appendChild(seatEl(seat));
  }
}

function seatEl(seat) {
  const wrap = document.createElement("div");
  wrap.className = "seat";
  const activeAuction = phase === "auction" && auction.turn === seat;
  const activePlay = phase === "play" && play && play.turn === seat;
  if (activeAuction || activePlay) wrap.classList.add("seat--active");
  if (play && seat === play.declarer) wrap.classList.add("seat--declarer");
  if (play && seat === play.dummy) wrap.classList.add("seat--dummy");

  const name = document.createElement("div");
  name.className = "seat__name";
  let label = SEAT_NAMES[SEATS[seat]];
  if (seat === SOUTH) label += " (You)";
  else if (seat === NORTH) label += " (Partner)";
  if (auction && auction.dealer === seat) label += " · Dealer";
  if (play && seat === play.declarer) label += " · Declarer";
  else if (play && seat === play.dummy) label += " · Dummy";
  name.textContent = label;

  const info = document.createElement("div");
  info.className = "seat__info";
  // Card count remaining (during play) or in the deal.
  const count = play ? play.hands[seat].length : (hands[seat] ? hands[seat].length : 0);
  info.textContent = count + " cards";

  const last = document.createElement("div");
  last.className = "seat__last";
  if (phase === "auction") last.textContent = lastCallText(seat);
  else if (phase === "play" || phase === "result") last.textContent = lastPlayedText(seat);

  wrap.append(name, info, last);

  // Reveal the dummy face-up during play (and in the result). The dummy's hand
  // is shown as a compact fan beneath the seat box. If the human is declarer,
  // the dummy is interactive too (handled in renderHand for the controlled hand
  // when it's dummy's turn); here we just show it for reference.
  if (play && seat === play.dummy && (phase === "play" || phase === "result")) {
    const dummyFan = document.createElement("div");
    dummyFan.className = "seat__dummy";
    for (const card of play.hands[seat]) {
      dummyFan.appendChild(cardEl(card));
    }
    wrap.appendChild(dummyFan);
  }
  return wrap;
}

function lastCallText(seat) {
  if (!auction) return "";
  for (let i = auction.calls.length - 1; i >= 0; i--) {
    if (auction.calls[i].seat === seat) return callText(auction.calls[i].call);
  }
  return "";
}
function lastPlayedText(seat) {
  // The seat's card in the current trick, if any.
  if (!play) return "";
  const inTrick = play.currentTrick.find((t) => t.seat === seat);
  if (inTrick) return RANK_LABEL[inTrick.card.rank] + SUIT_SYMBOL[inTrick.card.suit];
  return "";
}

function callText(call) {
  if (call.type === "pass") return "Pass";
  if (call.type === "double") return "X";
  if (call.type === "redouble") return "XX";
  return call.level + STRAIN_LABEL[call.strain];
}

// Auction history as a 4-column grid (South, West, North, East order).
function renderAuction() {
  if (phase !== "auction" && phase !== "play" && phase !== "result") {
    els.auction.hidden = true;
    return;
  }
  if (!auction || auction.calls.length === 0) {
    // Keep the grid present but empty during the auction's first turn.
    els.auctionGrid.innerHTML = "";
    return;
  }
  els.auction.hidden = false;
  els.auctionGrid.innerHTML = "";
  // The header is South,West,North,East. Dealer is South so calls already start
  // in the South column; place each call in its seat's column in row order.
  const colOf = { 0: 0, 1: 1, 2: 2, 3: 3 }; // S,W,N,E → columns 0..3
  // Build rows: each row holds up to one call per seat in S,W,N,E order.
  let col = colOf[auction.dealer];
  // Pad leading empty cells before the dealer's column (dealer is South=col0,
  // so normally none, but keep general).
  for (let i = 0; i < col; i++) els.auctionGrid.appendChild(emptyCell());
  for (const { seat, call } of auction.calls) {
    const cell = document.createElement("div");
    cell.className = "auction__cell";
    if (call.type === "double" || call.type === "redouble") cell.classList.add("auction__cell--dbl");
    cell.textContent = callText(call);
    els.auctionGrid.appendChild(cell);
    col = (colOf[seat] + 1) % 4;
  }
}
function emptyCell() {
  const c = document.createElement("div");
  c.className = "auction__cell auction__cell--empty";
  return c;
}

// Your hand at the bottom: South's cards, sorted, tappable when it's your turn
// to play one of YOUR cards. (Dummy is played from its own fan when you're
// declarer — see below.)
function renderHand() {
  els.hand.innerHTML = "";
  const south = play ? play.hands[SOUTH] : hands[SOUTH];
  if (!south || !south.length) return;

  // Determine if South's own hand is the one to act now (vs dummy).
  const southToAct = phase === "play" && humanControls(play.turn) && play.turn === SOUTH;
  const legal = southToAct ? legalPlays(play, SOUTH) : [];

  for (let i = 0; i < south.length; i++) {
    const card = south[i];
    const isLegal = southToAct && legal.some((c) => sameCard(c, card));
    const selected = southToAct && i === playCursor;
    const el = cardEl(card, {
      selectable: southToAct,
      selected,
      disabled: southToAct && !isLegal,
    });
    if (southToAct && isLegal) {
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        playCursor = i;
        doPlay(SOUTH, card);
      });
    }
    els.hand.appendChild(el);
  }

  // When YOU are declarer and it's DUMMY's turn, make the dummy fan (rendered in
  // the North seat) tappable. We attach handlers here after seats render.
  makeDummyInteractive();
}

// If the human is declarer and it is the dummy's turn, wire taps + keyboard for
// the dummy's cards (shown in the partner/North seat fan).
function makeDummyInteractive() {
  if (phase !== "play" || !play) return;
  if (play.declarer !== SOUTH) return;
  if (play.turn !== play.dummy) return;
  const fan = els.seatN.querySelector(".seat__dummy");
  if (!fan) return;
  const hand = play.hands[play.dummy];
  const legal = legalPlays(play, play.dummy);
  const cards = fan.querySelectorAll(".card");
  cards.forEach((cardNode, i) => {
    const card = hand[i];
    const isLegal = legal.some((c) => sameCard(c, card));
    cardNode.classList.add("card--dummy-play");
    if (i === playCursor) cardNode.classList.add("card--selected");
    if (!isLegal) cardNode.classList.add("card--disabled");
    else {
      cardNode.setAttribute("data-touch-ignore", "");
      cardNode.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        playCursor = i;
        doPlay(play.dummy, card);
      });
    }
  });
}

function turnLabel(seat) {
  if (seat === SOUTH) return "Your hand";
  if (play && seat === play.dummy) return "Dummy (North)";
  return SEAT_NAMES[SEATS[seat]];
}

// ── Controls: bidding box (auction) / hint (play) ────────────────────────────
function renderControls() {
  els.controls.innerHTML = "";
  if (phase === "auction") {
    if (auction.turn === SOUTH) renderBiddingBox();
    else {
      const m = document.createElement("div");
      m.className = "ctrl-msg";
      m.textContent = SEAT_NAMES[SEATS[auction.turn]] + " to bid…";
      els.controls.appendChild(m);
    }
  } else if (phase === "play") {
    const m = document.createElement("div");
    m.className = "ctrl-msg";
    if (humanControls(play.turn)) {
      m.textContent = isTouchDevice()
        ? "Tap a highlighted card to play (" + turnLabel(play.turn) + ")"
        : "←→ choose, Enter to play (" + turnLabel(play.turn) + ")";
    } else {
      m.textContent = SEAT_NAMES[SEATS[play.turn]] + " is playing…";
    }
    els.controls.appendChild(m);
  } else {
    const m = document.createElement("div");
    m.className = "ctrl-msg";
    m.textContent = isTouchDevice() ? "Tap to deal" : "Press Enter to deal";
    els.controls.appendChild(m);
  }
}

// The tappable bidding box: a level row (1–7), a strain row (♣♦♥♠ NT) — together
// they form the candidate bid — plus Pass / Double / Redouble. Illegal calls are
// disabled/dimmed. The currently keyboard-focused stop is highlighted.
function renderBiddingBox() {
  const box = document.createElement("div");
  box.className = "bidbox";

  // Level row.
  const levelRow = document.createElement("div");
  levelRow.className = "bidbox__row bidbox__levels";
  for (let lvl = 1; lvl <= 7; lvl++) {
    const b = makeBidButton(String(lvl), () => { bidLevel = lvl; render(); },
      { active: bidFocus === "bid" && bidLevel === lvl, kind: "level" });
    levelRow.appendChild(b);
  }
  box.appendChild(levelRow);

  // Strain row — each is a full candidate bid at the chosen level.
  const strainRow = document.createElement("div");
  strainRow.className = "bidbox__row bidbox__strains";
  for (let i = 0; i < STRAINS.length; i++) {
    const strain = STRAINS[i];
    const call = { type: "bid", level: bidLevel, strain };
    const legal = isLegalCall(auction, call);
    const red = strain === "H" || strain === "D";
    const b = makeBidButton(STRAIN_LABEL[strain], () => makeHumanCall(call), {
      disabled: !legal,
      active: bidFocus === "bid" && bidStrainIdx === i,
      kind: "strain",
      red,
    });
    strainRow.appendChild(b);
  }
  box.appendChild(strainRow);

  // Special calls.
  const specialRow = document.createElement("div");
  specialRow.className = "bidbox__row bidbox__special";
  const passLegal = isLegalCall(auction, { type: "pass" });
  specialRow.appendChild(makeBidButton("Pass", () => makeHumanCall({ type: "pass" }),
    { disabled: !passLegal, active: bidFocus === "pass", kind: "pass" }));
  const dblLegal = isLegalCall(auction, { type: "double" });
  specialRow.appendChild(makeBidButton("Double", () => makeHumanCall({ type: "double" }),
    { disabled: !dblLegal, active: bidFocus === "double", kind: "double" }));
  const rdblLegal = isLegalCall(auction, { type: "redouble" });
  specialRow.appendChild(makeBidButton("Redbl", () => makeHumanCall({ type: "redouble" }),
    { disabled: !rdblLegal, active: bidFocus === "redouble", kind: "redouble" }));
  box.appendChild(specialRow);

  // Helper line: show the candidate bid + your HCP.
  const help = document.createElement("div");
  help.className = "bidbox__help";
  const hcp = handHCP(hands[SOUTH]);
  help.textContent = `Your hand: ${hcp} HCP · candidate ${bidLevel}${STRAIN_LABEL[STRAINS[bidStrainIdx]]}`;
  box.appendChild(help);

  els.controls.appendChild(box);
}

function makeBidButton(label, onPress, opts = {}) {
  const { disabled = false, active = false, kind = "", red = false } = opts;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "bidbtn bidbtn--" + kind +
    (active ? " bidbtn--active" : "") + (red ? " bidbtn--red" : "");
  b.textContent = label;
  b.disabled = disabled;
  b.setAttribute("data-touch-ignore", "");
  if (!disabled) {
    b.addEventListener("pointerdown", (e) => { e.preventDefault(); onPress(); });
  }
  return b;
}

// ── Overlay / status / mute ──────────────────────────────────────────────────
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.innerHTML = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(text) { els.status.textContent = text; }
function advanceMsg(suffix) {
  return (isTouchDevice() ? "Tap" : "Press <kbd>Enter</kbd>") + " " + suffix + ".";
}

function renderMute() {
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}
function toggleMute() { sound.toggleMute(); renderMute(); }

// ── Boot ─────────────────────────────────────────────────────────────────────
els.overlay.addEventListener("pointerdown", () => {
  if (phase === "idle" || phase === "result") newDeal();
});

function boot() {
  input.start();
  els.mute.addEventListener("click", toggleMute);
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") toggleMute();
  });
  render();
  setStatus(isTouchDevice() ? "Tap to deal" : "Press Enter to deal");
  showOverlay("Contract Bridge", advanceMsg("to deal — you are South"));
}

boot();
