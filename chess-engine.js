/**
 * Chess Engine - Shared logic for client and server
 * Extracted from the original Chess School game
 */

// Piece values
const V = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const NAME = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };

// Knight moves
const N8 = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
// Bishop directions
const D = [[-1,-1],[-1,1],[1,-1],[1,1]];
// Rook directions
const S = [[-1,0],[1,0],[0,-1],[0,1]];

const ok = (r, f) => r >= 0 && r < 8 && f >= 0 && f < 8;
const isW = p => p === p.toUpperCase();
const col = p => isW(p) ? 'w' : 'b';
const sqn = i => 'abcdefgh'[i & 7] + (8 - (i >> 3));

// Castling rights mapping
const CM = { 60: -4, 56: -3, 63: -2, 4: -13, 0: -9, 7: -5 };
const crm = q => CM[q] === undefined ? -1 : CM[q];

// Starting position
const START = [
  ...'rnbqkbnr',
  ...'pppppppp',
  ...Array(32).fill(null),
  ...'PPPPPPPP',
  ...'RNBQKBNR',
  15, -1  // castling rights, en passant square
];

/**
 * Generate pseudo-legal moves
 * @param {Array} b - Board array (66 elements)
 * @param {string} c - Color ('w' or 'b')
 * @param {number} at - Attack mode (1 = only attacks)
 * @returns {Array} Array of moves [from, to, promotion?]
 */
function pseudo(b, c, at = 0) {
  const out = [];
  const w = c === 'w';

  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || col(p) !== c) continue;

    const t = p.toLowerCase();
    const r = i >> 3;
    const f = i & 7;

    if (t === 'p') {
      const d = w ? -1 : 1;
      const r1 = r + d;
      const pr = r1 === (w ? 0 : 7);

      const add = (to) => {
        if (pr && !at) {
          for (const q of 'qrbn') out.push([i, to, q]);
        } else {
          out.push([i, to]);
        }
      };

      // Forward moves
      if (!at && ok(r1, f) && !b[r1 * 8 + f]) {
        add(r1 * 8 + f);
        // Double pawn push from starting rank
        if (r === (w ? 6 : 1) && !b[(r + 2 * d) * 8 + f]) {
          out.push([i, (r + 2 * d) * 8 + f]);
        }
      }

      // Captures and en passant
      for (const df of [-1, 1]) {
        const ff = f + df;
        if (ok(r1, ff)) {
          const to = r1 * 8 + ff;
          const q = b[to];
          if (at || (q && col(q) !== c)) {
            add(to);
          } else if (!q && to === b[65]) {
            out.push([i, to]); // en passant
          }
        }
      }
    } else if (t === 'n' || t === 'k') {
      const dirs = t === 'n' ? N8 : [...D, ...S];
      for (const [dr, df] of dirs) {
        const rr = r + dr;
        const ff = f + df;
        if (ok(rr, ff)) {
          const q = b[rr * 8 + ff];
          if (!q || col(q) !== c) {
            out.push([i, rr * 8 + ff]);
          }
        }
      }

      // Castling
      if (t === 'k' && !at && i === (w ? 60 : 4)) {
        const rs = b[64];
        const bk = w ? 1 : 4;
        const bq = w ? 2 : 8;
        const rk = w ? 'R' : 'r';

        if (rs & (bk | bq)) {
          // Check if king is in check
          const A = new Set(pseudo(b, w ? 'b' : 'w', 1).map(m => m[1]));
          if (!A.has(i)) {
            // Kingside
            if ((rs & bk) && b[i + 3] === rk && !b[i + 1] && !b[i + 2] && !A.has(i + 1) && !A.has(i + 2)) {
              out.push([i, i + 2]);
            }
            // Queenside
            if ((rs & bq) && b[i - 4] === rk && !b[i - 1] && !b[i - 2] && !b[i - 3] && !A.has(i - 1) && !A.has(i - 2)) {
              out.push([i, i - 2]);
            }
          }
        }
      }
    } else {
      const dirs = t === 'b' ? D : t === 'r' ? S : [...D, ...S];
      for (const [dr, df] of dirs) {
        let rr = r + dr;
        let ff = f + df;
        while (ok(rr, ff)) {
          const q = b[rr * 8 + ff];
          if (!q) {
            out.push([i, rr * 8 + ff]);
          } else {
            if (col(q) !== c) out.push([i, rr * 8 + ff]);
            break;
          }
          rr += dr;
          ff += df;
        }
      }
    }
  }
  return out;
}

/**
 * Make a move on the board
 * @param {Array} b - Board array
 * @param {Array} m - Move [from, to, promotion?]
 * @returns {Array} New board array
 */
function make(b, m) {
  const nb = b.slice();
  const f = m[0];
  const t = m[1];
  const p = nb[f];
  const w = isW(p);
  const ty = p.toLowerCase();
  let pr = m[2];
  let ep = -1;

  // Auto-promote to queen if not specified
  if (!pr && ty === 'p' && (t < 8 || t > 55)) pr = 'q';

  // En passant capture
  if (ty === 'p' && (t & 7) !== (f & 7) && !nb[t]) {
    nb[(f >> 3) * 8 + (t & 7)] = null;
  }

  // Castling
  if (ty === 'k' && Math.abs(t - f) === 2) {
    const r = f & 56;
    if (t > f) {
      nb[r + 5] = nb[r + 7];
      nb[r + 7] = null;
    } else {
      nb[r + 3] = nb[r];
      nb[r] = null;
    }
  }

  nb[t] = pr ? (w ? pr.toUpperCase() : pr) : p;
  nb[f] = null;

  // En passant square
  if (ty === 'p' && Math.abs(t - f) === 16) {
    const e = w ? 'p' : 'P';
    const a = t & 7;
    if ((a > 0 && nb[t - 1] === e) || (a < 7 && nb[t + 1] === e)) {
      ep = (f + t) / 2;
    }
  }

  nb[64] = b[64] & crm(f) & crm(t);
  nb[65] = ep;
  return nb;
}

/**
 * Check if king is in check
 * @param {Array} b - Board array
 * @param {string} c - Color to check
 * @returns {boolean}
 */
function chk(b, c) {
  const k = c === 'w' ? 'K' : 'k';
  return pseudo(b, c === 'w' ? 'b' : 'w', 1).some(m => b[m[1]] === k);
}

/**
 * Get all legal moves (filtering out moves that leave king in check)
 * @param {Array} b - Board array
 * @param {string} c - Color
 * @returns {Array} Legal moves
 */
function legalMoves(b, c) {
  return pseudo(b, c).filter(m => !chk(make(b, m), c));
}

/**
 * Capture value of a move
 */
function capv(b, m) {
  return b[m[1]] ? V[b[m[1]].toLowerCase()] : 0;
}

/**
 * Move ordering heuristic
 */
function mo(b, m) {
  return capv(b, m) + (m[2] === 'q' ? 800 : m[2] ? 100 : 0);
}

/**
 * Static evaluation
 */
function ev(b) {
  let s = 0;
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p) continue;
    const t = p.toLowerCase();
    const r = i >> 3;
    const f = i & 7;

    let v = V[t] + (t === 'k' ? 0 : (3.5 - Math.abs(3.5 - f)) * 4 + (3.5 - Math.abs(3.5 - r)) * 4);
    if (t === 'p') v += (isW(p) ? 6 - r : r - 1) * 6;
    s += isW(p) ? v : -v;
  }
  return s;
}

/**
 * Quiescence search
 */
function qs(b, c, a, be, d) {
  const st = ev(b);
  const w = c === 'w';

  if (w) {
    if (st >= be) return st;
    if (st > a) a = st;
  } else {
    if (st <= a) return st;
    if (st < be) be = st;
  }

  if (d <= 0) return st;

  const ms = pseudo(b, c).filter(m => b[m[1]] || m[2] === 'q').sort((x, y) => mo(b, y) - mo(b, x));
  let v = st;

  for (const m of ms) {
    const nb = make(b, m);
    if (chk(nb, c)) continue;
    const s = qs(nb, w ? 'b' : 'w', a, be, d - 1);
    if (w) {
      if (s > v) v = s;
      if (v > a) a = v;
    } else {
      if (s < v) v = s;
      if (v < be) be = v;
    }
    if (a >= be) break;
  }
  return v;
}

/**
 * Alpha-beta search
 */
function ab(b, c, d, a, be, ply) {
  if (d <= 0) {
    if (ply > 8 || !chk(b, c)) return qs(b, c, a, be, 3);
    d = 1;
  }

  const ms = legalMoves(b, c);
  if (!ms.length) {
    return chk(b, c) ? (c === 'w' ? -1e5 + ply : 1e5 - ply) : 0;
  }

  ms.sort((x, y) => mo(b, y) - mo(b, x));

  if (c === 'w') {
    let v = -Infinity;
    for (const m of ms) {
      v = Math.max(v, ab(make(b, m), 'b', d - 1, a, be, ply + 1));
      a = Math.max(a, v);
      if (a >= be) break;
    }
    return v;
  } else {
    let v = Infinity;
    for (const m of ms) {
      v = Math.min(v, ab(make(b, m), 'w', d - 1, a, be, ply + 1));
      be = Math.min(be, v);
      if (a >= be) break;
    }
    return v;
  }
}

/**
 * Find best move for a position
 * @param {Array} b - Board array
 * @param {string} c - Color to move
 * @param {number} d - Depth
 * @returns {Array|null} Best move
 */
function best(b, c, d) {
  const ms = legalMoves(b, c);
  let bm = null;
  let bv = c === 'w' ? -Infinity : Infinity;

  ms.sort((x, y) => mo(b, y) - mo(b, x));

  for (const m of ms) {
    const v = ab(make(b, m), c === 'w' ? 'b' : 'w', d - 1, -Infinity, Infinity, 1) +
      Math.random() * 2 + (c === 'w' ? 1 : -1) * ((b[m[1]] || m[2] === 'q') ? 3 : 0);
    if (c === 'w' ? v > bv : v < bv) {
      bv = v;
      bm = m;
    }
  }
  return bm;
}

/**
 * Easy computer move (beginner level)
 */
function easy(ms, b) {
  ms = ms.filter(m => !m[2] || m[2] === 'q');
  const cs = ms.filter(m => b[m[1]]);
  if (cs.length && Math.random() < 0.75) {
    const top = Math.max(...cs.map(m => capv(b, m)));
    const bs = cs.filter(m => capv(b, m) === top);
    return bs[Math.random() * bs.length | 0];
  }
  return ms[Math.random() * ms.length | 0];
}

/**
 * Check if side has enough material to checkmate
 */
function enough(b, c) {
  const ps = b.slice(0, 64).filter(x => x && col(x) === c && x.toLowerCase() !== 'k').map(x => x.toLowerCase());
  return ps.some(x => 'pqr'.includes(x)) || ps.length >= 2;
}

/**
 * Get captured square for a move
 */
function capSq(b, m) {
  const p = b[m[0]];
  return b[m[1]] ? m[1] : (p && p.toLowerCase() === 'p' && (m[1] & 7) !== (m[0] & 7))
    ? (m[0] >> 3) * 8 + (m[1] & 7)
    : -1;
}

/**
 * Format time for display
 */
function fmt(ms) {
  const s = Math.max(0, ms) / 1000;
  return s < 10 ? '0:0' + (Math.floor(s * 10) / 10).toFixed(1)
    : Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

/**
 * Check for draw conditions
 */
function checkDraw(b, side, hm, keys) {
  const k = b.map(x => x || '.').join('') + side;
  keys.push(k);

  const o = b.slice(0, 64).filter(x => x && x.toLowerCase() !== 'k');
  const why = !o.length || (o.length === 1 && /[nb]/i.test(o[0]))
    ? 'insufficient material: neither side can force checkmate'
    : hm >= 100
      ? 'the 50-move rule: no pawn move or capture in 50 moves each'
      : keys.filter(x => x === k).length >= 3
        ? 'threefold repetition'
        : '';

  return why ? { draw: true, reason: why, keys } : { draw: false, keys };
}

module.exports = {
  V, NAME, N8, D, S, START, ok, isW, col, sqn, CM, crm,
  pseudo, make, chk, legalMoves, capv, mo, ev, qs, ab, best, easy,
  enough, capSq, fmt, checkDraw
};