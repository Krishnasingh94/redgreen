// Proves the sandbox isolates model-generated tests: it can read the sandbox dir, but cannot read
// outside it, write anywhere, or spawn processes. Runs from a folder whose name contains a space
// (like "pr guardian") so Windows/space path handling is exercised, and checks <sandbox> masking.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createWorkspace, runTestFile, removeWorkspace, sandboxInfo } from '../src/sandbox.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
console.log('Sandbox:', sandboxInfo);
if (!sandboxInfo.permissionModel.startsWith('--')) { console.log('❌ FAIL: Node permission model unavailable; need Node >= 22.13'); process.exit(1); }

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pr guardian '));
const outsideSecret = path.join(base, 'outside-secret.txt'); fs.writeFileSync(outsideSecret, 'TOP-SECRET');
const writeTarget = path.join(base, 'redgreen-pwned.txt');
const ws = createWorkspace(path.join(ROOT, 'fixtures', 'shop'), base);
const J = JSON.stringify;
fs.writeFileSync(path.join(ws, 'test', 'evil.test.js'), `import { test } from 'node:test'; import fs from 'node:fs'; import cp from 'node:child_process';
import { total, createCart } from '../src/cart.js';
const probe = (name, fn) => { try { fn(); console.log('PROBE ' + name + ' ALLOWED'); } catch (e) { console.log('PROBE ' + name + ' ' + (e.code || e.message)); } };
test('probes', () => {
  probe('import-cart', () => { if (total(createCart()) !== 0) throw new Error('bad'); });
  probe('read-inside', () => fs.readFileSync(new URL('../src/cart.js', import.meta.url)));
  probe('read-outside', () => fs.readFileSync(${J(outsideSecret)}));
  probe('write-outside', () => fs.writeFileSync(${J(writeTarget)}, 'x'));
  probe('write-inside', () => fs.writeFileSync(new URL('./pwned.txt', import.meta.url), 'x'));
  probe('spawn', () => cp.spawnSync(process.execPath, ['-v']));
  console.log('WHERE ' + new URL(import.meta.url).href + ' | ' + ${J(ws)});
});`);
const r = await runTestFile(ws, 'test/evil.test.js');
const wroteInside = fs.existsSync(path.join(ws, 'test', 'pwned.txt'));
removeWorkspace(ws);
const probe = (n) => r.output.match(new RegExp(`PROBE ${n} (\\S+)`))?.[1] ?? 'missing';
const checks = [
  ['sandbox path contains a space', /\s/.test(ws)],
  ['generated test can import the module under test', probe('import-cart') === 'ALLOWED'],
  ['generated test can read the sandbox dir', probe('read-inside') === 'ALLOWED'],
  ['read outside the sandbox blocked', probe('read-outside') === 'ERR_ACCESS_DENIED'],
  ['write outside the sandbox blocked', probe('write-outside') === 'ERR_ACCESS_DENIED' && !fs.existsSync(writeTarget)],
  ['write inside the sandbox blocked', probe('write-inside') === 'ERR_ACCESS_DENIED' && !wroteInside],
  ['child process spawn blocked', probe('spawn') === 'ERR_ACCESS_DENIED'],
  ['sandbox path masked in output', r.output.includes('<sandbox>') && !r.output.includes(ws) && !r.output.includes(encodeURI(ws.replaceAll('\\', '/')))],
];
fs.rmSync(base, { recursive: true, force: true });
for (const [name, ok] of checks) console.log(ok ? '  ✓' : '  ✗', name);
const ok = checks.every(([, v]) => v);
if (!ok) console.log(r.output);
console.log(ok ? '✅ PASS: sandbox isolation verified' : '❌ FAIL: sandbox isolation check failed');
process.exit(ok ? 0 : 1);
