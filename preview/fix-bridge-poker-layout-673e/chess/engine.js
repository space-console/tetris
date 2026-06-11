// Chess engine — the pure game core. No DOM, no rendering, no input: it owns the
// 8×8 board, side to move, move history, full legal-move generation (including
// en passant, castling, and promotion), and the check / checkmate / stalemate
// verdict. app.js drives it from the intent stream and renders its state.
//
// Board model: a flat 64-length array indexed 0..63, rank 8 (Black's back rank)
// at the top (index 0..7) down to rank 1 (White's back rank) at index 56..63.
// File a..h maps left→right. So index = row * 8 + col, where row 0 is rank 8.
// A square is `null` (empty) or a piece object { type, color }:
//   type ∈ { p, n, b, r, q, k }   color ∈ { w, b }.

export const WHITE = "w";
export const BLACK = "b";

// Starting layout, one character per square, FEN-style (uppercase = White).
const START = [
  "r", "n", "b", "q", "k", "b", "n", "r",
  "p", "p", "p", "p", "p", "p", "p", "p",
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  null, null, null, null, null, null, null, null,
  "P", "P", "P", "P", "P", "P", "P", "P",
  "R", "N", "B", "Q", "K", "B", "N", "R",
];

// ---- Square helpers -------------------------------------------------------
export function rc(index) { return [Math.floor(index / 8), index % 8]; }
export function idx(row, col) { return row * 8 + col; }
function onBoard(row, col) { return row >= 0 && row < 8 && col >= 0 && col < 8; }

/** Algebraic name ("e4") ↔ index, handy for tests and UI. */
export function squareName(index) {
  const [row, col] = rc(index);
  return "abcdefgh"[col] + (8 - row);
}
export function nameToIndex(name) {
  const col = "abcdefgh".indexOf(name[0]);
  const row = 8 - Number(name[1]);
  return idx(row, col);
}

// Build a piece object from a START character.
function pieceFromChar(ch) {
  if (!ch) return null;
  const color = ch === ch.toUpperCase() ? WHITE : BLACK;
  return { type: ch.toLowerCase(), color };
}

// Knight and king relative offsets (row, col).
const KNIGHT_DELTAS = [
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
];
const KING_DELTAS = [
  [-1, -1], [-1, 0], [-1, 1], [0, -1],
  [0, 1], [1, -1], [1, 0], [1, 1],
];
// Sliding directions per piece.
const BISHOP_DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const ROOK_DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];

export class Engine {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = START.map(pieceFromChar);
    this.turn = WHITE;                 // White moves first
    this.history = [];                 // list of applied move records
    // Castling rights — set false once a king or its rook moves/captured.
    this.castling = { wK: true, wQ: true, bK: true, bQ: true };
    // En-passant target square index (the empty square a pawn skipped over) or
    // null. Only valid for the single move immediately after a double push.
    this.enPassant = null;
    this.lastMove = null;              // { from, to } for highlighting
    this.gameOver = false;
    this.winner = null;                // 'w' | 'b' on checkmate, null otherwise
  }

  // ---- Queries ------------------------------------------------------------

  pieceAt(index) { return this.board[index]; }

  /** Side-to-move status: { turn, inCheck, checkmate, stalemate, winner }. */
  status() {
    const inCheck = this.inCheck(this.turn);
    const hasMove = this.hasAnyLegalMove(this.turn);
    return {
      turn: this.turn,
      inCheck,
      checkmate: inCheck && !hasMove,
      stalemate: !inCheck && !hasMove,
      winner: this.winner,
    };
  }

  /**
   * Legal moves for the piece on `from`, as an array of move records:
   *   { from, to, piece, capture?, flags }
   * where flags is a subset of { enpassant, castleK, castleQ, double, promote }.
   * Promotions appear once per target (default promo = queen); the chosen piece
   * is supplied at move() time. Returns [] if the square is empty or not the
   * side to move.
   */
  legalMoves(from) {
    const piece = this.board[from];
    if (!piece || piece.color !== this.turn) return [];
    return this._pseudoMoves(from).filter((m) => !this._leavesKingInCheck(m));
  }

  /** Convenience: just the destination indexes for `from`. */
  legalTargets(from) {
    return this.legalMoves(from).map((m) => m.to);
  }

  // All legal moves for a color (used by the AI and verdict).
  allLegalMoves(color = this.turn) {
    const moves = [];
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.color === color) {
        for (const m of this._pseudoMoves(i)) {
          if (!this._leavesKingInCheck(m)) moves.push(m);
        }
      }
    }
    return moves;
  }

  hasAnyLegalMove(color) {
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.color === color) {
        for (const m of this._pseudoMoves(i)) {
          if (!this._leavesKingInCheck(m)) return true;
        }
      }
    }
    return false;
  }

  inCheck(color) {
    const king = this._findKing(color);
    if (king < 0) return false;
    return this._squareAttacked(king, color === WHITE ? BLACK : WHITE);
  }

  // ---- Move application ----------------------------------------------------

  /**
   * Apply the move from→to. `promo` (one of n/b/r/q) selects the promotion
   * piece when a pawn reaches the last rank; defaults to queen. Returns the
   * applied move record, or null if the move is illegal. Switches the turn and
   * recomputes the game-over verdict.
   */
  move(from, to, promo = "q") {
    const candidates = this.legalMoves(from);
    // For a promotion several candidates share the same destination (one per
    // promotion piece); pick the one matching `promo`. Otherwise just match `to`.
    const m = candidates.find((c) => c.to === to && c.flags.promote === promo) ||
              candidates.find((c) => c.to === to);
    if (!m) return null;
    const applied = this._apply(m, promo);
    // Recompute verdict for the side now to move.
    const st = this.status();
    if (st.checkmate) {
      this.gameOver = true;
      this.winner = applied.piece.color; // the side that just moved
    } else if (st.stalemate) {
      this.gameOver = true;
      this.winner = null;
    }
    return applied;
  }

  // ---- Internals -----------------------------------------------------------

  _findKing(color) {
    for (let i = 0; i < 64; i++) {
      const p = this.board[i];
      if (p && p.type === "k" && p.color === color) return i;
    }
    return -1;
  }

  // True if `square` is attacked by any piece of `byColor`. Pawn attacks use the
  // capture diagonals only (not pushes), matching real check geometry.
  _squareAttacked(square, byColor) {
    const [row, col] = rc(square);

    // Pawn attacks: a `byColor` pawn attacks `square` if it sits one rank toward
    // its own side on an adjacent file. White pawns attack upward (row-1).
    const pawnRow = byColor === WHITE ? row + 1 : row - 1;
    for (const dc of [-1, 1]) {
      const pc = col + dc;
      if (onBoard(pawnRow, pc)) {
        const p = this.board[idx(pawnRow, pc)];
        if (p && p.color === byColor && p.type === "p") return true;
      }
    }

    // Knight attacks.
    for (const [dr, dc] of KNIGHT_DELTAS) {
      const r = row + dr, c = col + dc;
      if (onBoard(r, c)) {
        const p = this.board[idx(r, c)];
        if (p && p.color === byColor && p.type === "n") return true;
      }
    }

    // King adjacency.
    for (const [dr, dc] of KING_DELTAS) {
      const r = row + dr, c = col + dc;
      if (onBoard(r, c)) {
        const p = this.board[idx(r, c)];
        if (p && p.color === byColor && p.type === "k") return true;
      }
    }

    // Sliding: bishops/queens on diagonals, rooks/queens on ranks/files.
    if (this._slideAttack(row, col, BISHOP_DIRS, byColor, ["b", "q"])) return true;
    if (this._slideAttack(row, col, ROOK_DIRS, byColor, ["r", "q"])) return true;

    return false;
  }

  _slideAttack(row, col, dirs, byColor, types) {
    for (const [dr, dc] of dirs) {
      let r = row + dr, c = col + dc;
      while (onBoard(r, c)) {
        const p = this.board[idx(r, c)];
        if (p) {
          if (p.color === byColor && types.includes(p.type)) return true;
          break; // blocked by any piece
        }
        r += dr; c += dc;
      }
    }
    return false;
  }

  // Pseudo-legal moves for the piece on `from` (geometry + special moves, but
  // NOT yet filtered for leaving one's own king in check).
  _pseudoMoves(from) {
    const piece = this.board[from];
    if (!piece) return [];
    switch (piece.type) {
      case "p": return this._pawnMoves(from, piece);
      case "n": return this._stepMoves(from, piece, KNIGHT_DELTAS);
      case "k": return this._kingMoves(from, piece);
      case "b": return this._slideMoves(from, piece, BISHOP_DIRS);
      case "r": return this._slideMoves(from, piece, ROOK_DIRS);
      case "q": return this._slideMoves(from, piece, [...BISHOP_DIRS, ...ROOK_DIRS]);
      default: return [];
    }
  }

  _mk(from, to, piece, extra = {}) {
    const target = this.board[to];
    return {
      from, to, piece,
      capture: target ? to : null,
      flags: {}, ...extra,
    };
  }

  // Single-step movers (knight, and the non-special king steps).
  _stepMoves(from, piece, deltas) {
    const [row, col] = rc(from);
    const out = [];
    for (const [dr, dc] of deltas) {
      const r = row + dr, c = col + dc;
      if (!onBoard(r, c)) continue;
      const t = idx(r, c);
      const occ = this.board[t];
      if (!occ || occ.color !== piece.color) out.push(this._mk(from, t, piece));
    }
    return out;
  }

  _slideMoves(from, piece, dirs) {
    const [row, col] = rc(from);
    const out = [];
    for (const [dr, dc] of dirs) {
      let r = row + dr, c = col + dc;
      while (onBoard(r, c)) {
        const t = idx(r, c);
        const occ = this.board[t];
        if (!occ) {
          out.push(this._mk(from, t, piece));
        } else {
          if (occ.color !== piece.color) out.push(this._mk(from, t, piece));
          break;
        }
        r += dr; c += dc;
      }
    }
    return out;
  }

  _pawnMoves(from, piece) {
    const [row, col] = rc(from);
    const out = [];
    const dir = piece.color === WHITE ? -1 : 1;        // White advances upward
    const startRow = piece.color === WHITE ? 6 : 1;
    const lastRow = piece.color === WHITE ? 0 : 7;

    // Single push.
    const r1 = row + dir;
    if (onBoard(r1, col) && !this.board[idx(r1, col)]) {
      this._pushPawn(out, from, idx(r1, col), piece, r1 === lastRow, {});
      // Double push from the starting rank (both squares empty).
      const r2 = row + 2 * dir;
      if (row === startRow && !this.board[idx(r2, col)]) {
        out.push(this._mk(from, idx(r2, col), piece, { flags: { double: true } }));
      }
    }

    // Captures (including en passant).
    for (const dc of [-1, 1]) {
      const c = col + dc;
      if (!onBoard(r1, c)) continue;
      const t = idx(r1, c);
      const occ = this.board[t];
      if (occ && occ.color !== piece.color) {
        this._pushPawn(out, from, t, piece, r1 === lastRow, {});
      } else if (!occ && this.enPassant === t) {
        // En passant: capture the pawn that sits beside us on `from`'s rank.
        out.push(this._mk(from, t, piece, {
          capture: idx(row, c),
          flags: { enpassant: true },
        }));
      }
    }
    return out;
  }

  // Push a pawn move, expanding to four promotion records on the last rank.
  _pushPawn(out, from, to, piece, promoting, extra) {
    if (promoting) {
      for (const promo of ["q", "r", "b", "n"]) {
        out.push(this._mk(from, to, piece, { flags: { promote: promo }, ...extra }));
      }
    } else {
      out.push(this._mk(from, to, piece, extra));
    }
  }

  _kingMoves(from, piece) {
    const out = this._stepMoves(from, piece, KING_DELTAS);
    // Castling: king & rook unmoved, squares between empty, king not in check,
    // and the king neither passes through nor lands on an attacked square.
    const [row, col] = rc(from);
    const enemy = piece.color === WHITE ? BLACK : WHITE;
    const rights = piece.color === WHITE
      ? { k: this.castling.wK, q: this.castling.wQ }
      : { k: this.castling.bK, q: this.castling.bQ };
    // Only generate castling from the king's home square (e1/e8). Guards against
    // bogus rights flags and keeps the col±2 indexing on the board.
    const homeRow = piece.color === WHITE ? 7 : 0;
    if ((rights.k || rights.q) && row === homeRow && col === 4) {
      if (this._squareAttacked(from, enemy)) return out; // can't castle out of check
      // King-side: squares f,g empty; king crosses f and lands on g.
      if (rights.k &&
          !this.board[idx(row, col + 1)] && !this.board[idx(row, col + 2)] &&
          !this._squareAttacked(idx(row, col + 1), enemy) &&
          !this._squareAttacked(idx(row, col + 2), enemy)) {
        out.push(this._mk(from, idx(row, col + 2), piece, { flags: { castleK: true } }));
      }
      // Queen-side: squares b,c,d empty; king crosses d and lands on c.
      if (rights.q &&
          !this.board[idx(row, col - 1)] && !this.board[idx(row, col - 2)] &&
          !this.board[idx(row, col - 3)] &&
          !this._squareAttacked(idx(row, col - 1), enemy) &&
          !this._squareAttacked(idx(row, col - 2), enemy)) {
        out.push(this._mk(from, idx(row, col - 2), piece, { flags: { castleQ: true } }));
      }
    }
    return out;
  }

  // Would playing `m` leave the mover's own king in check? Apply on a cloned
  // board state, test, and discard — keeps move generation side-effect free.
  _leavesKingInCheck(m) {
    const snapshot = this._snapshot();
    this._apply(m, m.flags.promote || "q", true);
    const bad = this.inCheck(m.piece.color);
    this._restore(snapshot);
    return bad;
  }

  _snapshot() {
    return {
      board: this.board.slice(),
      turn: this.turn,
      castling: { ...this.castling },
      enPassant: this.enPassant,
      lastMove: this.lastMove,
      historyLen: this.history.length,
    };
  }

  _restore(s) {
    this.board = s.board;
    this.turn = s.turn;
    this.castling = s.castling;
    this.enPassant = s.enPassant;
    this.lastMove = s.lastMove;
    this.history.length = s.historyLen;
  }

  // Mutate the board to play `m`. When `trial` is true we skip history bookkeeping
  // (used by the legality check); otherwise we record the move and flip the turn.
  _apply(m, promo, trial = false) {
    const piece = m.piece;
    const [, fromCol] = rc(m.from);
    const [toRow, toCol] = rc(m.to);

    // Remove a captured piece (en passant captures off the destination square).
    if (m.capture !== null && m.capture !== undefined) {
      this.board[m.capture] = null;
    }

    // Move the piece.
    this.board[m.to] = piece;
    this.board[m.from] = null;

    // Promotion: swap in the chosen piece type.
    if (m.flags.promote) {
      this.board[m.to] = { type: typeof m.flags.promote === "string" ? m.flags.promote : promo, color: piece.color };
    }

    // Castling: also hop the rook over the king.
    if (m.flags.castleK) {
      const rookFrom = idx(toRow, 7), rookTo = idx(toRow, toCol - 1);
      this.board[rookTo] = this.board[rookFrom];
      this.board[rookFrom] = null;
    } else if (m.flags.castleQ) {
      const rookFrom = idx(toRow, 0), rookTo = idx(toRow, toCol + 1);
      this.board[rookTo] = this.board[rookFrom];
      this.board[rookFrom] = null;
    }

    // Update castling rights when a king or rook leaves its home square, or a
    // rook is captured on its home square.
    if (piece.type === "k") {
      if (piece.color === WHITE) { this.castling.wK = false; this.castling.wQ = false; }
      else { this.castling.bK = false; this.castling.bQ = false; }
    }
    this._touchRookRights(m.from, fromCol);
    this._touchRookRights(m.to, toCol); // a capture on a rook's home square

    // Set / clear the en-passant target (only after a double pawn push).
    this.enPassant = m.flags.double
      ? idx((toRow + (piece.color === WHITE ? 1 : -1)), toCol)
      : null;

    if (!trial) {
      this.lastMove = { from: m.from, to: m.to };
      this.history.push(m);
      this.turn = this.turn === WHITE ? BLACK : WHITE;
    }
    return m;
  }

  // Clear the relevant rook castling right if `index` is a rook home square.
  _touchRookRights(index) {
    switch (index) {
      case 56: this.castling.wQ = false; break; // a1
      case 63: this.castling.wK = false; break; // h1
      case 0: this.castling.bQ = false; break;  // a8
      case 7: this.castling.bK = false; break;  // h8
    }
  }
}
