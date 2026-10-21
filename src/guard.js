// Static checks on model-generated code before it is ever executed.
// Generated tests may only import node:test, node:assert, and the module under test.
const ALLOWED_IMPORTS = new Set(['node:test', 'node:assert', 'node:assert/strict', '../src/cart.js']);
const FORBIDDEN = [
  /\brequire\s*\(/, /\bimport\s*\(/, /\bprocess\b/, /\bchild_process\b/, /\beval\s*\(/, /\bnew\s+Function\b/,
  /\bglobalThis\b/, /\bfetch\s*\(/, /\bWebSocket\b/, /\bDeno\b/, /\bBun\b/, /\bsetInterval\s*\(/,
];

export function checkTestCode(code) {
  const problems = [];
  if (typeof code !== 'string' || code.trim().length < 20) return ['test code is empty'];
  if (code.length > 20000) problems.push('test code too long');
  const imports = [...code.matchAll(/\bimport\s+[^'"]*?from\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const bare = [...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  for (const spec of [...imports, ...bare]) if (!ALLOWED_IMPORTS.has(spec)) problems.push(`import not allowed: ${spec}`);
  if (!imports.includes('../src/cart.js')) problems.push("test must import from '../src/cart.js'");
  if (!imports.some((s) => s === 'node:test')) problems.push("test must import { test } from 'node:test'");
  for (const re of FORBIDDEN) if (re.test(code)) problems.push(`forbidden construct: ${re.source}`);
  return problems;
}

// Patch edits: exact find/replace pairs against ONE allowed file.
export function applyEdits(source, edits) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('patch has no edits');
  if (edits.length > 6) throw new Error('patch too large (max 6 edits)');
  let out = source;
  for (const [i, e] of edits.entries()) {
    if (typeof e?.find !== 'string' || typeof e?.replace !== 'string' || !e.find) throw new Error(`edit ${i + 1} malformed`);
    const n = out.split(e.find).length - 1;
    if (n === 0) throw new Error(`edit ${i + 1}: "find" text not found in file`);
    if (n > 1) throw new Error(`edit ${i + 1}: "find" text matches ${n} places; must be unique`);
    out = out.replace(e.find, () => e.replace);
  }
  const problems = [];
  for (const re of FORBIDDEN) if (re.test(out) && !re.test(source)) problems.push(`patch introduces forbidden construct: ${re.source}`);
  if (problems.length) throw new Error(problems.join('; '));
  return out;
}

// Small models sometimes omit the boilerplate imports. Add the known-safe ones deterministically.
const CART_EXPORTS = ['COUPONS', 'createCart', 'subtotal', 'addItem', 'setQuantity', 'applyCoupon', 'total'];
export function normalizeTestCode(code) {
  if (typeof code !== 'string') return code;
  let c = code.replace(/^\s*```(?:js|javascript)?\s*\n?|```\s*$/g, '').trim() + '\n';
  const header = [];
  if (!/from\s+['"]node:test['"]/.test(c)) header.push("import { test } from 'node:test';");
  if (!/from\s+['"]node:assert(\/strict)?['"]/.test(c) && /\bassert\b/.test(c)) header.push("import assert from 'node:assert/strict';");
  if (!/from\s+['"]\.\.\/src\/cart\.js['"]/.test(c)) {
    const used = CART_EXPORTS.filter((n) => new RegExp(`\\b${n}\\b`).test(c));
    header.push(`import { ${(used.length ? used : CART_EXPORTS).join(', ')} } from '../src/cart.js';`);
  }
  return header.length ? header.join('\n') + '\n\n' + c : c;
}

// Whole-function patches: small models rewrite a full function far more reliably than exact find/replace.
// Replaces `export function NAME(...) { ... }` (brace-matched, string/comment aware) with the model's version.
function findFunction(source, name) {
  const re = new RegExp(`(^|\\n)(export\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(source);
  if (!m) return null;
  const start = m.index + (m[1] ? 1 : 0);
  let i = source.indexOf('{', source.indexOf(')', start)), depth = 0, q = null;
  for (; i < source.length; i++) {
    const ch = source[i], nx = source[i + 1];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '/' && nx === '/') { i = source.indexOf('\n', i); if (i < 0) return null; continue; }
    if (ch === '/' && nx === '*') { i = source.indexOf('*/', i) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return { start, end: i + 1 };
  }
  return null;
}

export function replaceFunctions(source, functions) {
  if (!Array.isArray(functions) || functions.length === 0) throw new Error('patch has no functions');
  if (functions.length > 4) throw new Error('patch too large (max 4 functions)');
  let out = source, changed = 0;
  for (const [i, f] of functions.entries()) {
    if (typeof f?.name !== 'string' || typeof f?.code !== 'string') throw new Error(`function ${i + 1} malformed`);
    const name = f.name.replace(/[^A-Za-z0-9_$]/g, '');
    let code = f.code.replace(/^\s*```(?:js|javascript)?\s*\n?|```\s*$/g, '').trim();
    const decl = new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`);
    if (!decl.test(code)) throw new Error(`function "${name}": code must be the complete function, starting with "export function ${name}("`);
    const loc = findFunction(out, name);
    if (!loc) throw new Error(`function "${name}" does not exist in src/cart.js (only existing functions can be changed)`);
    const own = findFunction(code, name);
    if (!own || code.slice(own.end).trim()) throw new Error(`function "${name}": code must contain exactly one complete function with balanced braces`);
    if (!/^export\b/.test(code) && /^export\b/.test(out.slice(loc.start))) code = 'export ' + code;
    if (out.slice(loc.start, loc.end).trim() === code.trim()) continue; // no-op
    out = out.slice(0, loc.start) + code + out.slice(loc.end);
    changed++;
  }
  if (!changed) throw new Error('patch changes nothing');
  for (const re of FORBIDDEN) if (re.test(out) && !re.test(source)) throw new Error(`patch introduces forbidden construct: ${re.source}`);
  return out;
}
