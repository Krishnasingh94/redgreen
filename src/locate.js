// Deterministic code search: rank repo source files by how strongly they match the issue text.
// Shown to the user as "Files Gemma will read" so the model's view of the repo is transparent.
import fs from 'node:fs';
import path from 'node:path';

const SRC_EXT = /\.(m?js|cjs|jsx|ts|tsx)$/;
const SKIP = /(^|\/)(node_modules|dist|build|coverage|\.git|vendor|examples?|docs?|benchmarks?|fixtures?)\//;
const TESTY = /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;
const STOP = new Set('this that with from when then have been should would could there their what which where expected actual returns return error issue bug function value values undefined null true false using used does into also after before while because only just like some more than other about would works working work fails failing broken wrong correct instead'.split(' '));

export const WEB_EXT = /\.(html?|css|m?js|cjs|jsx|ts|tsx|vue|svelte)$/;
export function listFiles(dir, exts = SRC_EXT) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (!SKIP.test(r + '/') && !e.name.startsWith('.')) walk(path.join(d, e.name), r); }
      else if (exts.test(e.name) && !e.name.endsWith('.d.ts') && !e.name.endsWith('.min.js')) out.push(r);
    }
  })(dir, '');
  return out;
}

export function issueTerms(text) {
  const t = String(text);
  const idents = [...t.matchAll(/`([^`]{2,60})`|\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(|\b([a-z]+[A-Z][\w$]*|[A-Z][a-z]+[A-Z][\w$]*|[a-z]+_[a-z_]+)\b/g)]
    .flatMap((m) => (m[1] || m[2] || m[3] || '').split(/[^\w$]+/)).filter((w) => w.length >= 3);
  const paths = [...t.matchAll(/([\w./-]+\.[cm]?[jt]sx?)(?::\d+)?/g)].map((m) => m[1].replace(/^\.?\//, ''));
  const words = (t.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || []).filter((w) => !STOP.has(w));
  return { idents: [...new Set(idents)], paths: [...new Set(paths)], words: [...new Set(words)] };
}

export function rankFiles(dir, issueText, limit = 4, exts = SRC_EXT) {
  const terms = issueTerms(issueText);
  const files = listFiles(dir, exts);
  const scored = [];
  for (const f of files) {
    let src; try { src = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (src.length > 400000) continue;
    const isTest = TESTY.test(f);
    let score = 0; const hits = new Set();
    for (const p of terms.paths) if (f.endsWith(p) || p.endsWith(f)) { score += 40; hits.add(p); }
    for (const id of terms.idents) {
      const re = new RegExp(`\\b${id.replace(/[$]/g, '\\$')}\\b`, 'g');
      const n = Math.min((src.match(re) || []).length, 5);
      if (n) { score += 6 * n + (new RegExp(`(function\\s+|const\\s+|let\\s+|\\b)${id.replace(/[$]/g, '\\$')}\\s*(=|\\()`).test(src) ? 10 : 0); hits.add(id); }
      if (path.basename(f).toLowerCase().includes(id.toLowerCase())) { score += 12; hits.add(id); }
    }
    const low = src.toLowerCase();
    for (const w of terms.words) { const n = Math.min(low.split(w).length - 1, 3); if (n) { score += n; if (n > 1) hits.add(w); } }
    if (!score) continue;
    score = score / (1 + Math.log10(Math.max(1, src.split('\n').length / 80))); // don't let huge files win by volume
    if (isTest) score *= 0.35;
    scored.push({ path: f, score: Math.round(score * 10) / 10, terms: [...hits].slice(0, 8), lines: src.split('\n').length, isTest });
  }
  scored.sort((a, b) => b.score - a.score);
  const source = scored.filter((s) => !s.isTest).slice(0, limit);
  const tests = scored.filter((s) => s.isTest).slice(0, 1);
  return { source, tests, terms };
}

// Excerpt a file for the prompt: whole file if small, otherwise windows around matching lines.
export function excerpt(dir, rel, terms, maxLines = 220) {
  const lines = fs.readFileSync(path.join(dir, rel), 'utf8').split('\n');
  if (lines.length <= maxLines) return lines.join('\n');
  const keep = new Set();
  const needles = terms.map((t) => t.toLowerCase());
  lines.forEach((l, i) => { const low = l.toLowerCase(); if (needles.some((n) => low.includes(n))) for (let k = i - 25; k <= i + 35; k++) if (k >= 0 && k < lines.length) keep.add(k); });
  const idx = [...keep].sort((a, b) => a - b).slice(0, maxLines);
  let out = '', prev = -2;
  for (const i of idx) { if (i !== prev + 1) out += '// ... (lines omitted) ...\n'; out += lines[i] + '\n'; prev = i; }
  return out || lines.slice(0, maxLines).join('\n');
}
