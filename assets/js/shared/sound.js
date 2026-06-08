// Sound — tiny WebAudio synth, no assets, no dependencies (keeps the zero-build,
// zero-binary ethos). Every effect is a short oscillator blip with a quick
// attack/decay envelope, mixed through a master gain so one mute toggle silences
// everything. Browsers require a user gesture before audio starts, so call
// resume() from the first key press (the Enter that starts the game).

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = false;
    this.volume = 0.25;
  }

  // Lazily create (and unlock) the audio graph. Returns false if WebAudio is
  // unavailable so callers can no-op silently.
  _ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    return true;
  }

  /** Call on a user gesture to unlock audio (autoplay policies). */
  resume() {
    this._ensure();
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volume;
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // One note: frequency (Hz), duration (s), wave type, start offset (s), volume.
  _blip(freq, dur, type = "square", when = 0, vol = 1) {
    if (this.muted || !this._ensure()) return;
    const t0 = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    // Exponential ramps can't reach 0, so floor at a tiny epsilon.
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  // A short rising/falling sequence of notes.
  _seq(freqs, dur, type, step, vol) {
    freqs.forEach((f, i) => this._blip(f, dur, type, i * step, vol));
  }

  move() { this._blip(200, 0.045, "square", 0, 0.4); }
  rotate() { this._blip(330, 0.06, "square", 0, 0.5); }
  lock() { this._blip(150, 0.08, "triangle", 0, 0.6); }
  drop() { this._blip(90, 0.13, "sawtooth", 0, 0.6); }

  // Line clear: a bright ascending arpeggio; a 4-line Tetris gets a longer one.
  clear(n) {
    if (n >= 4) this._seq([523, 659, 784, 1047], 0.13, "square", 0.06, 0.6);
    else this._seq([440, 554, 659].slice(0, Math.max(2, n + 1)), 0.11, "square", 0.06, 0.6);
  }

  levelUp() { this._seq([523, 659, 784, 1047], 0.1, "triangle", 0.05, 0.55); }
  start() { this._seq([392, 523, 659], 0.1, "square", 0.07, 0.5); }
  gameOver() { this._seq([330, 262, 196, 131], 0.18, "sawtooth", 0.12, 0.55); }
}
