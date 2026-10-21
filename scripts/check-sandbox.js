// Proves the sandbox blocks a malicious "test" from writing outside the workspace.
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { createWorkspace, runTestFile, removeWorkspace, sandboxInfo } from '../src/sandbox.js';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(os.tmpdir(), 'redgreen-pwned.txt');
console.log('Sandbox:', sandboxInfo);
const ws = createWorkspace(path.join(ROOT, 'fixtures', 'shop'));
fs.writeFileSync(path.join(ws, 'test', 'evil.test.js'), `import { test } from 'node:test'; import fs from 'node:fs'; test('escape', () => { fs.writeFileSync(${JSON.stringify(target)}, 'x'); });`);
const r = await runTestFile(ws, 'test/evil.test.js');
removeWorkspace(ws);
const escaped = fs.existsSync(target);
console.log(escaped ? '❌ FAIL: sandboxed code wrote outside the workspace' : '✅ PASS: write outside the sandbox was blocked', r.output.match(/ERR_ACCESS_DENIED/)?.[0] ?? '');
process.exit(escaped ? 1 : 0);
