// Runs tests in a throwaway copy of the fixture, with a timeout, a minimal env,
// no shell, and (when supported by this Node version) the Node permission model
// restricting filesystem reads to the sandbox and blocking child processes / writes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERM_FLAG = process.allowedNodeEnvironmentFlags.has('--permission') ? '--permission'
  : process.allowedNodeEnvironmentFlags.has('--experimental-permission') ? '--experimental-permission' : null;

export const sandboxInfo = { permissionModel: PERM_FLAG ?? 'unavailable (upgrade Node to >=22.13 for fs isolation)', timeoutMs: 15000, node: process.version };

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
  if (PERM_FLAG) args.push(PERM_FLAG, `--allow-fs-read=${workspace}${path.sep}*`, `--allow-fs-read=${workspace}`);
  args.push('--test-reporter=spec', file);
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
