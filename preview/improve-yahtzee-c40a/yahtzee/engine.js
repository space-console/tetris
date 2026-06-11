// Yahtzee engine — the pure game core (single player, standard rules). No DOM,
// no rendering, no input: it owns the five dice, the held mask, the roll counter,
// the scorecard (13 categories), and the scoring rules + bonus bookkeeping.
// app.js drives it from the intent stream and renders its state.
//
// The RNG is injectable (constructor arg) so tests can feed deterministic dice.

// ---- Categories -----------------------------------------------------------
// Each category has a stable `key` (used as the scorecard index and the row id),
// a display `name`, and whether it belongs to the upper or lower section. The
// order here is the canonical scorecard order (top → bottom).
export const CATEGORIES = [
  { key: "ones", name: "Ones", section: "upper", face: 1 },
  { key: "twos", name: "Twos", section: "upper", face: 2 },
  { key: "threes", name: "Threes", section: "upper", face: 3 },
  { key: "fours", name: "Fours", section: "upper", face: 4 },
  { key: "fives", name: "Fives", section: "upper", face: 5 },
  { key: "sixes", name: "Sixes", section: "upper", face: 6 },
  { key: "threeKind", name: "Three of a Kind", section: "lower" },
  { key: "fourKind", name: "Four of a Kind", section: "lower" },
  { key: "fullHouse", name: "Full House", section: "lower" },
  { key: "smallStraight", name: "Small Straight", section: "lower" },
  { key: "largeStraight", name: "Large Straight", section: "lower" },
  { key: "yahtzee", name: "Yahtzee", section: "lower" },
  { key: "chance", name: "Chance", section: "lower" },
];

export const UPPER_KEYS = CATEGORIES.filter((c) => c.section === "upper").map((c) => c.key);
export const LOWER_KEYS = CATEGORIES.filter((c) => c.section === "lower").map((c) => c.key);

export const UPPER_BONUS_THRESHOLD = 63; // upper subtotal ≥ this earns the bonus
export const UPPER_BONUS = 35;
export const YAHTZEE_BONUS = 100;        // per extra Yahtzee after the first scored 50
export const MAX_ROLLS = 3;              // initial roll + up to 2 re-rolls

// ---- Scoring (pure) -------------------------------------------------------
// Build a face → count map for a five-dice array (faces 1..6).
function counts(dice) {
  const c = [0, 0, 0, 0, 0, 0, 0]; // index by face (1..6); index 0 unused
  for (const d of dice) c[d] += 1;
  return c;
}

const sum = (dice) => dice.reduce((a, b) => a + b, 0);

// Score `dice` for a single category key. Returns the points (0 if it doesn't
// qualify). Pure — no engine state, so it's directly unit-testable.
export function scoreFor(category, dice) {
  const c = counts(dice);
  const total = sum(dice);
  switch (category) {
    // Upper section: sum of the dice showing that face.
    case "ones": return c[1] * 1;
    case "twos": return c[2] * 2;
    case "threes": return c[3] * 3;
    case "fours": return c[4] * 4;
    case "fives": return c[5] * 5;
    case "sixes": return c[6] * 6;
    // Three / Four of a Kind: sum of ALL dice when ≥3 / ≥4 of one face.
    case "threeKind": return c.some((n) => n >= 3) ? total : 0;
    case "fourKind": return c.some((n) => n >= 4) ? total : 0;
    // Full House: a triple plus a pair (a five-of-a-kind also counts here). 25.
    case "fullHouse": {
      const hasThree = c.some((n) => n === 3);
      const hasTwo = c.some((n) => n === 2);
      const hasFive = c.some((n) => n === 5); // 5 of a kind plays as a full house
      return (hasThree && hasTwo) || hasFive ? 25 : 0;
    }
    // Small Straight: four consecutive faces (1234 / 2345 / 3456). 30.
    case "smallStraight": return hasRun(c, 4) ? 30 : 0;
    // Large Straight: five consecutive faces (12345 / 23456). 40.
    case "largeStraight": return hasRun(c, 5) ? 40 : 0;
    // Yahtzee: five of a kind. 50.
    case "yahtzee": return c.some((n) => n === 5) ? 50 : 0;
    // Chance: sum of all dice, always.
    case "chance": return total;
    default: return 0;
  }
}

// True if the count map contains a run of `len` consecutive faces.
function hasRun(c, len) {
  let run = 0;
  for (let face = 1; face <= 6; face++) {
    run = c[face] > 0 ? run + 1 : 0;
    if (run >= len) return true;
  }
  return false;
}

// True if the dice are a Yahtzee (five of a kind).
export function isYahtzee(dice) {
  return counts(dice).some((n) => n === 5);
}

export class Engine {
  // rng: () => number in [0,1). Defaults to Math.random; inject for tests.
  constructor(rng = Math.random) {
    this.rng = rng;
    this.reset();
  }

  // Full reset: empty scorecard, no dice rolled, fresh turn counters.
  reset() {
    this.dice = [1, 1, 1, 1, 1];                 // current faces
    this.held = [false, false, false, false, false];
    this.rollsLeft = MAX_ROLLS;                  // rolls remaining this turn
    this.hasRolled = false;                      // any roll happened this turn?
    // Scorecard: category key → number (final score) or null (unused).
    this.scores = {};
    for (const cat of CATEGORIES) this.scores[cat.key] = null;
    this.yahtzeeBonus = 0;                        // accumulated +100s
  }

  // ---- Rolling ------------------------------------------------------------
  // Roll all non-held dice. `holdMask` (array of 5 booleans) optionally sets the
  // held state first; omit to keep the current holds. Returns true if a roll
  // happened. The first roll of a turn ignores holds (all dice are fresh).
  roll(holdMask) {
    if (this.rollsLeft <= 0) return false;
    if (Array.isArray(holdMask)) this.held = holdMask.slice(0, 5);

    for (let i = 0; i < 5; i++) {
      // On the very first roll nothing is held yet; afterwards keep held dice.
      if (!this.hasRolled || !this.held[i]) {
        this.dice[i] = 1 + Math.floor(this.rng() * 6);
      }
    }
    this.hasRolled = true;
    this.rollsLeft -= 1;
    return true;
  }

  // Toggle the held state of die index i (0..4). Only meaningful mid-turn after
  // the first roll and while re-rolls remain.
  toggleHold(i) {
    if (i < 0 || i > 4) return false;
    if (!this.hasRolled) return false;
    this.held[i] = !this.held[i];
    return true;
  }

  canRoll() {
    return this.rollsLeft > 0 && !this.isGameOver();
  }

  // ---- Scoring ------------------------------------------------------------
  // Potential score for every UNUSED category, given the current dice. Returns
  // { key → points }. Used by the UI to preview the player's options. Only valid
  // once the dice have been rolled this turn.
  previewScores(dice = this.dice) {
    const preview = {};
    for (const cat of CATEGORIES) {
      if (this.scores[cat.key] === null) preview[cat.key] = scoreFor(cat.key, dice);
    }
    return preview;
  }

  // Commit the current dice to `category` (must be unused), ending the turn.
  // Applies the standard Yahtzee bonus: any extra Yahtzee rolled after the first
  // one has been scored as 50 grants +100, regardless of which category it's
  // banked in. (Joker forced-scoring rules are intentionally NOT implemented —
  // the player may freely place a bonus Yahtzee in any open category.)
  // Returns the result { key, points, yahtzeeBonus, scoredYahtzee } or null.
  score(category) {
    if (this.scores[category] === undefined) return null; // unknown key
    if (this.scores[category] !== null) return null;      // already used
    if (!this.hasRolled) return null;                     // nothing to score

    const points = scoreFor(category, this.dice);
    let bonus = 0;
    // Yahtzee bonus: a rolled Yahtzee earns +100 ONLY if the Yahtzee category was
    // already scored as a (non-zero) 50 earlier this game.
    if (isYahtzee(this.dice) && this.scores.yahtzee === 50) {
      bonus = YAHTZEE_BONUS;
      this.yahtzeeBonus += bonus;
    }

    this.scores[category] = points;
    const result = {
      key: category,
      points,
      yahtzeeBonus: bonus,
      scoredYahtzee: points === 50 && category === "yahtzee",
    };
    this._nextTurn();
    return result;
  }

  // Reset the dice/roll state for the next turn (scorecard is untouched).
  _nextTurn() {
    this.held = [false, false, false, false, false];
    this.rollsLeft = MAX_ROLLS;
    this.hasRolled = false;
  }

  // ---- Totals -------------------------------------------------------------
  // Sum of the filled upper-section categories (Ones..Sixes).
  upperSubtotal() {
    return UPPER_KEYS.reduce((t, k) => t + (this.scores[k] || 0), 0);
  }

  // +35 once the upper subtotal reaches the threshold (63).
  upperBonus() {
    return this.upperSubtotal() >= UPPER_BONUS_THRESHOLD ? UPPER_BONUS : 0;
  }

  // Sum of the filled lower-section categories (no bonuses).
  lowerSubtotal() {
    return LOWER_KEYS.reduce((t, k) => t + (this.scores[k] || 0), 0);
  }

  // Grand total: upper + upper bonus + lower + accumulated Yahtzee bonuses.
  total() {
    return (
      this.upperSubtotal() +
      this.upperBonus() +
      this.lowerSubtotal() +
      this.yahtzeeBonus
    );
  }

  // All 13 categories filled → game over.
  isGameOver() {
    return CATEGORIES.every((c) => this.scores[c.key] !== null);
  }

  // Convenience for the UI: which roll number are we on (1..3) for status.
  rollNumber() {
    return MAX_ROLLS - this.rollsLeft;
  }
}
