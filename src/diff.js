// Minimal line diff (LCS) -> unified-style hunks. Fine for small files.
export function lineDiff(a, b, file = 'src/cart.js') {
  const A = a.split('\n'), B = b.split('\n');
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', A[i++]]);
    else ops.push(['+', B[j++]]);
  }
  while (i < n) ops.push(['-', A[i++]]);
  while (j < m) ops.push(['+', B[j++]]);
  // keep 3 lines of context around changes
  const keep = new Array(ops.length).fill(false);
  ops.forEach(([t], k) => { if (t !== ' ') for (let d = -3; d <= 3; d++) if (ops[k + d]) keep[k + d] = true; });
  const lines = [`--- a/${file}`, `+++ b/${file}`];
  let gap = false;
  ops.forEach(([t, l], k) => { if (keep[k]) { if (gap) lines.push('@@ … @@'); gap = false; lines.push(t + l); } else gap = true; });
  return lines.join('\n');
}
