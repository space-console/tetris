// Scrabble engine — pure logic, no DOM. Owns the board, the tile bag, the racks,
// the rules (placement legality + word validation), the scoring, the dictionary
// (a Set for validation + a Trie for AI move generation), and the AI move
// generator (anchor-based / Appel–Jacobson). The app layer renders this and
// feeds it input; nothing here touches the document.
//
// Coordinates: the board is 15×15. A square is addressed by (row, col), both
// 0..14. The bag/rack hold single-character tile letters; a blank tile is the
// sentinel "?" in the bag/rack, and when placed it carries an assigned letter.

export const SIZE = 15;
export const CENTER = 7;
export const RACK_SIZE = 7;
export const BINGO_BONUS = 50;
export const MAX_SCORELESS = 6; // 6 successive scoreless turns end the game

// ---- Tile set: standard English distribution & point values ----------------
// letter -> { count, value }. "?" is the blank (×2, value 0).
export const TILE_DATA = {
  A: { count: 9, value: 1 }, B: { count: 2, value: 3 }, C: { count: 2, value: 3 },
  D: { count: 4, value: 2 }, E: { count: 12, value: 1 }, F: { count: 2, value: 4 },
  G: { count: 3, value: 2 }, H: { count: 2, value: 4 }, I: { count: 9, value: 1 },
  J: { count: 1, value: 8 }, K: { count: 1, value: 5 }, L: { count: 4, value: 1 },
  M: { count: 2, value: 3 }, N: { count: 6, value: 1 }, O: { count: 8, value: 1 },
  P: { count: 2, value: 3 }, Q: { count: 1, value: 10 }, R: { count: 6, value: 1 },
  S: { count: 4, value: 1 }, T: { count: 6, value: 1 }, U: { count: 4, value: 1 },
  V: { count: 2, value: 4 }, W: { count: 2, value: 4 }, X: { count: 1, value: 8 },
  Y: { count: 2, value: 4 }, Z: { count: 1, value: 10 }, "?": { count: 2, value: 0 },
};

/** Point value of a tile letter ("?" = blank = 0). */
export function letterValue(letter) {
  return (TILE_DATA[letter] || { value: 0 }).value;
}

/** Build the full 100-tile bag (unshuffled). */
export function buildBag() {
  const bag = [];
  for (const letter of Object.keys(TILE_DATA)) {
    for (let i = 0; i < TILE_DATA[letter].count; i++) bag.push(letter);
  }
  return bag;
}

// ---- Premium-square layout --------------------------------------------------
// Standard, symmetric Scrabble premiums. "TW"/"DW" multiply a whole word; "TL"/
// "DL" multiply one letter. The center (7,7) is a DW (the star). Encoded as a
// 15×15 grid string (one char per square) for the upper-left quadrant logic, but
// we just spell the canonical board out so it is unambiguous and easy to verify.
//   . = plain, t = TW, d = DW, T = TL, D = DL
const PREMIUM_ROWS = [
  "t..D...t...D..t",
  ".d...T...T...d.",
  "..d...D.D...d..",
  "D..d...D...d..D",
  "....d.....d....",
  ".T...T...T...T.",
  "..D...D.D...D..",
  "t..D...d...D..t",
  "..D...D.D...D..",
  ".T...T...T...T.",
  "....d.....d....",
  "D..d...D...d..D",
  "..d...D.D...d..",
  ".d...T...T...d.",
  "t..D...t...D..t",
];

export const PREMIUM = { NONE: 0, DL: 1, TL: 2, DW: 3, TW: 4 };
const PREMIUM_CHAR = { ".": PREMIUM.NONE, D: PREMIUM.DL, T: PREMIUM.TL, d: PREMIUM.DW, t: PREMIUM.TW };

/** Premium of a square as a PREMIUM.* enum. */
export function premiumAt(row, col) {
  return PREMIUM_CHAR[PREMIUM_ROWS[row][col]];
}

// ---- Dictionary: Set (validation) + Trie (AI generation) -------------------
// A compact Trie node is a plain object: children keyed by letter, with a
// boolean `$` marking a word end. Built once from the word list.
export class Dictionary {
  constructor(words) {
    this.set = new Set(words);
    this.root = Object.create(null);
    for (const w of words) this._insert(w);
  }

  _insert(word) {
    let node = this.root;
    for (let i = 0; i < word.length; i++) {
      const ch = word[i];
      node = node[ch] || (node[ch] = Object.create(null));
    }
    node.$ = true;
  }

  /** Is `word` a valid dictionary word? */
  isWord(word) {
    return this.set.has(word);
  }

  /** Trie root for AI traversal. */
  trieRoot() { return this.root; }
}

// Parse a newline-delimited word list (UPPERCASE, A–Z) into a Dictionary.
export function buildDictionary(text) {
  const words = text.split(/\r?\n/).filter((w) => w.length >= 2);
  return new Dictionary(words);
}

// ---- A placed tile on the board --------------------------------------------
// { letter: "A".."Z"  (the EFFECTIVE letter used for words),
//   blank: boolean      (true if this tile came from a blank, scores 0) }

// ---- The game --------------------------------------------------------------
export class Engine {
  constructor(dictionary) {
    this.dict = dictionary || null;
    this.reset(2);
  }

  setDictionary(dictionary) { this.dict = dictionary; }

  reset(playerCount = 2) {
    // board[row][col] = placed tile object or null.
    this.board = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
    this.bag = buildBag();
    this._shuffle(this.bag);
    this.players = [];
    for (let i = 0; i < playerCount; i++) {
      this.players.push({ rack: [], score: 0 });
    }
    for (const p of this.players) this._refill(p.rack);
    this.turn = 0;                 // index into players
    this.firstPlay = true;         // center must be covered on the first play
    this.scorelessStreak = 0;
    this.gameOver = false;
    this.lastPlay = null;          // { words:[{word,score}], total, bingo, by }
    this.history = [];             // turn log
  }

  // Fisher–Yates shuffle in place.
  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // Draw tiles from the bag into the rack up to RACK_SIZE.
  _refill(rack) {
    while (rack.length < RACK_SIZE && this.bag.length > 0) {
      rack.push(this.bag.pop());
    }
  }

  get current() { return this.players[this.turn]; }
  get bagCount() { return this.bag.length; }

  tileAt(row, col) {
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return null;
    return this.board[row][col];
  }

  // ---- Play validation & application ---------------------------------------
  // A placement is a list of { row, col, letter, blank } the player wants to add
  // to currently-empty squares. `letter` is the effective A–Z letter (for a
  // blank, the assigned letter). Returns a result object:
  //   { ok:true, words:[{word,score}], total, bingo }  on success (NOT applied)
  //   { ok:false, reason }                              on rejection
  // Use `commitPlay` to validate AND apply (draw fresh tiles, advance turn).

  validatePlay(placements) {
    if (!Array.isArray(placements) || placements.length === 0) {
      return { ok: false, reason: "No tiles placed" };
    }

    // 1) All on empty squares, in bounds, no duplicate squares.
    const seen = new Set();
    for (const p of placements) {
      if (p.row < 0 || p.row >= SIZE || p.col < 0 || p.col >= SIZE) {
        return { ok: false, reason: "Off the board" };
      }
      const key = p.row * SIZE + p.col;
      if (seen.has(key)) return { ok: false, reason: "Two tiles on one square" };
      seen.add(key);
      if (this.board[p.row][p.col]) return { ok: false, reason: "Square occupied" };
      if (!/^[A-Z]$/.test(p.letter)) return { ok: false, reason: "Bad letter" };
    }

    // 2) Single row OR single column.
    const rows = new Set(placements.map((p) => p.row));
    const cols = new Set(placements.map((p) => p.col));
    const sameRow = rows.size === 1;
    const sameCol = cols.size === 1;
    if (!sameRow && !sameCol) {
      return { ok: false, reason: "Tiles must share a row or column" };
    }
    // A single tile can extend in either direction; pick "across" if it has a
    // horizontal neighbour, else "down".
    let horizontal;
    if (sameRow && !sameCol) horizontal = true;
    else if (sameCol && !sameRow) horizontal = false;
    else {
      // exactly one tile: decide by neighbours
      const p = placements[0];
      const hasH = this.board[p.row][p.col - 1] || this.board[p.row][p.col + 1];
      horizontal = !!hasH;
    }

    // 3) Build a virtual board view including the placements.
    const view = (r, c) => {
      const found = placements.find((p) => p.row === r && p.col === c);
      if (found) return { letter: found.letter, blank: found.blank, isNew: true };
      const t = this.tileAt(r, c);
      return t ? { letter: t.letter, blank: t.blank, isNew: false } : null;
    };

    // 4) No gaps in the final line through the placed tiles (main word must be
    //    contiguous across both placed and pre-existing tiles).
    const line = horizontal ? placements[0].row : placements[0].col;
    const coords = placements.map((p) => (horizontal ? p.col : p.row)).sort((a, b) => a - b);
    for (let i = coords[0]; i <= coords[coords.length - 1]; i++) {
      const cell = horizontal ? view(line, i) : view(i, line);
      if (!cell) return { ok: false, reason: "Gap in the word" };
    }

    // 5) First-play / connectivity rules.
    if (this.firstPlay) {
      const coversCenter = placements.some((p) => p.row === CENTER && p.col === CENTER);
      if (!coversCenter) return { ok: false, reason: "First word must cover the center" };
    } else {
      // Must connect: at least one placed tile is adjacent to an existing tile,
      // OR the main word run includes a pre-existing tile.
      let connected = false;
      for (const p of placements) {
        const neighbours = [[p.row - 1, p.col], [p.row + 1, p.col], [p.row, p.col - 1], [p.row, p.col + 1]];
        for (const [r, c] of neighbours) {
          if (this.tileAt(r, c)) { connected = true; break; }
        }
        if (connected) break;
      }
      if (!connected) return { ok: false, reason: "Word must connect to the board" };
    }

    // 6) Collect every formed word: the main word + cross-words.
    const words = [];

    // Main word: extend from the placed run in the play direction.
    const main = this._collectWord(view, line, coords[0], horizontal);
    if (main && main.length >= 2) words.push(main);
    else if (placements.length === 1 && (!main || main.length < 2)) {
      // a lone tile that forms no length-≥2 main word; it must form a cross-word
      // (handled below) — otherwise it's not a real word.
    }

    // Cross-words: perpendicular run through each NEW tile, length ≥2.
    for (const p of placements) {
      const cross = this._collectWord(view, horizontal ? p.col : p.row,
        horizontal ? p.row : p.col, !horizontal);
      if (cross && cross.length >= 2) words.push(cross);
    }

    if (words.length === 0) {
      return { ok: false, reason: "No word of length 2+ formed" };
    }

    // 7) Every formed word must be valid.
    for (const w of words) {
      if (!this.dict.isWord(w.word)) {
        return { ok: false, reason: `“${w.word}” is not a word` };
      }
    }

    // 8) Score.
    let total = 0;
    const scored = [];
    for (const w of words) {
      const s = this._scoreWord(w);
      total += s;
      scored.push({ word: w.word, score: s });
    }
    const bingo = placements.length === RACK_SIZE;
    if (bingo) total += BINGO_BONUS;

    return { ok: true, words: scored, total, bingo };
  }

  // Walk the contiguous run of tiles (placed + existing) through a fixed line in
  // the given direction, starting from any cell on the run. Returns
  //   { word, cells:[{row,col,letter,blank,isNew,premium}] }  or null.
  // For `horizontal`, `fixed` = row and `start` = a column on the run.
  // For vertical, `fixed` = col and `start` = a row on the run.
  _collectWord(view, fixed, start, horizontal) {
    const at = (i) => (horizontal ? view(fixed, i) : view(i, fixed));
    // walk back to the start of the run
    let lo = start;
    while (at(lo - 1)) lo--;
    let hi = start;
    while (at(hi + 1)) hi++;
    if (hi === lo) {
      // single tile; only a real word if length ≥2 (caller filters)
      const c = at(lo);
      if (!c) return null;
    }
    const cells = [];
    let word = "";
    for (let i = lo; i <= hi; i++) {
      const c = at(i);
      const row = horizontal ? fixed : i;
      const col = horizontal ? i : fixed;
      word += c.letter;
      cells.push({ row, col, letter: c.letter, blank: c.blank, isNew: c.isNew, premium: premiumAt(row, col) });
    }
    return { word, cells, length: cells.length };
  }

  // Score one formed word, applying letter premiums to NEW tiles only and word
  // premiums when a NEW tile sits on one. Blanks contribute 0 letter value but
  // still trigger word premiums.
  _scoreWord(w) {
    let sum = 0;
    let wordMult = 1;
    for (const c of w.cells) {
      let lv = c.blank ? 0 : letterValue(c.letter);
      if (c.isNew) {
        if (c.premium === PREMIUM.DL) lv *= 2;
        else if (c.premium === PREMIUM.TL) lv *= 3;
        else if (c.premium === PREMIUM.DW) wordMult *= 2;
        else if (c.premium === PREMIUM.TW) wordMult *= 3;
      }
      sum += lv;
    }
    return sum * wordMult;
  }

  // Validate a play, then apply it: remove the used tiles from the current rack,
  // place them on the board, refill, advance the turn. Returns the same result
  // object as validatePlay (with ok). On ok:false nothing changes.
  // `placements` letters are effective letters; each carries `blank` so we know
  // which rack tile to consume ("?" for a blank).
  commitPlay(placements) {
    const result = this.validatePlay(placements);
    if (!result.ok) return result;

    const player = this.current;
    // Consume tiles from the rack: a blank consumes "?", otherwise the letter.
    const rack = player.rack.slice();
    for (const p of placements) {
      const need = p.blank ? "?" : p.letter;
      const idx = rack.indexOf(need);
      if (idx === -1) return { ok: false, reason: "Tile not in rack" };
      rack.splice(idx, 1);
    }
    player.rack = rack;

    // Place on the board.
    for (const p of placements) {
      this.board[p.row][p.col] = { letter: p.letter, blank: p.blank };
    }

    player.score += result.total;
    this.firstPlay = false;
    this.scorelessStreak = 0;
    this.lastPlay = {
      by: this.turn,
      words: result.words,
      total: result.total,
      bingo: result.bingo,
    };
    this.history.push({ type: "play", by: this.turn, ...result });

    // Out? (played last tile with empty bag)
    const wentOut = player.rack.length === 0 && this.bag.length === 0;
    this._refill(player.rack);

    if (wentOut) {
      this._finishGame(this.turn);
      return result;
    }

    this._advanceTurn();
    return result;
  }

  // Exchange tiles: return the given rack letters to the bag, redraw the same
  // count. Only allowed when the bag has ≥ RACK_SIZE tiles. Forfeits the turn
  // (counts as scoreless). `letters` are rack tile letters ("?" for blanks).
  exchange(letters) {
    if (this.bag.length < RACK_SIZE) {
      return { ok: false, reason: "Not enough tiles in the bag to exchange" };
    }
    if (!letters || letters.length === 0) {
      return { ok: false, reason: "Select tiles to exchange" };
    }
    const player = this.current;
    const rack = player.rack.slice();
    for (const l of letters) {
      const idx = rack.indexOf(l);
      if (idx === -1) return { ok: false, reason: "Tile not in rack" };
      rack.splice(idx, 1);
    }
    // Draw replacements first, then return the old tiles (so you can't redraw
    // the very tiles you put back this turn).
    const drawn = [];
    for (let i = 0; i < letters.length && this.bag.length > 0; i++) drawn.push(this.bag.pop());
    for (const l of letters) this.bag.push(l);
    this._shuffle(this.bag);
    player.rack = rack.concat(drawn);

    this.lastPlay = { by: this.turn, exchange: letters.length };
    this.history.push({ type: "exchange", by: this.turn, count: letters.length });
    this._scorelessTurn();
    return { ok: true, exchanged: letters.length };
  }

  // Pass: forfeit the turn (scoreless).
  pass() {
    this.lastPlay = { by: this.turn, pass: true };
    this.history.push({ type: "pass", by: this.turn });
    this._scorelessTurn();
    return { ok: true };
  }

  _scorelessTurn() {
    this.scorelessStreak += 1;
    if (this.scorelessStreak >= MAX_SCORELESS) {
      this._finishGame(null);
      return;
    }
    this._advanceTurn();
  }

  _advanceTurn() {
    this.turn = (this.turn + 1) % this.players.length;
  }

  // End the game and apply the rack adjustments.
  //   outPlayer: index of the player who went out, or null (scoreless end).
  _finishGame(outPlayer) {
    this.gameOver = true;
    let othersTotal = 0;
    for (let i = 0; i < this.players.length; i++) {
      const rackVal = this.players[i].rack.reduce((s, l) => s + letterValue(l), 0);
      this.players[i].score -= rackVal;
      if (i !== outPlayer) othersTotal += rackVal;
    }
    if (outPlayer !== null) this.players[outPlayer].score += othersTotal;

    // Determine winner (highest score; ties allowed).
    let best = -Infinity;
    let winners = [];
    this.players.forEach((p, i) => {
      if (p.score > best) { best = p.score; winners = [i]; }
      else if (p.score === best) winners.push(i);
    });
    this.winners = winners;
  }

  // ---------------------------------------------------------------------------
  // AI move generation — anchor-based (Appel–Jacobson). Returns an array of
  // candidate plays: { placements:[{row,col,letter,blank}], words, total, bingo }.
  // Each candidate is independently validated by validatePlay, so anything the AI
  // returns is guaranteed legal. We cap work with a candidate limit for speed.
  // ---------------------------------------------------------------------------
  generateMoves(rackLetters, opts = {}) {
    const limit = opts.limit || Infinity;
    const root = this.dict.trieRoot();
    const moves = [];
    const seen = new Set();

    // Find anchor squares: empty squares adjacent to a tile. On the first play
    // the only anchor is the center.
    const anchors = [];
    if (this.firstPlay) {
      anchors.push([CENTER, CENTER]);
    } else {
      for (let r = 0; r < SIZE; r++) {
        for (let c = 0; c < SIZE; c++) {
          if (this.board[r][c]) continue;
          if (this._hasNeighbourTile(r, c)) anchors.push([r, c]);
        }
      }
    }

    // For both orientations, generate from each anchor.
    for (const horizontal of [true, false]) {
      // Precompute cross-checks for this orientation.
      const crossCheck = this._buildCrossChecks(horizontal);
      for (const [ar, ac] of anchors) {
        this._genAtAnchor(ar, ac, horizontal, rackLetters, root, crossCheck, (placements) => {
          // Dedup by canonical key.
          const key = placements
            .map((p) => `${p.row},${p.col},${p.letter},${p.blank ? 1 : 0}`)
            .sort()
            .join("|");
          if (seen.has(key)) return;
          seen.add(key);
          const res = this.validatePlay(placements);
          if (res.ok) {
            moves.push({ placements, words: res.words, total: res.total, bingo: res.bingo });
          }
        });
        if (moves.length >= limit) return moves;
      }
    }
    return moves;
  }

  _hasNeighbourTile(r, c) {
    return !!(this.tileAt(r - 1, c) || this.tileAt(r + 1, c) ||
      this.tileAt(r, c - 1) || this.tileAt(r, c + 1));
  }

  // For each empty square, the set of letters that form a valid cross-word in the
  // perpendicular direction (or null = any letter, when there is no cross tile).
  // `horizontal` = the PLAY direction; cross-words run perpendicular to it.
  _buildCrossChecks(horizontal) {
    // cross[r][c] = Set of allowed letters, or null = all letters allowed.
    const cross = Array.from({ length: SIZE }, () => new Array(SIZE).fill(undefined));
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (this.board[r][c]) { cross[r][c] = null; continue; }
        // Look perpendicular to the play direction.
        const beforeTiles = [];
        const afterTiles = [];
        if (horizontal) {
          let i = r - 1;
          while (this.tileAt(i, c)) { beforeTiles.unshift(this.board[i][c].letter); i--; }
          i = r + 1;
          while (this.tileAt(i, c)) { afterTiles.push(this.board[i][c].letter); i++; }
        } else {
          let i = c - 1;
          while (this.tileAt(r, i)) { beforeTiles.unshift(this.board[r][i].letter); i--; }
          i = c + 1;
          while (this.tileAt(r, i)) { afterTiles.push(this.board[r][i].letter); i++; }
        }
        if (beforeTiles.length === 0 && afterTiles.length === 0) {
          cross[r][c] = null; // no cross constraint
          continue;
        }
        const prefix = beforeTiles.join("");
        const suffix = afterTiles.join("");
        const allowed = new Set();
        for (let k = 0; k < 26; k++) {
          const ch = String.fromCharCode(65 + k);
          if (this.dict.isWord(prefix + ch + suffix)) allowed.add(ch);
        }
        cross[r][c] = allowed;
      }
    }
    return cross;
  }

  // Generate all words anchored at (ar,ac) in the given orientation. Standard
  // Appel–Jacobson: build the left part (either over existing board tiles to the
  // left, or from the rack within the free space before the anchor), then extend
  // right through the trie.
  _genAtAnchor(ar, ac, horizontal, rackLetters, root, crossCheck, emit) {
    const before = step2(ar, ac, -1, horizontal); // square left of the anchor

    // If the square immediately before the anchor is filled, the left part is
    // fixed (those board letters); start the right extension after them, from
    // the anchor offset 0.
    if (this.tileAt(before[0], before[1])) {
      const stack = [];
      let [r, c] = before;
      while (this.tileAt(r, c)) { stack.unshift(this.board[r][c].letter); [r, c] = step2(r, c, -1, horizontal); }
      const node = this._trieNode(root, stack.join(""));
      if (node) this._extendRight(ar, ac, horizontal, rackLetters.slice(), node, 0, [], crossCheck, emit);
      return;
    }

    // Otherwise build left parts from the rack, bounded by the count of free,
    // non-anchor empty squares to the left (the Appel–Jacobson "limit").
    let limit = 0;
    let [lr, lc] = before;
    while (lr >= 0 && lc >= 0 && lr < SIZE && lc < SIZE &&
      !this.board[lr][lc] && !this._isAnchor(lr, lc)) {
      limit++;
      [lr, lc] = step2(lr, lc, -1, horizontal);
    }
    this._leftPart(ar, ac, horizontal, root, rackLetters.slice(), limit, [], crossCheck, emit);
  }

  _isAnchor(r, c) {
    if (this.board[r][c]) return false;
    if (this.firstPlay) return r === CENTER && c === CENTER;
    return this._hasNeighbourTile(r, c);
  }

  // Build the left part recursively. For each committed left length we launch the
  // rightward extension (which starts at the anchor, offset 0). `placed` holds
  // the rack tiles laid to the left of the anchor (negative offsets).
  _leftPart(ar, ac, horizontal, node, rack, limit, placed, crossCheck, emit) {
    this._extendRight(ar, ac, horizontal, rack.slice(), node, 0, placed.slice(), crossCheck, emit);
    if (limit === 0) return;
    const off = -(placed.length + 1); // next left square offset from the anchor
    const triedLetters = new Set();
    for (let i = 0; i < rack.length; i++) {
      const tile = rack[i];
      const letters = tile === "?" ? ALPHABET : [tile];
      for (const L of letters) {
        const fp = tile + L;
        if (triedLetters.has(fp)) continue;
        triedLetters.add(fp);
        if (!node[L]) continue;
        const nextRack = rack.slice();
        nextRack.splice(i, 1);
        const [r, c] = step2(ar, ac, off, horizontal);
        const np = placed.concat([{ row: r, col: c, letter: L, blank: tile === "?" }]);
        this._leftPart(ar, ac, horizontal, node[L], nextRack, limit - 1, np, crossCheck, emit);
      }
    }
  }

  // Extend rightward from the anchor through the trie. `offset` is the current
  // square's distance from the anchor along the play direction (0 = anchor).
  // Board tiles are consumed for free; rack tiles otherwise (respecting the
  // cross-check set). Emit when we reach a word end at a maximal run boundary.
  _extendRight(ar, ac, horizontal, rack, node, offset, placed, crossCheck, emit) {
    const [r, c] = step2(ar, ac, offset, horizontal);
    const onBoard = r >= 0 && c >= 0 && r < SIZE && c < SIZE;

    // Word completion: valid word, ≥1 rack tile placed, and the next square is
    // empty/off-board so the run is maximal.
    if (node.$ && placed.length > 0 && (!onBoard || !this.board[r][c])) {
      emit(placed.slice());
    }
    if (!onBoard) return;

    const boardTile = this.board[r][c];
    if (boardTile) {
      const L = boardTile.letter; // forced board letter
      if (node[L]) {
        this._extendRight(ar, ac, horizontal, rack, node[L], offset + 1, placed, crossCheck, emit);
      }
      return;
    }

    const allowed = crossCheck[r][c]; // null = any letter
    const triedLetters = new Set();
    for (let i = 0; i < rack.length; i++) {
      const tile = rack[i];
      const letters = tile === "?" ? ALPHABET : [tile];
      for (const L of letters) {
        const fp = tile + L;
        if (triedLetters.has(fp)) continue;
        triedLetters.add(fp);
        if (!node[L]) continue;
        if (allowed !== null && !allowed.has(L)) continue;
        const nextRack = rack.slice();
        nextRack.splice(i, 1);
        const np = placed.concat([{ row: r, col: c, letter: L, blank: tile === "?" }]);
        this._extendRight(ar, ac, horizontal, nextRack, node[L], offset + 1, np, crossCheck, emit);
      }
    }
  }

  // Follow a path of letters from a trie node; return the end node or null.
  _trieNode(root, str) {
    let node = root;
    for (const ch of str) {
      node = node[ch];
      if (!node) return null;
    }
    return node;
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

// Offset a coordinate from (r,c) by `d` squares along the play direction.
function step2(r, c, d, horizontal) {
  return horizontal ? [r, c + d] : [r + d, c];
}
