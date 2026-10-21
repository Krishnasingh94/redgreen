// Runner adapters, test-file safety checks, and patch application for GitHub mode.
import fs from 'node:fs';
import path from 'node:path';
import { run, npmCli } from './github.js';
import { permissionArgs } from './sandbox.js';

export function reproTestPath(project) {
  const ext = project.runner === 'jest' && !project.esm ? '.test.js' : project.runner === 'jest' ? '.test.js' : project.runner === 'vitest' ? '.test.js' : '.test.mjs';
  return `${project.testDir}/redgreen-repro${ext}`;
}

export function frameworkHint(project) {
  switch (project.runner) {
    case 'vitest': return "Use Vitest: import { test, expect } from 'vitest'; ESM imports.";
    case 'jest': return project.esm ? "Use Jest globals (test, expect) and ESM imports." : "Use Jest globals (test, expect, no import needed) and CommonJS require().";
    case 'mocha': return "Use Mocha globals (describe/it) and import assert from 'node:assert/strict'; ESM imports (file is .mjs).";
    default: return "Use import { test } from 'node:test'; import assert from 'node:assert/strict'; ESM imports (file is .mjs).";
  }
}

const bin = (dir, ...p) => path.join(dir, 'node_modules', ...p);
function firstExisting(...ps) { return ps.find((p) => fs.existsSync(p)); }

const ENV = () => ({ ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: process.env.TEMP, TMP: process.env.TMP, APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA, USERPROFILE: process.env.USERPROFILE, ComSpec: process.env.ComSpec } : { PATH: process.env.PATH, HOME: process.env.HOME }), CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', NODE_ENV: 'test' });

// Run ONE test file with the repo's runner. No shell; timeout; minimal env.
export async function runOne(givenDir, project, rel, timeoutMs = 60000) {
  const dir = fs.realpathSync.native(givenDir); // real path for cwd + permission flags (Windows short 8.3 temp paths)
  let args;
  switch (project.runner) {
    case 'vitest': { const v = firstExisting(bin(dir, 'vitest', 'vitest.mjs')); if (!v) throw new Error('vitest is not installed in the repo'); args = [v, 'run', rel]; break; }
    case 'jest': { const j = firstExisting(bin(dir, 'jest', 'bin', 'jest.js'), bin(dir, 'jest-cli', 'bin', 'jest.js')); if (!j) throw new Error('jest is not installed in the repo'); args = [j, '--ci', '--runTestsByPath', rel]; break; }
    case 'mocha': { const m = firstExisting(bin(dir, 'mocha', 'bin', 'mocha.js'), bin(dir, 'mocha', 'bin', 'mocha')); if (!m) throw new Error('mocha is not installed in the repo'); args = [m, rel]; break; }
    // node:test: run the file in-process under the permission model (read-only repo dir, no writes, no
    // child processes). Not `--test`, which would spawn a child process and need --allow-child-process.
    default: args = [...permissionArgs(dir), '--test-reporter=spec', rel];
  }
  const t0 = Date.now();
  const r = await run(process.execPath, args, { cwd: dir, timeoutMs, env: ENV() });
  return summarize(rel, r, Date.now() - t0, dir);
}

// Run the repo's own full test suite (its "test" script).
export async function runSuite(dir, timeoutMs = 180000) {
  const cli = npmCli();
  if (!cli) throw new Error('Could not find npm next to node; start RedGreen with npm run dev');
  const t0 = Date.now();
  const r = await run(process.execPath, [cli, 'test', '--silent'], { cwd: dir, timeoutMs, env: ENV() });
  return summarize('npm test', r, Date.now() - t0, dir);
}

function summarize(file, r, ms, dir) {
  const out = r.out.replaceAll(dir, '<repo>');
  const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : 0; };
  const pass = num(/Tests:.*?(\d+) passed/) || num(/ℹ pass (\d+)/) || num(/# pass (\d+)/) || num(/(\d+) passing/) || num(/Tests\s+(\d+) passed/) || num(/(\d+) passed/);
  const fail = num(/Tests:.*?(\d+) failed/) || num(/ℹ fail (\d+)/) || num(/# fail (\d+)/) || num(/(\d+) failing/) || num(/Tests\s+(\d+) failed/) || num(/(\d+) failed/);
  return { file, exitCode: r.code, passed: r.code === 0, pass, fail, durationMs: ms, output: out.slice(-8000), broken: brokenTest(out) };
}

// A failing repro test only counts if it failed because of the code under test, not because the test itself is broken.
export function brokenTest(out) {
  const m = out.match(/SyntaxError[^\n]*|Cannot find module[^\n]*|ERR_MODULE_NOT_FOUND[^\n]*|does not provide an export named[^\n]*|Failed to (load url|resolve import)[^\n]*|No test files? found[^\n]*|Your test suite must contain at least one test|ReferenceError: (test|it|describe|expect|assert) is not defined|killed after \d+ms|ERR_ACCESS_DENIED[^\n]*/);
  return m ? m[0].slice(0, 200) : null;
}

const DANGER = [/\bchild_process\b/, /\bprocess\.(env|exit|kill)\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bfetch\s*\(/, /\bWebSocket\b/, /\bwriteFile|appendFile|unlink|rmSync|rmdir|mkdir|createWriteStream\b/, /['"](node:)?(net|http|https|dgram|tls|cluster|worker_threads)['"]/];
export function checkRepoTest(code) {
  const problems = [];
  if (typeof code !== 'string' || code.trim().length < 20) return ['test code is empty'];
  if (code.length > 20000) problems.push('test code too long');
  for (const re of DANGER) if (re.test(code)) problems.push(`not allowed in a reproduction test: ${re.source}`);
  return problems;
}

// ---- patching: whole functions (declarations, const arrows, class methods) or a whole small file ----
function bodyEnd(src, from) {
  let i = src.indexOf('{', from), depth = 0, q = null;
  if (i < 0) return -1;
  for (; i < src.length; i++) {
    const ch = src[i], nx = src[i + 1];
    if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
    if (ch === '/' && nx === '/') { i = src.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '/' && nx === '*') { i = src.indexOf('*/', i) + 1; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { q = ch; continue; }
    if (ch === '{') depth++; else if (ch === '}' && --depth === 0) return i + 1;
  }
  return -1;
}
export function locateFunction(src, name) {
  const n = name.replace(/[^\w$]/g, '').replace(/\$/g, '\\$');
  const pats = [
    new RegExp(`(^|\\n)([ \\t]*)(export\\s+(default\\s+)?)?(async\\s+)?function\\s*\\*?\\s*${n}\\s*\\(`),
    new RegExp(`(^|\\n)([ \\t]*)(export\\s+)?(const|let|var)\\s+${n}\\s*=\\s*(async\\s+)?(function\\b[^{]*|\\([^)]*\\)\\s*=>\\s*|[\\w$]+\\s*=>\\s*)(?=\\{)`),
    new RegExp(`(^|\\n)([ \\t]*)(static\\s+)?(async\\s+)?(get\\s+|set\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`),
    new RegExp(`(^|\\n)([ \\t]*)(module\\.)?exports\\.${n}\\s*=\\s*(async\\s+)?function[^{]*`),
  ];
  for (const re of pats) {
    const m = re.exec(src);
    if (!m) continue;
    const start = m.index + (m[1] ? 1 : 0);
    const end = bodyEnd(src, start + m[0].length - (m[1] ? 1 : 0) - 1);
    if (end > start) return { start, end, indent: m[2] || '' };
  }
  return null;
}

export function applyRepoPatch(dir, allowedFiles, functions) {
  if (!Array.isArray(functions) || !functions.length) throw new Error('patch has no changes');
  if (functions.length > 4) throw new Error('patch too large (max 4 changes)');
  const changed = new Map();
  for (const [i, f] of functions.entries()) {
    const file = String(f?.file || '').replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!allowedFiles.includes(file)) throw new Error(`change ${i + 1}: "${file}" is not one of the files shown to you (${allowedFiles.join(', ')})`);
    let code = String(f.code || '').replace(/^\s*```(?:[jt]sx?|javascript|typescript)?\s*\n?|```\s*$/g, '');
    let src = changed.get(file) ?? fs.readFileSync(path.join(dir, file), 'utf8');
    // Keep the file's own line endings (a Windows checkout with core.autocrlf=true is CRLF; the model writes LF),
    // so the patch doesn't leave mixed endings or turn the diff into noise.
    if (/\r\n/.test(src)) code = code.replace(/\r?\n/g, '\r\n');
    if (f.name === '*' ) {
      if (src.split('\n').length > 200) throw new Error(`"${file}" is too large to rewrite whole; change individual functions instead`);
      if (code.trim() === src.trim()) continue;
      changed.set(file, code.trimEnd() + '\n'); continue;
    }
    const loc = locateFunction(src, f.name);
    if (!loc) throw new Error(`function "${f.name}" was not found in ${file}`);
    const own = locateFunction(code, f.name);
    if (!own || code.slice(own.end).trim()) throw new Error(`change ${i + 1}: code must be exactly one complete "${f.name}" with balanced braces`);
    code = code.slice(own.start, own.end).trim();
    if (src.slice(loc.start, loc.end).trim() === code) continue;
    // keep original indentation for class methods
    const indented = loc.indent ? code.split('\n').map((l, k) => (k === 0 ? loc.indent + l.trimStart() : l)).join('\n') : code;
    src = src.slice(0, loc.start) + indented + src.slice(loc.end);
    changed.set(file, src);
  }
  if (!changed.size) throw new Error('patch changes nothing');
  const before = {};
  for (const [file, src] of changed) { before[file] = fs.readFileSync(path.join(dir, file), 'utf8'); fs.writeFileSync(path.join(dir, file), src); }
  return before; // original contents, for diffing / restore
}

export async function resetRepo(dir) {
  await run('git', ['checkout', '--', '.'], { cwd: dir });
  await run('git', ['clean', '-fdq'], { cwd: dir }); // untracked only; ignored files (node_modules) are kept
}
