// Unified input layer — the same shared intent vocabulary the launcher and
// controller speak (up/down/left/right/enter/back), so this game never cares
// whether the player is on a keyboard, a TV remote, a gamepad, or (later) a
// phone controller relaying the same intents.
//
// This is the launcher's input layer with one game-specific addition: the
// movement intents (left/right/down) AUTO-REPEAT while the key is held (DAS —
// delayed auto-shift), so a held ← glides the piece. Rotate / hard-drop / back
// fire once per physical press and never repeat. The game stays a pure consumer
// of the intent stream.

// Platform Back/Return key codes: Escape (27) / Backspace (8) in browsers;
// vendor TV codes webOS 461, Tizen 10009, some Android TV remotes 4.
const BACK_KEYS = new Set([27, 8, 461, 10009, 4]);

const KEY_MAP = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "enter", " ": "enter",
  // WASD for desktop testing.
  w: "up", a: "left", s: "down", d: "right",
};

// Which intents glide when held, and the DAS timing (ms).
const REPEATING = new Set(["left", "right", "down"]);
const DAS_DELAY = 150;
const DAS_INTERVAL = 50;

// Touch gesture thresholds (px / ms): a small, quick contact is a tap (→ enter);
// a longer drag is a swipe (→ the dominant direction).
const SWIPE_MIN = 24;
const TAP_SLOP = 16;
const TAP_TIME = 300;

/** True on phones/tablets/touchscreens — used to reveal on-screen controls. */
export function isTouchDevice() {
  return "ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0;
}

export class Input {
  constructor() {
    this.handlers = new Set();
    this._held = new Set();      // intents currently held (keyboard), for edge + repeat
    this._timers = new Map();    // intent -> {delay, interval} timer handles
    this._gpPrev = {};
    this._touch = null;          // in-progress touch gesture
    this._onKey = this._onKey.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchEnd = this._onTouchEnd.bind(this);
    this._poll = this._poll.bind(this);
  }

  /** Subscribe to intents. handler(intent: string) => void. Returns unsubscribe. */
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Inject an intent from external touch UI (on-screen buttons, tappable cells).
   * Lets touch controls feed the exact same intent stream as keys/remote/gamepad.
   */
  emit(intent) {
    this._emit(intent);
  }

  start() {
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("touchstart", this._onTouchStart, { passive: true });
    window.addEventListener("touchend", this._onTouchEnd, { passive: true });
    if (isTouchDevice()) document.documentElement.classList.add("touch");
    if ("getGamepads" in navigator) requestAnimationFrame(this._poll);
    return this;
  }

  _emit(intent) {
    for (const h of this.handlers) h(intent);
  }

  // ---- Touch: swipe → direction, tap → enter ------------------------------
  // Gestures starting on an interactive element (button / link / tappable cell)
  // are ignored here so those controls keep their own tap handling.
  _onTouchStart(e) {
    const t = e.changedTouches[0];
    const el = e.target;
    const ignore = !!(el.closest && el.closest("button, a, input, [data-touch-ignore]"));
    this._touch = { x: t.clientX, y: t.clientY, time: now(), ignore };
  }

  _onTouchEnd(e) {
    const s = this._touch;
    this._touch = null;
    if (!s || s.ignore) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    if (adx < TAP_SLOP && ady < TAP_SLOP && now() - s.time < TAP_TIME) {
      this._emit("enter");
    } else if (Math.max(adx, ady) >= SWIPE_MIN) {
      if (adx > ady) this._emit(dx > 0 ? "right" : "left");
      else this._emit(dy > 0 ? "down" : "up");
    }
  }

  // Begin a held intent: emit once, and if it repeats, start its DAS timers.
  _press(intent) {
    if (this._held.has(intent)) return; // suppress OS key-repeat; we do our own
    this._held.add(intent);
    this._emit(intent);
    if (REPEATING.has(intent)) {
      const delay = setTimeout(() => {
        const interval = setInterval(() => this._emit(intent), DAS_INTERVAL);
        this._timers.set(intent, { interval });
      }, DAS_DELAY);
      this._timers.set(intent, { delay });
    }
  }

  _release(intent) {
    this._held.delete(intent);
    const t = this._timers.get(intent);
    if (t) {
      if (t.delay) clearTimeout(t.delay);
      if (t.interval) clearInterval(t.interval);
      this._timers.delete(intent);
    }
  }

  _onKey(e) {
    if (BACK_KEYS.has(e.keyCode)) {
      e.preventDefault();
      if (!e.repeat) this._emit("back");
      return;
    }
    const intent = KEY_MAP[e.key];
    if (intent) {
      e.preventDefault();
      // Rotate (up) and hard-drop (enter) are discrete: one press, one action.
      if (REPEATING.has(intent)) this._press(intent);
      else if (!e.repeat) this._emit(intent);
    }
  }

  _onKeyUp(e) {
    const intent = KEY_MAP[e.key];
    if (intent && REPEATING.has(intent)) this._release(intent);
  }

  _poll() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (!pad) continue;
      // Standard mapping: 12 up, 13 down, 14 left, 15 right, 0 = A, 1 = B.
      this._edge(pad.index, "up", pressed(pad, 12) || axis(pad, 1) < -0.5);
      this._edge(pad.index, "down", pressed(pad, 13) || axis(pad, 1) > 0.5);
      this._edge(pad.index, "left", pressed(pad, 14) || axis(pad, 0) < -0.5);
      this._edge(pad.index, "right", pressed(pad, 15) || axis(pad, 0) > 0.5);
      this._edge(pad.index, "enter", pressed(pad, 0));
      this._edge(pad.index, "back", pressed(pad, 1));
    }
    requestAnimationFrame(this._poll);
  }

  // Emit on the rising edge so a held button doesn't spam intents. Held
  // directional buttons fall back to the keyboard DAS via _press/_release so a
  // held D-pad glides the piece the same way.
  _edge(padIndex, intent, isDown) {
    const key = padIndex + ":" + intent;
    const was = this._gpPrev[key];
    if (isDown && !was) {
      if (REPEATING.has(intent)) this._press(intent);
      else this._emit(intent);
    } else if (!isDown && was && REPEATING.has(intent)) {
      this._release(intent);
    }
    this._gpPrev[key] = isDown;
  }
}

function pressed(pad, i) {
  const b = pad.buttons[i];
  return b ? b.pressed || b.value > 0.5 : false;
}
function axis(pad, i) {
  return pad.axes[i] || 0;
}
function now() {
  return performance.now();
}
