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
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'redgreen-probe-'))); // long path, as in createWorkspace
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

// baseDir is optional (tests use it to prove paths with spaces work).
// Permission-model flags that give read-only access to `dir` (no writes, no child processes, no workers).
// Empty when this Node version has no usable permission model.
export function permissionArgs(dir) { return READ_ARGS ? [PERM_FLAG, ...READ_ARGS(dir)] : []; }

export function createWorkspace(fixtureDir, baseDir = os.tmpdir()) {
  // realpath: on Windows %TEMP% is often an 8.3 short path (C:\Users\KRISHN~1\...) while Node's module
  // loader reads the long real path, which the permission model would then deny. Use the real path everywhere.
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(baseDir, 'redgreen-')));
  fs.cpSync(fixtureDir, dir, { recursive: true, filter: (src) => !src.includes('node_modules') });
  return dir;
}

export function removeWorkspace(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Replace every form of the workspace path that can appear in test output with <sandbox>:
// native (C:\a b\x), forward-slash (C:/a b/x), and file-URL-encoded (C:/a%20b/x). Case-insensitive on Windows.
export function maskPaths(output, workspace, win = process.platform === 'win32') {
  const fwd = workspace.replaceAll('\\', '/');
  const forms = [...new Set([workspace, fwd, encodeURI(fwd)])].sort((a, b) => b.length - a.length);
  const re = new RegExp(forms.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), win ? 'gi' : 'g');
  return output.replace(re, '<sandbox>');
}

export function runTestFile(workspace, relFile, timeoutMs = sandboxInfo.timeoutMs) {
  const file = path.join(workspace, relFile);
  const args = [];
  // READ_ARGS is the read-allow form probed at startup (a plain directory grant first: it covers everything
  // beneath it). Writes, child processes, workers and native addons stay denied: no --allow-* flag is passed for them.
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
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); out += `\n[redgreen] killed after ${timeoutMs}ms timeout`; }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const output = maskPaths(out, workspace);
      const pass = Number(output.match(/ℹ pass (\d+)|# pass (\d+)/)?.slice(1).find(Boolean) ?? 0);
      const fail = Number(output.match(/ℹ fail (\d+)|# fail (\d+)/)?.slice(1).find(Boolean) ?? 0);
      const assertion = /AssertionError|ERR_ASSERTION/.test(output);
      resolve({ file: relFile, exitCode: code, signal, timedOut, passed: code === 0 && !timedOut, pass, fail, assertionFailure: assertion && !timedOut, durationMs: Date.now() - started, output: output.slice(-8000) });
    });
  });
}
