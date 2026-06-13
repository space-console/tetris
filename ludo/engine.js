// Ludo engine — pure game logic, no DOM. Seedable die RNG.
//
// Board model
// -----------
// Four colours: red, green, yellow, blue (turn order is fixed in that sequence).
// Each colour owns 4 tokens. A token's position is one of:
//   { zone: "yard" }                       — in the home yard, awaiting a 6
//   { zone: "track", step: 0..51 }         — on the shared 52-square main ring
//   { zone: "home",  step: 0..5 }          — on this colour's 6-square home column
//   { zone: "finish" }                     — reached the centre (step 6 of home)
//
// The 52 main-track squares are numbered 0..51 clockwise. Each colour enters the
// ring at a fixed START square and, after travelling 51 squares (its 50 squares
// of shared travel + the entry), turns up its own home column. We store, per
// colour, the absolute ring index of its START. A token's progress is measured
// 0..56: 0 = just entered at START, 50 = the square before its home turn, then
// 51..55 = the five home-column squares, 56 = finish (exact count required).
//
// Concretely a token leaves the yard onto START (progress 0). Each die pip adds
// to progress. progress 0..50 map to ring squares (START + progress) mod 52.
// progress 51..55 map to home-column steps 0..4, progress 56 = the finish cell
// (home-column step 5 / centre). So the path length from START to finish is 56.
//
// Safe squares: every colour's START square plus the four "star" squares that
// sit 8 squares clockwise from each START. A token on a safe square cannot be
// captured.

export const COLORS = ["red", "green", "yellow", "blue"];

// Ring index of each colour's START square (classic layout, clockwise). Red
// starts bottom-left-ish; the four are spaced 13 apart around the 52-ring.
export const START = { red: 0, green: 13, yellow: 26, blue: 39 };

// A token's full path is 0..56 (56 = finish). 0..50 live on the ring.
export const TRACK_LEN = 52;     // shared ring squares
export const HOME_LEN = 6;       // home-column squares incl. the finish cell
export const PATH_FINISH = 56;   // progress value meaning "at the finish"
export const PATH_HOME_ENTRY = 51; // first progress value inside the home column

// Safe ring squares: the four START squares and the four stars (START + 8).
export const SAFE_SQUARES = new Set();
for (const c of COLORS) {
  SAFE_SQUARES.add(START[c]);
  SAFE_SQUARES.add((START[c] + 8) % TRACK_LEN);
}

// Map a colour + progress (0..56) to a concrete position object.
export function positionFor(color, progress) {
  if (progress >= PATH_FINISH) return { zone: "finish" };
  if (progress >= PATH_HOME_ENTRY) {
    return { zone: "home", step: progress - PATH_HOME_ENTRY }; // 0..4
  }
  return { zone: "track", step: (START[color] + progress) % TRACK_LEN };
}

// A small seedable PRNG (mulberry32) so games are reproducible in tests.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Engine {
  constructor(seed = 1) {
    this.reset(seed);
  }

  reset(seed = (Math.random() * 2 ** 32) >>> 0) {
    this._rng = mulberry32(seed);
    // tokens[color] = array of 4 progress values; -1 means "in the yard".
    this.tokens = {};
    for (const c of COLORS) this.tokens[c] = [-1, -1, -1, -1];
    this.turn = "red";          // whose turn it is
    this.die = null;            // last rolled die value (1..6), or null
    this.sixStreak = 0;         // consecutive 6s this turn (forfeit at 3)
    this.winner = null;         // colour that has finished all 4, or null
    this.awaitingMove = false;  // a die is rolled and a legal move is pending
    return this;
  }

  // ---- Die -----------------------------------------------------------------
  // Roll the die (1..6). Tracks the consecutive-six streak. Returns the value.
  roll() {
    const value = 1 + Math.floor(this._rng() * 6);
    this.die = value;
    if (value === 6) this.sixStreak += 1;
    else this.sixStreak = 0;
    return value;
  }

  // Three 6s in a row forfeits the turn (and any progress this turn is void).
  isThirdSix() {
    return this.die === 6 && this.sixStreak >= 3;
  }

  // ---- Positions -----------------------------------------------------------
  // Concrete position of a colour's token (0..3).
  position(color, token) {
    const p = this.tokens[color][token];
    if (p < 0) return { zone: "yard" };
    return positionFor(color, p);
  }

  // True once every token of `color` is at the finish.
  hasWon(color) {
    return this.tokens[color].every((p) => p >= PATH_FINISH);
  }

  // ---- Legal moves ---------------------------------------------------------
  // For a given die, return the list of legal moves:
  //   { token, fromProgress, toProgress, capture: color|null, finishes: bool }
  // A move is legal when the destination is reachable by EXACT count: a yard
  // token only with a 6 (entering at START); a track/home token only if the new
  // progress does not overshoot the finish (progress 56).
  legalMoves(color, die) {
    const moves = [];
    const tk = this.tokens[color];
    for (let token = 0; token < 4; token++) {
      const from = tk[token];

      if (from < 0) {
        // In the yard: can only leave on a 6, landing on START (progress 0).
        if (die === 6) {
          const cap = this._captureAt(color, 0);
          moves.push({ token, fromProgress: -1, toProgress: 0, capture: cap, finishes: false });
        }
        continue;
      }

      if (from >= PATH_FINISH) continue; // already finished, immovable

      const to = from + die;
      if (to > PATH_FINISH) continue;    // overshoot: no move

      const finishes = to === PATH_FINISH;
      // Captures only happen on the shared ring (home column is private).
      const cap = to < PATH_HOME_ENTRY ? this._captureAt(color, to) : null;
      moves.push({ token, fromProgress: from, toProgress: to, capture: cap, finishes });
    }
    return moves;
  }

  // If a single opponent token sits on the ring square that `color` would reach
  // at `toProgress`, and that square is not safe, return the opponent colour to
  // be captured (otherwise null). A square shared by 2+ same-colour tokens forms
  // a block and is not captured; we only capture a lone opponent token.
  _captureAt(color, toProgress) {
    if (toProgress >= PATH_HOME_ENTRY) return null; // not on the ring
    const ring = (START[color] + toProgress) % TRACK_LEN;
    if (SAFE_SQUARES.has(ring)) return null;        // safe square: no capture
    let foundColor = null;
    let count = 0;
    for (const other of COLORS) {
      if (other === color) continue;
      for (let t = 0; t < 4; t++) {
        const p = this.tokens[other][t];
        if (p < 0 || p >= PATH_HOME_ENTRY) continue;
        if ((START[other] + p) % TRACK_LEN === ring) {
          count += 1;
          foundColor = other;
        }
      }
    }
    // A lone opponent token is captured; a block of two is not.
    if (count === 1) return foundColor;
    return null;
  }

  // ---- Applying a move -----------------------------------------------------
  // Apply a legal move for `color` using `die`. Returns a result describing what
  // happened: { captured: color|null, finished: bool, extraRoll: bool, won: bool }.
  move(color, token, die) {
    const legal = this.legalMoves(color, die).find((m) => m.token === token);
    if (!legal) return null; // illegal: caller must only pass legal moves

    // Apply capture first (send the lone opponent token home).
    let captured = null;
    if (legal.capture) {
      const ring = (START[color] + legal.toProgress) % TRACK_LEN;
      const victim = legal.capture;
      for (let t = 0; t < 4; t++) {
        const p = this.tokens[victim][t];
        if (p >= 0 && p < PATH_HOME_ENTRY && (START[victim] + p) % TRACK_LEN === ring) {
          this.tokens[victim][t] = -1; // back to the yard
          captured = victim;
          break;
        }
      }
    }

    this.tokens[color][token] = legal.toProgress;

    const finished = legal.finishes;
    const won = this.hasWon(color);
    if (won) this.winner = color;

    // Extra roll (standard Ludo): you get another turn for rolling a 6 (unless
    // it's the forfeiting third six), for capturing an opponent, or for sending a
    // token home to the finish.
    const extraRoll = !won && (
      (die === 6 && this.sixStreak < 3) ||
      captured !== null ||
      finished
    );

    this.die = null;
    this.awaitingMove = false;
    return { captured, finished, extraRoll, won };
  }

  // Advance to the next colour's turn (clockwise), resetting per-turn die state.
  nextTurn() {
    const i = COLORS.indexOf(this.turn);
    this.turn = COLORS[(i + 1) % COLORS.length];
    this.die = null;
    this.sixStreak = 0;
    this.awaitingMove = false;
  }
}
