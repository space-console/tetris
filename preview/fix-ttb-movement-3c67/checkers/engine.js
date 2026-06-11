// Checkers engine — the pure game core (American / English draughts, 8×8).
// No DOM, no rendering, no input: it owns the board, the side to move, move
// history, full legal-move generation (mandatory capture + multi-jump), the
// promotion-to-king rule, last-move info, and the game-over / winner verdict.
// app.js drives it from the intent stream and renders its state.
//
// Board model: a flat 64-length array indexed 0..63, row 0 at the top down to
// row 7 at the bottom. index = row * 8 + col. Only the 32 dark squares are ever
// occupied — a dark square has (row + col) odd. RED is the human side at the
// bottom (rows 5..7 to start) and moves UP (decreasing row). WHITE sits at the
// top (rows 0..2) and moves DOWN (increasing row).
//
// A square is `null` (empty) or a piece object { color, king }:
//   color ∈ { r, w }   king ∈ { true, false }.

export const RED = "r";
export const WHITE = "w";

// ---- Square helpers -------------------------------------------------------
export function rc(index) { return [Math.floor(index / 8), index % 8]; }
export function idx(row, col) { return row * 8 + col; }
function onBoard(row, col) { return row >= 0 && row < 8 && col >= 0 && col < 8; }
function isDark(row, col) { return (row + col) % 2 === 1; }

// The diagonal directions a man may travel, by colour (row delta, col delta).
// RED advances upward (-1), WHITE downward (+1). Kings use both.
const FWD = {
  r: [[-1, -1], [-1, 1]],
  w: [[1, -1], [1, 1]],
};
const ALL_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

function other(color) { return color === RED ? WHITE : RED; }

export class Engine {
  constructor() {
    this.reset();
  }

  reset() {
    // Place 12 men per side on the dark squares of the first three rows each.
    this.board = new Array(64).fill(null);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        if (!isDark(row, col)) continue;
        if (row < 3) this.board[idx(row, col)] = { color: WHITE, king: false };
        else if (row > 4) this.board[idx(row, col)] = { color: RED, king: false };
      }
    }
    this.turn = RED;        // Red (human, bottom) moves first
    this.history = [];      // applied move records
    this.lastMove = null;   // { from, to, path } for highlighting
    this.gameOver = false;
    this.winner = null;     // 'r' | 'w' when a side has no legal move
  }

  // ---- Queries ------------------------------------------------------------

  pieceAt(index) { return this.board[index]; }

  /** Side-to-move status: { turn, winner, gameOver }. */
  status() {
    return { turn: this.turn, winner: this.winner, gameOver: this.gameOver };
  }

  /**
   * All legal moves for `color`, honouring mandatory capture and full
   * multi-jump chains. Each move record is:
   *   { from, to, color, captures: [idx...], path: [from, ...steps, to],
   *     isJump, promote }
   * If any capture exists for the side, only capturing moves are returned. A
   * multi-jump is a single record whose `captures` lists every removed piece
   * and whose `path` walks every landing square.
   */
  allLegalMoves(color = this.turn) {
    const jumps = [];
    const steps = [];
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (!p || p.color !== color) continue;
      const pieceJumps = this._jumpsFrom(i, p.color, p.king, []);
      if (pieceJumps.length) {
        // _jumpsFrom builds path as landing squares only; prepend the origin so
        // path = [from, land1, land2, ...] and path[1] is the first landing.
        for (const j of pieceJumps) j.path = [i, ...j.path];
        jumps.push(...pieceJumps);
      } else {
        steps.push(...this._stepsFrom(i, p));
      }
    }
    // Mandatory capture: if any jump exists anywhere, only jumps are legal.
    return jumps.length ? jumps : steps;
  }

  /** Legal moves originating from `from` for the side to move (or []). */
  legalMoves(from) {
    const p = this.board[from];
    if (!p || p.color !== this.turn) return [];
    return this.allLegalMoves(this.turn).filter((m) => m.from === from);
  }

  /** Convenience: the NEXT landing square of each legal move from `from`. */
  legalTargets(from) {
    return this.legalMoves(from).map((m) => m.path[1]);
  }

  hasAnyLegalMove(color) {
    return this.allLegalMoves(color).length > 0;
  }

  // ---- Move generation -----------------------------------------------------

  // Non-capturing single diagonal steps for a man or king.
  _stepsFrom(from, piece) {
    const [row, col] = rc(from);
    const dirs = piece.king ? ALL_DIRS : FWD[piece.color];
    const out = [];
    for (const [dr, dc] of dirs) {
      const r = row + dr, c = col + dc;
      if (!onBoard(r, c)) continue;
      const t = idx(r, c);
      if (this.board[t]) continue;
      const promote = !piece.king && this._isKingRow(piece.color, r);
      out.push({
        from, to: t, color: piece.color,
        captures: [], path: [from, t], isJump: false, promote,
      });
    }
    return out;
  }

  // All maximal jump sequences starting at `from`. Returns full move records
  // whose `from` is this origin square, `path` is [from, land1, land2, ...],
  // and `captures` lists every removed square in order. Recurses to chain
  // multi-jumps; honours the rule that reaching the king row ENDS the move (a
  // man that promotes mid-jump stops). `captured` accumulates removed squares
  // so a piece is never jumped twice within one chain. `origin` is threaded so
  // every record reports the true starting square; the moving piece has left
  // `origin`, so that square (and only that one) counts as empty for landings.
  _jumpsFrom(from, color, king, captured, origin = from) {
    const [row, col] = rc(from);
    const dirs = king ? ALL_DIRS : FWD[color];
    const results = [];

    for (const [dr, dc] of dirs) {
      const landR = row + 2 * dr, landC = col + 2 * dc;
      if (!onBoard(landR, landC)) continue;
      const mid = idx(row + dr, col + dc);
      const land = idx(landR, landC);
      const victim = this.board[mid];
      // Must jump an uncaptured enemy piece into an empty landing square
      // (`origin` counts as empty: the piece has conceptually left it).
      if (!victim || victim.color === color) continue;
      if (captured.includes(mid)) continue;
      if (this.board[land] && land !== origin) continue;

      const nowKing = king || this._isKingRow(color, landR);
      const promotedNow = nowKing && !king;
      const nextCaptured = [...captured, mid];

      // Reaching the king row ends the move (standard rule): no further jumps.
      const continuations = promotedNow
        ? []
        : this._jumpsFrom(land, color, nowKing, nextCaptured, origin);

      if (continuations.length) {
        for (const cont of continuations) {
          results.push({
            from: origin,
            to: cont.to,
            color,
            captures: [mid, ...cont.captures],
            path: [land, ...cont.path],
            isJump: true,
            promote: cont.promote,
          });
        }
      } else {
        // Leaf of this branch: report only the capture made at this step; the
        // parent levels prepend their own. (`captured` threads through purely
        // to forbid re-jumping a piece within the chain.)
        results.push({
          from: origin,
          to: land,
          color,
          captures: [mid],
          path: [land],
          isJump: true,
          promote: promotedNow,
        });
      }
    }
    return results;
  }

  _isKingRow(color, row) {
    return color === RED ? row === 0 : row === 7;
  }

  // ---- Move application ----------------------------------------------------

  /**
   * Apply a move. Callers may pass a full move record (from allLegalMoves /
   * legalMoves) or just (from, to) where `to` is the FINAL landing square; the
   * matching legal move is looked up. Returns the applied record, or null if
   * illegal. Switches the turn and recomputes the game-over verdict.
   */
  move(from, to) {
    let record;
    if (typeof from === "object" && from !== null) {
      record = from;
    } else {
      const moves = this.legalMoves(from);
      record = moves.find((m) => m.to === to) ||
               moves.find((m) => m.path[1] === to);
    }
    if (!record) return null;
    return this._apply(record);
  }

  _apply(m) {
    const piece = this.board[m.from];
    // Remove captured pieces.
    for (const cap of m.captures) this.board[cap] = null;
    // Move the piece to its final square.
    this.board[m.from] = null;
    const moved = { color: piece.color, king: piece.king || m.promote };
    this.board[m.to] = moved;

    this.lastMove = { from: m.from, to: m.to, path: m.path };
    this.history.push(m);
    this.turn = other(this.turn);

    // Verdict: the side now to move loses if it has no legal move.
    if (!this.hasAnyLegalMove(this.turn)) {
      this.gameOver = true;
      this.winner = other(this.turn);
    }
    return m;
  }
}
