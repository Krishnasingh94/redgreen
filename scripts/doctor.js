// Pre-demo health check: is everything RedGreen needs actually working on THIS machine?
//   npm run doctor            (add --quick to skip the sandbox self-test)
// Exit code 1 if anything required for the core demo fails. Optional features only warn.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { status, modelConfig } from '../src/model.js';
import { sandboxInfo } from '../src/sandbox.js';
import { npmCli } from '../src/github.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const quick = process.argv.includes('--quick');
const rows = [];
const check = (level, name, ok, detail, fix) => { rows.push({ level, name, ok, detail, fix }); };

// 1. Node + sandbox
const [maj, min] = process.versions.node.split('.').map(Number);
const permOk = sandboxInfo.permissionModel.startsWith('--');
check('required', 'Node.js version', maj > 22 || (maj === 22 && min >= 13), `v${process.versions.node}`, 'Install Node 22 LTS or newer (>= 22.13) from nodejs.org');
check('required', 'Sandbox (Node permission model)', permOk, permOk ? sandboxInfo.permissionModel : sandboxInfo.permissionModel, 'Upgrade Node to >= 22.13; without it generated tests are not isolated');
if (!quick && permOk) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-sandbox.js')], { encoding: 'utf8', timeout: 60000 });
  const failed = (r.stdout.match(/✗ .*/g) || []).join('; ');
  check('required', 'Sandbox isolation self-test', r.status === 0, r.status === 0 ? 'reads inside only; no outside reads, writes or spawns' : failed || (r.stderr || '').slice(-200), 'Run "npm run check:sandbox" and send the output');
}

// 2. Model
const s = await status();
const reachable = s.ok || !/cannot reach|ECONNREFUSED|fetch failed|timed out|ENOTFOUND/i.test(s.error || '');
check('required', 'LM Studio reachable', reachable, `${modelConfig.baseUrl}${reachable ? '' : ' — ' + s.error}`, 'Open LM Studio → Developer tab → Start Server (port 1234), or set GEMMA_BASE_URL');
if (reachable) check('required', 'Gemma model loaded', s.ok, s.ok ? s.model : (s.error || 'no model'), 'In LM Studio, load "Gemma 4 E4B" (Q4_K_M); or set GEMMA_MODEL to the loaded model id');
if (s.ok) check('recommended', 'Model is Gemma 4', !!s.gemma4, s.model, 'Load a Gemma 4 model (the project targets Gemma 4 E4B)');
if (s.ok) check('recommended', 'Model endpoint is local', s.local, s.baseUrl, 'With a remote endpoint, code and redacted evidence leave this machine');

// 3. Data + fixture
const sample = path.join(ROOT, 'data', 'reports', 'rpt_sample.json');
check('required', 'Sample report present', fs.existsSync(sample), 'data/reports/rpt_sample.json', 'Run "npm run sample"');
let writable = true; try { const d = path.join(ROOT, 'data', 'runs'); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, '.doctor-write-test'); fs.writeFileSync(f, 'x'); fs.rmSync(f); } catch { writable = false; }
check('required', 'data/ folder writable', writable, path.join(ROOT, 'data'), 'Move the project out of a read-only / synced-locked folder');
const port = Number(process.env.PORT || 3000);
const busy = await fetch(`http://127.0.0.1:${port}/api/status`).then(() => true).catch(() => false);
check('info', `Port ${port}`, true, busy ? 'something is already serving here (RedGreen already running?)' : 'free', busy ? 'Stop the other server or set PORT' : '');

// 4. GitHub / Website mode (optional)
const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
check('optional', 'git (GitHub mode)', git.status === 0, git.status === 0 ? git.stdout.trim() : 'not found', 'Install Git for Windows / git');
check('optional', 'npm next to node (GitHub mode)', !!npmCli(), npmCli() || 'not found', 'Start RedGreen with "npm start" / "npm run start:github" so npm is found');
let pw = null; try { pw = await import('playwright-core'); } catch {}
check('optional', 'playwright-core (Website mode)', !!pw, pw ? 'installed' : 'not installed', 'Run "npm install" in the RedGreen folder (Website mode only)');
if (pw) {
  let launched = null, err = '';
  for (const opt of [process.env.CHROME_PATH && { executablePath: process.env.CHROME_PATH }, { channel: 'chrome' }, { channel: 'msedge' }].filter(Boolean)) {
    try { const b = await pw.chromium.launch({ headless: true, ...opt }); await b.close(); launched = opt.channel || opt.executablePath; break; } catch (e) { err = e.message.split('\n')[0]; }
  }
  check('optional', 'Chrome/Edge for Website mode', !!launched, launched || err, 'Install Chrome or Edge, or set CHROME_PATH');
}

// report
const icon = (r) => (r.ok ? '✓' : r.level === 'required' ? '✗' : '!');
for (const r of rows) console.log(`${icon(r)} ${r.name.padEnd(34)} ${r.detail}${r.ok || !r.fix ? '' : `\n    → ${r.fix}`}`);
const bad = rows.filter((r) => !r.ok && r.level === 'required');
console.log(bad.length ? `\n❌ ${bad.length} required check(s) failed — fix the → items above before the demo.` : '\n✅ Ready for the demo.' + (rows.some((r) => !r.ok) ? ' (optional items above only affect GitHub/Website mode)' : ''));
process.exit(bad.length ? 1 : 0);
