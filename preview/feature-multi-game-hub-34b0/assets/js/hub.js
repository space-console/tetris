// Games hub — the landing menu. Renders nothing itself (tiles are in the HTML);
// it wires the shared intent layer to geometry-based focus navigation and
// launches the focused game's folder on Enter. Same intent vocabulary the rest
// of Space Console speaks, so a keyboard, TV remote, gamepad, or phone
// controller all drive the menu.

import { Input } from "./shared/input.js?v=249f7edb-2ece-4311-98c3-4217e5a5562d";

const input = new Input();
const tiles = [...document.querySelectorAll(".tile[data-href]")];
let idx = 0;

function focus(i) {
  idx = i;
  tiles.forEach((t, k) => t.classList.toggle("is-focused", k === i));
  tiles[i].scrollIntoView({ block: "nearest", inline: "nearest" });
}

function center(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// Move focus to the nearest tile in the given direction. Geometry-based so it
// works for any responsive grid layout: pick the candidate on the correct side,
// scoring distance along the travel axis plus a penalty for cross-axis drift.
function move(dir) {
  const from = center(tiles[idx]);
  let best = -1;
  let bestScore = Infinity;
  tiles.forEach((t, k) => {
    if (k === idx) return;
    const c = center(t);
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const ok =
      dir === "left" ? dx < -1 :
      dir === "right" ? dx > 1 :
      dir === "up" ? dy < -1 :
      dy > 1;
    if (!ok) return;
    const horizontal = dir === "left" || dir === "right";
    const primary = horizontal ? Math.abs(dx) : Math.abs(dy);
    const cross = horizontal ? Math.abs(dy) : Math.abs(dx);
    const score = primary + cross * 2;
    if (score < bestScore) {
      bestScore = score;
      best = k;
    }
  });
  if (best >= 0) focus(best);
}

function launch() {
  location.href = tiles[idx].dataset.href;
}

input.on((intent) => {
  switch (intent) {
    case "up": move("up"); break;
    case "down": move("down"); break;
    case "left": move("left"); break;
    case "right": move("right"); break;
    case "enter": launch(); break;
    case "back": break; // at the hub root there's nowhere to go back to
  }
});

tiles.forEach((t, k) => {
  t.addEventListener("mouseenter", () => focus(k));
  t.addEventListener("click", (e) => { e.preventDefault(); idx = k; launch(); });
});

input.start();
focus(0);
window.addEventListener("resize", () => focus(idx));
