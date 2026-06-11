// Tic-Tac-Boom (Bomberman-style) for Space Console — entry point.
// Owns the canvas render + input; the Engine (engine.js) owns all maze/bomb/AI
// logic and the fixed-step simulation. You are the red bomber (player 0) vs three
// AI bombers; walk the maze, drop bombs, grab power-ups, be the last one standing.
//
// States: idle (start overlay) → playing → over.
//
// Movement is HELD (press-and-hold a direction), which the shared discrete-intent
// layer can't express — so, like the other action games, movement uses direct
// keydown/keyup + on-screen D-pad pointer events. The shared Input still supplies
// enter (start / restart) and back (hub). Space/Enter drops a bomb.

import {
  Engine, COLS, ROWS, WALL, SOFT,
  PU_BOMB, PU_FIRE, PU_SPEED, key,
} from "./engine.js";
import { Input } from "../assets/js/shared/input.js";
import { Sound } from "../assets/js/shared/sound.js";

const input = new Input();
const sound = new Sound();
let engine = new Engine({ players: 4 });

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");
const TILE = canvas.width / COLS;     // pixels per tile (canvas is COLS×ROWS tiles)

const els = {
  status: document.getElementById("status"),
  overlay: document.getElementById("overlay"),
  overlayTitle: document.getElementById("overlayTitle"),
  overlayMsg: document.getElementById("overlayMsg"),
  startBtn: document.getElementById("startBtn"),
  players: document.getElementById("players"),
  aliveCount: document.getElementById("aliveCount"),
  dpad: document.getElementById("dpad"),
  bombBtn: document.getElementById("bombBtn"),
  mute: document.getElementById("mute"),
};

const FIXED_DT = 1 / 60;
const MAX_FRAME = 0.05;
let state = "idle";          // idle | playing | over
let lastTime = 0;
let acc = 0;
let anim = 0;                // free-running animation clock (for pulses)

// ---- Held-direction input (keyboard + touch share this) -------------------
const heldOrder = [];        // directions currently held, most-recent last
const tap = { dir: null, until: 0 };   // brief nudge from a discrete intent (remote)

function pressDir(dir) {
  if (!heldOrder.includes(dir)) heldOrder.push(dir);
}
function releaseDir(dir) {
  const i = heldOrder.indexOf(dir);
  if (i !== -1) heldOrder.splice(i, 1);
}
function currentWantDir() {
  if (heldOrder.length) return heldOrder[heldOrder.length - 1];
  if (anim < tap.until) return tap.dir;
  return null;
}

const KEY_DIR = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  w: "up", s: "down", a: "left", d: "right", W: "up", S: "down", A: "left", D: "right",
};

function dropBomb() {
  if (state !== "playing") return;
  if (engine.placeBomb(0)) sound.lock();
}

// ---- Game lifecycle -------------------------------------------------------
function startGame() {
  sound.resume();
  sound.start();
  engine = new Engine({ players: 4 });
  heldOrder.length = 0;
  tap.dir = null; tap.until = 0;
  state = "playing";
  hideOverlay();
  setStatus("Bomb the maze!");
  lastTime = performance.now();
  acc = 0;
  renderPanel();
}

function endGame() {
  state = "over";
  const w = engine.winner;
  if (w === 0) { sound.levelUp(); showOverlay("You win! 🏆", "Last bomber standing. Press Enter to play again."); setStatus("You win!"); }
  else if (w === -1) { sound.gameOver(); showOverlay("Draw!", "Everyone went out together. Press Enter to retry."); setStatus("Draw"); }
  else { sound.gameOver(); showOverlay("Boom — you're out", `${label(w)} wins. Press Enter to play again.`); setStatus(`${label(w)} wins`); }
  els.startBtn.textContent = "Play again";
  renderPanel();
}

// ---- Simulation loop ------------------------------------------------------
function processEvents(events) {
  for (const ev of events) {
    if (ev.type === "boom") sound.drop();
    else if (ev.type === "block") sound.move();
    else if (ev.type === "pickup") sound.clear(1);
    else if (ev.type === "death") { if (ev.human) sound.gameOver(); else sound.rotate(); }
    else if (ev.type === "sudden") { sound.drop(); setStatus("⚠ Sudden death — walls closing in!"); }
    else if (ev.type === "over") endGame();
  }
}

function loop(now) {
  anim = now / 1000;
  if (state === "playing") {
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;

    engine.setWantDir(0, currentWantDir());

    acc += dt;
    while (acc >= FIXED_DT) {
      const events = engine.update(FIXED_DT);
      acc -= FIXED_DT;
      if (events.length) processEvents(events);
      if (state !== "playing") break;
    }
    renderPanel();
  } else {
    lastTime = now;
  }
  draw();
  requestAnimationFrame(loop);
}

// ---- Rendering ------------------------------------------------------------
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  drawPickups();
  drawBombs();
  drawFlames();
  drawPlayers();
}

function drawGrid() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const x = c * TILE, y = r * TILE;
      // Floor: subtle checker for readability.
      ctx.fillStyle = (c + r) % 2 === 0 ? "#16203f" : "#121a36";
      ctx.fillRect(x, y, TILE, TILE);

      const v = engine.cell(c, r);
      if (v === WALL) drawWall(x, y, engine.sdWalls.has(key(c, r)));
      else if (v === SOFT) drawSoft(x, y);
    }
  }
}

function drawWall(x, y, sudden) {
  const g = ctx.createLinearGradient(x, y, x, y + TILE);
  if (sudden) { g.addColorStop(0, "#c0506a"); g.addColorStop(1, "#6e2336"); }
  else { g.addColorStop(0, "#6b7790"); g.addColorStop(1, "#3a435c"); }
  ctx.fillStyle = g;
  roundRect(x + 1, y + 1, TILE - 2, TILE - 2, 5);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  roundRect(x + 3, y + 3, TILE - 6, (TILE - 6) * 0.42, 4);
  ctx.fill();
}

function drawSoft(x, y) {
  ctx.fillStyle = "#9a5a2c";
  roundRect(x + 2, y + 2, TILE - 4, TILE - 4, 5);
  ctx.fill();
  // Brick lines.
  ctx.strokeStyle = "rgba(0,0,0,0.28)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + 2, y + TILE / 2); ctx.lineTo(x + TILE - 2, y + TILE / 2);
  ctx.moveTo(x + TILE / 2, y + 2); ctx.lineTo(x + TILE / 2, y + TILE / 2);
  ctx.moveTo(x + TILE * 0.28, y + TILE / 2); ctx.lineTo(x + TILE * 0.28, y + TILE - 2);
  ctx.moveTo(x + TILE * 0.72, y + TILE / 2); ctx.lineTo(x + TILE * 0.72, y + TILE - 2);
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  roundRect(x + 3, y + 3, TILE - 6, 4, 2);
  ctx.fill();
}

const PU_ICON = { [PU_BOMB]: "💣", [PU_FIRE]: "🔥", [PU_SPEED]: "👟" };
const PU_BG = { [PU_BOMB]: "#3b7de2", [PU_FIRE]: "#e2683b", [PU_SPEED]: "#2fb86b" };
function drawPickups() {
  for (const [k, type] of engine.pickups) {
    const c = k % COLS, r = Math.floor(k / COLS);
    const x = c * TILE, y = r * TILE;
    const pulse = 0.5 + 0.5 * Math.sin(anim * 4 + k);
    ctx.fillStyle = PU_BG[type];
    ctx.globalAlpha = 0.5 + 0.4 * pulse;
    roundRect(x + 5, y + 5, TILE - 10, TILE - 10, 7);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = `${TILE * 0.5}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(PU_ICON[type], x + TILE / 2, y + TILE / 2 + 1);
  }
}

function drawBombs() {
  for (const b of engine.bombs) {
    const cx = (b.col + 0.5) * TILE, cy = (b.row + 0.5) * TILE;
    // Pulse faster as the fuse runs down.
    const t = 1 - Math.max(0, b.fuse) / 2.4;
    const pulse = 1 + 0.12 * Math.sin(anim * (6 + t * 22));
    const rr = TILE * 0.34 * pulse;
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fillStyle = "#10131f";
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
    // Highlight.
    ctx.beginPath();
    ctx.arc(cx - rr * 0.3, cy - rr * 0.3, rr * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();
    // Fuse spark.
    ctx.fillStyle = (Math.sin(anim * 30) > 0) ? "#ffd34d" : "#ff7a3d";
    ctx.beginPath();
    ctx.arc(cx + rr * 0.5, cy - rr * 0.9, 2.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawFlames() {
  for (const [k, t] of engine.flames) {
    const c = k % COLS, r = Math.floor(k / COLS);
    const x = c * TILE, y = r * TILE;
    const a = Math.min(1, t / 0.5);
    const g = ctx.createRadialGradient(x + TILE / 2, y + TILE / 2, 2, x + TILE / 2, y + TILE / 2, TILE * 0.7);
    g.addColorStop(0, `rgba(255,240,170,${0.95 * a})`);
    g.addColorStop(0.5, `rgba(255,150,40,${0.9 * a})`);
    g.addColorStop(1, `rgba(255,80,20,${0.15 * a})`);
    ctx.fillStyle = g;
    roundRect(x + 1, y + 1, TILE - 2, TILE - 2, 6);
    ctx.fill();
  }
}

const COLOR_HEX = { red: "#e23b4e", blue: "#3b7de2", green: "#2fb86b", yellow: "#e7b53b" };
function drawPlayers() {
  for (const p of engine.players) {
    if (!p.alive) continue;
    const cx = (p.x + 0.5) * TILE, cy = (p.y + 0.5) * TILE;
    const rr = TILE * 0.38;
    // Body.
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.fillStyle = COLOR_HEX[p.color];
    ctx.shadowColor = "rgba(0,0,0,0.5)";
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;
    // Identify the human with a white ring.
    if (p.id === 0) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    // Eyes, offset toward the facing direction.
    const fx = p.dir === "left" ? -1 : p.dir === "right" ? 1 : 0;
    const fy = p.dir === "up" ? -1 : p.dir === "down" ? 1 : 0;
    const ex = cx + fx * rr * 0.22, ey = cy + fy * rr * 0.22 - rr * 0.1;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(ex + s * rr * 0.3, ey, rr * 0.18, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(ex + s * rr * 0.3 + fx * 1.5, ey + fy * 1.5, rr * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = "#10142b";
      ctx.fill();
    }
  }
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---- Side panel -----------------------------------------------------------
function renderPanel() {
  els.players.innerHTML = "";
  let alive = 0;
  for (const p of engine.players) {
    if (p.alive) alive += 1;
    const li = document.createElement("li");
    li.className = "player" + (p.alive ? "" : " player--out");
    const dot = document.createElement("span");
    dot.className = "player__dot";
    dot.style.background = COLOR_HEX[p.color];
    const name = document.createElement("span");
    name.className = "player__name";
    name.textContent = p.id === 0 ? "You" : `AI ${p.id}`;
    const stats = document.createElement("span");
    stats.className = "player__stats";
    stats.textContent = p.alive ? `💣${p.maxBombs} 🔥${p.range}` : "💀";
    li.append(dot, name, stats);
    els.players.appendChild(li);
  }
  els.aliveCount.textContent = String(alive);
}

function label(id) { return id === 0 ? "You" : `AI ${id}`; }

// ---- Overlay / status -----------------------------------------------------
function showOverlay(title, msg) {
  els.overlayTitle.textContent = title;
  els.overlayMsg.textContent = msg;
  els.overlay.classList.remove("overlay--hidden");
}
function hideOverlay() { els.overlay.classList.add("overlay--hidden"); }
function setStatus(text) { els.status.textContent = text; }

// ---- Mute (meta, outside the gameplay intent layer) -----------------------
function toggleMute() {
  sound.toggleMute();
  els.mute.textContent = sound.muted ? "🔇" : "🔊";
  els.mute.setAttribute("aria-pressed", String(sound.muted));
}

// ---- Discrete intents (start / restart / hub / remote nudge) ---------------
input.on((intent) => {
  if (intent === "back") { location.href = "../"; return; }
  if (intent === "enter") {
    if (state === "idle" || state === "over") startGame();
    return;
  }
  // Directional intents (TV remote / gamepad): a brief one-tile nudge, since the
  // keyboard/touch held path is the primary control.
  if (state === "playing" && ["up", "down", "left", "right"].includes(intent)) {
    tap.dir = intent;
    tap.until = anim + 0.16;
  }
});

// ---- Boot -----------------------------------------------------------------
function boot() {
  input.start();

  // Keyboard: held movement + bomb + mute. We listen directly (the shared layer
  // can't express press-and-hold) and don't preventDefault so the page stays sane.
  window.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") { toggleMute(); return; }
    if (e.key === " " || e.key === "Enter" || e.key === "x" || e.key === "X") {
      if (state === "playing") { e.preventDefault(); dropBomb(); }
      return;
    }
    const dir = KEY_DIR[e.key];
    if (dir) { e.preventDefault(); pressDir(dir); }
  });
  window.addEventListener("keyup", (e) => {
    const dir = KEY_DIR[e.key];
    if (dir) releaseDir(dir);
  });

  // Touch D-pad: hold to move.
  for (const btn of els.dpad.querySelectorAll(".dbtn")) {
    const dir = btn.dataset.dir;
    btn.addEventListener("pointerdown", (e) => { e.preventDefault(); pressDir(dir); });
    btn.addEventListener("pointerup", (e) => { e.preventDefault(); releaseDir(dir); });
    btn.addEventListener("pointerleave", () => releaseDir(dir));
    btn.addEventListener("pointercancel", () => releaseDir(dir));
  }
  els.bombBtn.addEventListener("pointerdown", (e) => { e.preventDefault(); dropBomb(); });

  els.startBtn.addEventListener("click", () => { if (state !== "playing") startGame(); });
  els.mute.addEventListener("click", toggleMute);

  renderPanel();
  draw();
  requestAnimationFrame(loop);
}

boot();
