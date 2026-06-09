// Shared helper for on-screen touch controls. Builds buttons that feed the same
// intent stream as keys/remote/gamepad (via input.emit), so games stay pure
// consumers of intents. Uses Pointer Events, so the same buttons work for mouse,
// touch, and pen. Mark every button [data-touch-ignore] so the global swipe/tap
// gesture layer in input.js leaves them alone.

/**
 * Create a control button.
 * @param {string} label    visible glyph/text
 * @param {() => void} onPress  called once on press, and repeatedly while held if opts.hold
 * @param {{hold?: boolean, ariaLabel?: string, className?: string}} [opts]
 */
export function makeButton(label, onPress, opts = {}) {
  const { hold = false, ariaLabel, className = "" } = opts;
  const b = document.createElement("button");
  b.type = "button";
  b.className = ("tbtn " + className).trim();
  b.textContent = label;
  b.setAttribute("data-touch-ignore", "");
  if (ariaLabel) b.setAttribute("aria-label", ariaLabel);

  let delay = null;
  let interval = null;
  const stop = () => {
    if (delay) clearTimeout(delay);
    if (interval) clearInterval(interval);
    delay = interval = null;
  };
  const down = (e) => {
    e.preventDefault();        // no synthetic click / focus scroll / text select
    onPress();
    if (hold) {
      // Auto-repeat while held, matching the keyboard DAS feel.
      delay = setTimeout(() => { interval = setInterval(onPress, 80); }, 250);
    }
  };
  b.addEventListener("pointerdown", down);
  b.addEventListener("pointerup", stop);
  b.addEventListener("pointerleave", stop);
  b.addEventListener("pointercancel", stop);
  return b;
}

/**
 * Build a row/grid of buttons into `container` from specs.
 * Each spec: { label, intent? , onPress?, hold?, ariaLabel?, className? }.
 * If `intent` is given, the button emits that intent via input.emit.
 */
export function mountButtons(container, input, specs) {
  for (const s of specs) {
    const press = s.onPress || (() => input.emit(s.intent));
    container.appendChild(
      makeButton(s.label, press, {
        hold: s.hold,
        ariaLabel: s.ariaLabel || s.intent,
        className: s.className,
      })
    );
  }
  return container;
}
