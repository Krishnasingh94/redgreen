// Clears saved reports/runs (keeps the scripted sample) so the demo can be rerun from scratch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
for (const dir of ['reports', 'runs']) {
  const d = path.join(DATA, dir); fs.mkdirSync(d, { recursive: true });
  for (const f of fs.readdirSync(d)) if (!f.startsWith('rpt_sample')) fs.rmSync(path.join(d, f));
}
console.log('Reset done: data/reports and data/runs cleared (sample kept).');
