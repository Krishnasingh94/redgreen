// Step-1 proof of concept: is Gemma 4 reachable locally, and does it return usable structured JSON?
import { status, chatJson, modelConfig } from '../src/model.js';

const s = await status();
console.log('Endpoint :', modelConfig.baseUrl, s.local ? '(local)' : '(REMOTE)');
if (!s.ok) { console.error('FAIL     :', s.error); process.exit(1); }
console.log('Model    :', s.model, s.gemma4 ? '✓ Gemma 4' : '⚠ not detected as Gemma 4 — check the model id');

const t = Date.now();
const r = await chatJson({
  system: 'Return only JSON.',
  user: 'A function round2(n) returns Math.round(n*100)/100. Write a node:test test asserting round2(1.005) === 1.01 is NOT what JS gives. Fields: test_code (string), note (string).',
  schemaName: 'smoke',
  schema: { type: 'object', additionalProperties: false, required: ['test_code', 'note'], properties: { test_code: { type: 'string' }, note: { type: 'string' } } },
});
const secs = (Date.now() - t) / 1000;
console.log('JSON     : ✓ parsed, keys =', Object.keys(r.json).join(', '));
console.log('Latency  :', secs.toFixed(1) + 's', r.usage?.completion_tokens ? `(${r.usage.completion_tokens} tokens, ~${(r.usage.completion_tokens / secs).toFixed(1)} tok/s)` : '');
console.log('\n' + r.json.test_code.slice(0, 600));
console.log('\nPASS — Gemma is ready for RedGreen.');
