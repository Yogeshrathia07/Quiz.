import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A hand-drawn tic-tac-toe for the Server offline page (ServerOffline.jsx):
 * one player against the computer, or two taking turns on this device. Every
 * line is drawn here as a slightly wobbly stroke, so nothing is fetched - it
 * works with the server away.
 */

const WINS = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const rnd = (amount) => (Math.random() - 0.5) * amount;

/** A slightly wobbly line: one quadratic curve. */
function line(x1, y1, x2, y2, jitter = 3) {
  const mx = (x1 + x2) / 2 + rnd(jitter * 2);
  const my = (y1 + y2) / 2 + rnd(jitter * 2);
  return `M${x1 + rnd(jitter)} ${y1 + rnd(jitter)} Q${mx} ${my} ${x2 + rnd(jitter)} ${y2 + rnd(jitter)}`;
}

/** A hand-drawn line: points pushed a little sideways, joined by smooth curves. */
function rough(x1, y1, x2, y2, amp, seg) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len;
  const ny = dx / len;
  const pts = [];
  for (let k = 0; k <= seg; k += 1) {
    const t = k / seg;
    const off = k === 0 || k === seg ? rnd(amp) : rnd(amp * 2);
    pts.push([x1 + dx * t + nx * off, y1 + dy * t + ny * off]);
  }
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let k = 1; k < seg; k += 1) {
    const end = k < seg - 1 ? [(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2] : pts[seg];
    d += ` Q${pts[k][0]} ${pts[k][1]} ${end[0]} ${end[1]}`;
  }
  return d;
}

/** The four thick marker lines of the grid, with only a slight hand-drawn bend. */
const gridLines = () => [[100, -8, 100, 308], [200, -8, 200, 308], [-8, 100, 308, 100], [-8, 200, 308, 200]]
  .map(([x1, y1, x2, y2]) => ({ d: rough(x1 + rnd(8), y1 + rnd(12), x2 + rnd(8), y2 + rnd(12), 5, 4), width: 8 + Math.random() * 2.5 }));

/** An X (two strokes, the second a moment later) or an O (one loop, slightly tilted) in cell i. */
function markStrokes(i, player) {
  const cx = (i % 3) * 100 + 50 + rnd(6);
  const cy = Math.floor(i / 3) * 100 + 50 + rnd(6);
  if (player === 'X') {
    return [
      { d: line(cx - 24, cy - 26, cx + 24, cy + 26, 5), delay: 0 },
      { d: line(cx + 25, cy - 25, cx - 24, cy + 27, 5), delay: 0.25 }
    ];
  }
  const rx = 24 + rnd(4);
  const ry = 27 + rnd(4);
  const k = 0.552;
  const d = `M${cx} ${cy - ry} C${cx + rx * k} ${cy - ry} ${cx + rx} ${cy - ry * k} ${cx + rx} ${cy} S${cx + rx * k} ${cy + ry} ${cx} ${cy + ry} `
    + `S${cx - rx} ${cy + ry * k} ${cx - rx} ${cy} S${cx - rx * k} ${cy - ry} ${cx + 4 + rnd(3)} ${cy - ry + 2 + rnd(3)}`;
  return [{ d, delay: 0, transform: `rotate(${rnd(0.3) * 20} ${cx} ${cy})` }];
}

/**
 * The line through a win, drawn by hand: a little off the centres, a little
 * tilted, running past the end marks by uneven lengths, with a gentle wobble -
 * a different stroke every game.
 */
function strikeLine(win) {
  const centre = (i) => [(i % 3) * 100 + 50, Math.floor(i / 3) * 100 + 50];
  const [x1, y1] = centre(win[0]);
  const [x2, y2] = centre(win[2]);
  const len = Math.hypot(x2 - x1, y2 - y1);
  const [ux, uy] = [(x2 - x1) / len, (y2 - y1) / len];
  const [nx, ny] = [-uy, ux];
  const shift = rnd(16);
  const tilt = rnd(14);
  const before = 22 + Math.random() * 30;
  const after = 22 + Math.random() * 30;
  return rough(
    x1 - ux * before + nx * (shift + tilt), y1 - uy * before + ny * (shift + tilt),
    x2 + ux * after + nx * (shift - tilt), y2 + uy * after + ny * (shift - tilt), 4, 5
  );
}

const winnerOf = (board) => WINS.find(([a, b, c]) => board[a] && board[a] === board[b] && board[b] === board[c]) || null;
const freeCells = (board) => board.map((value, i) => (value ? null : i)).filter((i) => i !== null);

const otherMark = (mark) => (mark === 'X' ? 'O' : 'X');

/**
 * Minimax from `me`'s side: a win sooner scores more (10 less the moves to it),
 * a loss later less badly, a draw 0. Remembered per position, so the whole tree
 * is worked out once.
 */
const memo = new Map();
function minimax(board, player, me) {
  const key = `${board.map((value) => value || '.').join('')}${player}${me}`;
  if (memo.has(key)) return memo.get(key);
  const win = winnerOf(board);
  const free = freeCells(board);
  let score;
  if (win) score = (board[win[0]] === me ? 1 : -1) * (free.length + 1);
  else if (!free.length) score = 0;
  else {
    const scores = free.map((i) => {
      const next = board.slice();
      next[i] = player;
      return minimax(next, otherMark(player), me);
    });
    score = player === me ? Math.max(...scores) : Math.min(...scores);
  }
  memo.set(key, score);
  return score;
}

/** How many of the other player's replies to this position lose: a trap the more of them there are. */
function traps(board, me) {
  return freeCells(board).filter((i) => {
    const next = board.slice();
    next[i] = otherMark(me);
    return minimax(next, me, me) > 0;
  }).length;
}

// The computer opens in a corner - the opening a person most often answers wrongly.
const OPENINGS = [0, 2, 6, 8];
/**
 * The computer's move as `me` (X when it starts, O when you do): never a worse
 * result than the best there is, a win as soon as it can, and among equally
 * good moves the one that leaves the most ways for you to go wrong.
 */
function computerMove(board, opening, me) {
  const free = freeCells(board);
  if (free.length === 9) {
    const first = OPENINGS[Math.floor(Math.random() * OPENINGS.length)];
    return { move: first, opening: first };
  }
  const scored = free.map((i) => {
    const next = board.slice();
    next[i] = me;
    return { i, next, score: minimax(next, otherMark(me), me) };
  });
  const best = Math.max(...scored.map((entry) => entry.score));
  const safest = scored.filter((entry) => entry.score === best).map((entry) => ({ ...entry, traps: traps(entry.next, me) }));
  const most = Math.max(...safest.map((entry) => entry.traps));
  const pool = safest.filter((entry) => entry.traps === most).map((entry) => entry.i);
  return { move: pool[Math.floor(Math.random() * pool.length)], opening };
}

/** A new game: X starts against the computer (whoever plays X); two players choose who starts. `computer`: its mark, or null. */
const freshGame = (first, round, computer = null) => ({
  board: Array(9).fill(null), turn: first, computer, result: null, win: null, grid: gridLines(), marks: [], opening: null, round
});

/** The game after `player` plays cell i: the mark drawn, and a win or a draw when there is one. */
function placed(game, i) {
  const board = game.board.slice();
  board[i] = game.turn;
  const marks = [...game.marks, { i, strokes: markStrokes(i, game.turn) }];
  const win = winnerOf(board);
  if (win) return { ...game, board, marks, win: { cells: win, d: strikeLine(win) }, result: game.turn };
  if (board.every(Boolean)) return { ...game, board, marks, result: 'draw' };
  return { ...game, board, marks, turn: otherMark(game.turn) };
}

const CELL_NAMES = ['top left', 'top middle', 'top right', 'middle left', 'centre', 'middle right', 'bottom left', 'bottom middle', 'bottom right'];

export function TicTacToe({ onPlaying }) {
  const [vsComputer, setVsComputer] = useState(true);
  // Against the computer it starts, as X, unless you choose to; two players choose X or O to start.
  const [computerFirst, setComputerFirst] = useState(true);
  const [first, setFirst] = useState('X');
  const [game, setGame] = useState(() => freshGame('X', 0, 'X'));
  // Two players count wins by X and O; against the computer by who won, whichever mark each had.
  const [score, setScore] = useState({ X: 0, O: 0, you: 0, computer: 0, draw: 0 });
  const current = useRef(game);
  current.current = game;

  const commit = useCallback((next) => {
    current.current = next;
    setGame(next);
    if (!next.result) return;
    const winner = next.result === 'draw' || !next.computer ? next.result : next.result === next.computer ? 'computer' : 'you';
    setScore((tally) => ({ ...tally, [winner]: tally[winner] + 1 }));
  }, []);
  const startGame = useCallback((computer, cpuFirst, starts) => commit(computer
    ? freshGame('X', current.current.round + 1, cpuFirst ? 'X' : 'O')
    : freshGame(starts, current.current.round + 1)), [commit]);
  const newGame = () => startGame(vsComputer, computerFirst, first);
  const play = (i) => {
    const now = current.current;
    if (now.result || now.board[i] || now.turn === now.computer) return;
    commit(placed(now, i));
  };

  // The computer's turn, after a short think.
  useEffect(() => {
    if (!game.computer || game.turn !== game.computer || game.result) return undefined;
    const timer = window.setTimeout(() => {
      const now = current.current;
      if (now.turn !== now.computer || now.result) return;
      const { move, opening } = computerMove(now.board, now.opening, now.computer);
      commit(placed({ ...now, opening }, move));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [game, commit]);
  // A game under way: the page waits for it to finish before opening (ServerOffline.jsx).
  useEffect(() => { onPlaying?.(game.marks.length > 0 && !game.result); }, [game, onPlaying]);
  useEffect(() => () => onPlaying?.(false), [onPlaying]);

  const chooseMode = (computer) => {
    setVsComputer(computer);
    setScore({ X: 0, O: 0, you: 0, computer: 0, draw: 0 });
    startGame(computer, computerFirst, first);
  };
  const chooseFirst = (choice) => {
    if (vsComputer) { setComputerFirst(choice === 'computer'); startGame(true, choice === 'computer', first); return; }
    setFirst(choice);
    startGame(false, computerFirst, choice);
  };
  const status = game.result === 'draw' ? 'It’s a draw.'
    : game.result && game.computer ? (game.result === game.computer ? 'Computer wins!' : 'You win!')
      : game.result ? `${game.result} wins!`
      : !vsComputer ? `${game.turn}’s turn`
        : game.turn === game.computer ? 'Thinking…' : `Your turn (${game.turn})`;

  return (
    <section className="ttt" aria-label="Tic-tac-toe">
      <div className="ttt-options">
        <div className="ttt-pick" role="group" aria-label="Mode">
          <span aria-hidden="true">Mode:</span>
          <button type="button" aria-pressed={vsComputer} onClick={() => chooseMode(true)}>1 player</button>
          <button type="button" aria-pressed={!vsComputer} onClick={() => chooseMode(false)}>2 players</button>
        </div>
        <div className="ttt-pick" role="group" aria-label="Who starts">
          <span aria-hidden="true">Who starts?</span>
          {vsComputer ? <>
            <button type="button" aria-pressed={!computerFirst} onClick={() => chooseFirst('you')}>You</button>
            <button type="button" aria-pressed={computerFirst} onClick={() => chooseFirst('computer')}>Computer</button>
          </> : <>
            <button type="button" aria-pressed={first === 'X'} onClick={() => chooseFirst('X')}>X</button>
            <button type="button" aria-pressed={first === 'O'} onClick={() => chooseFirst('O')}>O</button>
          </>}
        </div>
        <button type="button" className="ttt-new" onClick={() => newGame()}>New game</button>
      </div>
      <div className="ttt-play">
        <p className="ttt-status" role="status" aria-live="polite">{status}</p>
        <div className="ttt-board">
          <svg key={game.round} viewBox="0 0 300 300" role="group" aria-label="Board">
            {game.grid.map((stroke, at) => (
              <path key={`g${at}`} className="ttt-stroke ttt-draw" d={stroke.d} strokeWidth={stroke.width} pathLength="1"/>
            ))}
            {game.marks.map((mark) => mark.strokes.map((stroke, at) => (
              <path key={`m${mark.i}-${at}`} className="ttt-stroke ttt-draw" d={stroke.d} strokeWidth="8" pathLength="1"
                transform={stroke.transform} style={stroke.delay ? { animationDelay: `${stroke.delay}s` } : undefined}/>
            )))}
            {game.win && <path className="ttt-stroke ttt-draw ttt-strike" d={game.win.d} strokeWidth="12" pathLength="1"/>}
            {game.board.map((value, i) => {
              const closed = Boolean(value || game.result || game.turn === game.computer);
              return (
                <rect key={`c${i}`} className="ttt-cell" x={(i % 3) * 100} y={Math.floor(i / 3) * 100} width="100" height="100"
                  role="button" tabIndex={0} aria-disabled={closed} aria-label={`${CELL_NAMES[i]}: ${value || 'empty'}`}
                  onMouseDown={(event) => event.preventDefault()} onClick={() => play(i)}
                  onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); play(i); } }}/>
              );
            })}
          </svg>
        </div>
        <p className="ttt-score">
          {vsComputer ? <><span>You: {score.you}</span><span>Computer: {score.computer}</span></>
            : <><span>X: {score.X}</span><span>O: {score.O}</span></>}
          <span>Draws: {score.draw}</span>
        </p>
      </div>
    </section>
  );
}
