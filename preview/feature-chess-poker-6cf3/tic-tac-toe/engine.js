// Tic-Tac-Toe engine — the pure game core. No DOM, no rendering, no input: it
// owns the 3×3 board, whose turn it is, and the win/draw verdict, and exposes a
// small command surface (place / winner / isDraw / reset). app.js drives it from
// the intent stream and renders its state.

// The eight winning lines as board-index triples (rows, columns, diagonals).
export const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // columns
  [0, 4, 8], [2, 4, 6],            // diagonals
];

export class Engine {
  constructor() {
    this.reset();
  }

  reset() {
    this.board = new Array(9).fill(null); // each cell is 'X', 'O', or null
    this.current = "X";                   // X always opens
  }

  // Drop the current player's mark on an empty cell, then switch turns. Returns
  // true if the move was legal (cell was empty and the game isn't decided yet).
  place(i) {
    if (this.board[i] !== null) return false;
    if (this.winner().player || this.isDraw()) return false;
    this.board[i] = this.current;
    this.current = this.current === "X" ? "O" : "X";
    return true;
  }

  // The verdict: { player, line }. player is 'X'/'O' on a win (with the winning
  // triple in line), otherwise null/null.
  winner() {
    for (const line of LINES) {
      const [a, b, c] = line;
      const v = this.board[a];
      if (v && v === this.board[b] && v === this.board[c]) {
        return { player: v, line };
      }
    }
    return { player: null, line: null };
  }

  // A draw is a full board with no winner.
  isDraw() {
    return this.board.every((c) => c !== null) && !this.winner().player;
  }
}
