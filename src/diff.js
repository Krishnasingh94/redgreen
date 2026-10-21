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

// ---- git-applicable unified diff (real @@ -a,b +c,d @@ headers, "\ No newline at end of file").
const NONL = '\u0000NONL';
function splitLines(s) {
  if (s === '') return [];
  const L = s.split('\n');
  if (s.endsWith('\n')) L.pop(); else L[L.length - 1] += NONL; // a missing final newline makes the last line differ
  return L;
}
const show = (prefix, line) => line.endsWith(NONL) ? `${prefix}${line.slice(0, -NONL.length)}\n\\ No newline at end of file` : prefix + line;

export function unifiedDiff(a, b, file, context = 3) {
  const A = splitLines(a), B = splitLines(b), n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; // [type, line, oldIndex, newIndex] (indices = position before this op)
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) ops.push([' ', A[i], i++, j++]);
    else if (j >= m || (i < n && dp[i + 1][j] >= dp[i][j + 1])) ops.push(['-', A[i], i++, j]);
    else ops.push(['+', B[j], i, j++]);
  }
  const changed = ops.map((o, k) => o[0] !== ' ' ? k : -1).filter((k) => k >= 0);
  if (!changed.length) return '';
  const hunks = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context), hi = Math.min(ops.length - 1, k + context);
    const last = hunks.at(-1);
    if (last && lo <= last.hi + 1) last.hi = Math.max(last.hi, hi); else hunks.push({ lo, hi });
  }
  const out = [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`];
  for (const { lo, hi } of hunks) {
    const slice = ops.slice(lo, hi + 1);
    const oc = slice.filter((o) => o[0] !== '+').length, nc = slice.filter((o) => o[0] !== '-').length;
    const os = oc ? slice[0][2] + 1 : slice[0][2], ns = nc ? slice[0][3] + 1 : slice[0][3];
    out.push(`@@ -${os},${oc} +${ns},${nc} @@`, ...slice.map(([t, l]) => show(t, l)));
  }
  return out.join('\n') + '\n';
}

export function newFileDiff(content, file) {
  const L = splitLines(content);
  return [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${L.length} @@`, ...L.map((l) => show('+', l))].join('\n') + '\n';
}

// Patch a maintainer can `git apply` from the repo root: the verified source change + the repro test as a new file.
export function buildPatch({ source, patched, testCode, sourcePath = 'fixtures/shop/src/cart.js', testPath = 'fixtures/shop/test/repro.test.js' }) {
  return unifiedDiff(source, patched, sourcePath) + newFileDiff(testCode, testPath);
}
