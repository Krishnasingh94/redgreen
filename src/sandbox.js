// Runs tests in a throwaway copy of the fixture, with a timeout, a minimal env,
// no shell, and (when supported by this Node version) the Node permission model
// restricting filesystem reads to the sandbox and blocking child processes / writes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { spawnSync } from 'node:child_process';

const PERM_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission'
  : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : null;

// Node's permission-model path syntax differs across versions/OSes (e.g. Node 20 on Windows aborts on "dir\\*").
// Probe once at startup: pick the first read-allow variant that (a) lets code read files inside the dir and
// (b) still blocks writes. If none works, run without fs isolation and say so in the UI.
const READ_VARIANTS = [
  (d) => [`--allow-fs-read=${d}`],
  (d) => [`--allow-fs-read=${path.join(d, '*')}`],
  (d) => [`--allow-fs-read=${d}`, `--allow-fs-read=${path.join(d, '*')}`],
];
function probe() {
  if (!PERM_FLAG) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-probe-'));
  try {
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'data.txt'), 'ok');
    const script = path.join(dir, 'sub', 'probe.mjs');
    fs.writeFileSync(script, `import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = fs.readFileSync(path.join(here, 'data.txt'), 'utf8') === 'ok';
let wrote = false; try { fs.writeFileSync(path.join(here, 'w.txt'), 'x'); wrote = true; } catch {}
console.log(JSON.stringify({ read, wrote }));`);
    for (const v of READ_VARIANTS) {
      const r = spawnSync(process.execPath, [PERM_FLAG, ...v(dir), script], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      try { const o = JSON.parse(r.stdout.trim().split('\n').pop()); if (r.status === 0 && o.read && !o.wrote) return v; } catch {}
    }
    return null;
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}
const READ_ARGS = probe();

export const sandboxInfo = {
  permissionModel: READ_ARGS ? PERM_FLAG : `unavailable on Node ${process.version} here — install Node 22 LTS for fs isolation`,
  timeoutMs: 15000, node: process.version,
};

export function createWorkspace(fixtureDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-'));
  fs.cpSync(fixtureDir, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  return dir;
}

export function removeWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

export function runTestFile(workspace, relFile, timeoutMs = sandboxInfo.timeoutMs) {
  const file = path.join(workspace, relFile);
  const args = [];
  if (READ_ARGS) args.push(PERM_FLAG, ...READ_ARGS(workspace));
  args.push('--no-warnings', '--test-reporter=spec', file);
  const env = { NODE_ENV: 'test', NO_COLOR: '1', FORCE_COLOR: '0' };
  if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: workspace, env, shell: false, windowsHide: true });
    let out = '';
    const cap = (d) => { if (out.length < 60000) out += d.toString(); };
    child.stdout.on('data', cap); child.stderr.on('data', cap);
    const timer = setTimeout(() => { child.kill('SIGKILL'); out += `\n[redgreen] killed after ${timeoutMs}ms timeout`; }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = out.replaceAll(workspace, '<sandbox>');
      const pass = Number(output.match(/ℹ pass (\d+)|# pass (\d+)/)?.slice(1).find(Boolean) ?? 0);
      const fail = Number(output.match(/ℹ fail (\d+)|# fail (\d+)/)?.slice(1).find(Boolean) ?? 0);
      const assertion = /AssertionError|ERR_ASSERTION/.test(output);
      resolve({ file: relFile, exitCode: code, signal, passed: code === 0, pass, fail, assertionFailure: assertion, durationMs: Date.now() - started, output: output.slice(-8000) });
    });
  });
}
