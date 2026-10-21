// CI helper: turn failing tests in node:test TAP output into GitHub Actions error annotations, so the exact
// failure (name, error, expected/actual, location, first stack lines) shows on the PR without opening raw logs.
//   node scripts/ci-annotate.js test-output.txt
import fs from 'node:fs';

const file = process.argv[2];
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
const esc = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const failures = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s*not ok \d+ - (.*)$/);
  if (!m) continue;
  const body = [];
  let j = i + 1;
  if (/^\s*---\s*$/.test(lines[j] || '')) { for (j++; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) body.push(lines[j].trim()); }
  // skip parent suites/files whose only failure is a nested subtest (they repeat the child's error)
  if (body.some((l) => /failureType: 'subtestsFailed'/.test(l))) continue;
  failures.push({ name: m[1].trim(), detail: body.filter((l) => !/^(duration_ms|type):/.test(l)).join('\n').slice(0, 3000) });
}
for (const f of failures.slice(0, 10)) console.log(`::error title=Test failed: ${esc(f.name).slice(0, 200)}::${esc(f.detail || '(no details in TAP output)')}`);
console.log(`${failures.length} failing test(s) annotated${failures.length > 10 ? ' (first 10)' : ''}.`);
