// Tic-Tac-Boom — pure game engine (no DOM, no timers, no I/O).
// The bomb is passed between hot-seat players. On each turn the holder must type
// a valid word CONTAINING the shown letter combo before the (hidden, random)
// fuse runs out. A valid word passes the bomb on with a fresh combo; if the fuse
// reaches zero while a player holds the bomb, that player loses a life. A player
// at 0 lives is eliminated; the last one standing wins.
//
// This module is deliberately deterministic and dependency-free so it can be
// unit-tested with a tiny injected dictionary. The DOM/app layer owns the real
// clock: it advances the fuse (dt) and calls explode() when it hits zero.
//
// Construction injects the word data so the engine never touches the network:
//   new Engine({ dict: Set<string>, combos: string[], players, lives, rng })
// `dict` is a Set of UPPERCASE words; `combos` is the list of satisfiable letter
// combos (substrings that appear in many dict words); `rng` defaults to
// Math.random and can be replaced for deterministic tests.

export class Engine {
  constructor({ dict, combos, players = 3, lives = 2, rng = Math.random } = {}) {
    if (!dict || typeof dict.has !== "function") {
      throw new Error("Engine requires a dictionary Set");
    }
    if (!Array.isArray(combos) || combos.length === 0) {
      throw new Error("Engine requires a non-empty combos list");
    }
    this.dict = dict;
    this.combos = combos;
    this.rng = rng;

    this.numPlayers = players;
    this.startLives = lives;
    // Lives per player, indexed by player number (0-based). 0 = eliminated.
    this.lives = new Array(players).fill(lives);

    this.current = 0;        // whose turn / who holds the bomb
    this.combo = "";         // the combo the current holder must satisfy
    this.used = new Set();   // words already played THIS round
    this.winner = null;      // winning player index once the game ends

    this.startRound(0);
  }

  // ---- Combos --------------------------------------------------------------
  /**
   * Pick a random combo that is satisfiable by the injected dictionary. The
   * combos list is pre-filtered (by the app) to only ever contain satisfiable
   * substrings, so any pick is guaranteed to have many valid words.
   */
  pickCombo() {
    const i = Math.floor(this.rng() * this.combos.length);
    this.combo = this.combos[Math.min(i, this.combos.length - 1)];
    return this.combo;
  }

  // ---- Round lifecycle -----------------------------------------------------
  /** Start a fresh round held by `holder`: new combo, cleared used-word list. */
  startRound(holder) {
    this.current = holder;
    this.used = new Set();
    this.pickCombo();
  }

  // ---- Word submission -----------------------------------------------------
  /**
   * Try to play `word` for the current holder.
   * @returns {{ok: boolean, reason?: string, word?: string}}
   *   reason ∈ "empty" | "notword" | "nocombo" | "used".
   * On success the word is recorded, a new combo is drawn, and the bomb passes
   * to the next surviving player. The fuse (owned by the app) keeps running.
   */
  submit(word) {
    const w = String(word || "").trim().toUpperCase();
    if (!w) return { ok: false, reason: "empty" };
    if (!w.includes(this.combo)) return { ok: false, reason: "nocombo" };
    if (!this.dict.has(w)) return { ok: false, reason: "notword" };
    if (this.used.has(w)) return { ok: false, reason: "used" };

    this.used.add(w);
    this.pickCombo();
    this.current = this.nextPlayer(this.current);
    return { ok: true, word: w };
  }

  // ---- Turn rotation -------------------------------------------------------
  /** Next still-alive player after `from`, wrapping; skips eliminated players. */
  nextPlayer(from) {
    if (this.aliveCount() === 0) return from;
    let i = from;
    for (let step = 0; step < this.numPlayers; step++) {
      i = (i + 1) % this.numPlayers;
      if (this.lives[i] > 0) return i;
    }
    return from; // only the holder is alive (shouldn't pass in that case)
  }

  // ---- Explosion -----------------------------------------------------------
  /**
   * The fuse hit zero while the current holder still had the bomb: they lose a
   * life and may be eliminated. The next round is started by the next survivor.
   * @returns {{holder, eliminated, winner}} — winner is set if the game ended.
   */
  explode() {
    const holder = this.current;
    this.lives[holder] = Math.max(0, this.lives[holder] - 1);
    const eliminated = this.lives[holder] === 0;

    if (this.aliveCount() <= 1) {
      this.winner = this.firstAlive();
      return { holder, eliminated, winner: this.winner };
    }

    // The bomb (next round) goes to the next survivor after the holder. If the
    // holder is still alive, that means starting after them; if they were just
    // eliminated, nextPlayer already skips them.
    const next = this.nextPlayer(holder);
    this.startRound(next);
    return { holder, eliminated, winner: null };
  }

  // ---- Queries -------------------------------------------------------------
  aliveCount() {
    return this.lives.reduce((n, l) => n + (l > 0 ? 1 : 0), 0);
  }

  firstAlive() {
    for (let i = 0; i < this.numPlayers; i++) if (this.lives[i] > 0) return i;
    return null;
  }

  isOver() {
    return this.winner !== null;
  }
}

/**
 * Build the validation Set from the raw words.txt text (UPPERCASE, one per line).
 * Words shorter than 2 letters are dropped (no useful combos there).
 */
export function buildDictionary(text) {
  const words = text.split(/\r?\n/);
  const set = new Set();
  for (const w of words) {
    const t = w.trim();
    if (t.length >= 2) set.add(t.toUpperCase());
  }
  return set;
}

/**
 * Scan the dictionary for COMMON 2–3 letter substrings and return the ones that
 * appear in at least `minWords` distinct words, sorted by frequency. Every combo
 * returned is therefore satisfiable by many words, keeping rounds fair.
 *
 * @param {Set<string>} dict   the validation set (UPPERCASE words)
 * @param {{minWords?: number, max?: number, lengths?: number[]}} [opts]
 * @returns {string[]} satisfiable combos, most common first
 */
export function buildCombos(dict, opts = {}) {
  const { minWords = 300, max = 600, lengths = [2, 3] } = opts;
  const counts = new Map();
  for (const word of dict) {
    // Count each substring once per word (distinct-word frequency).
    const seen = new Set();
    for (const len of lengths) {
      for (let i = 0; i + len <= word.length; i++) {
        const sub = word.slice(i, i + len);
        if (!/^[A-Z]+$/.test(sub)) continue;
        seen.add(sub);
      }
    }
    for (const sub of seen) counts.set(sub, (counts.get(sub) || 0) + 1);
  }
  const combos = [];
  for (const [sub, n] of counts) if (n >= minWords) combos.push([sub, n]);
  combos.sort((a, b) => b[1] - a[1]);
  return combos.slice(0, max).map(([sub]) => sub);
}
