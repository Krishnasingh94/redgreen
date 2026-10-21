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
