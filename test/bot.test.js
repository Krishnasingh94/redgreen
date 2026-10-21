// GitHub bot safety against a fake GitHub API: in App mode only allowed accounts (default: the app owner) can
// make this machine run code, and everything posted publicly is sanitised.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';

const posted = []; let gh;
before(async () => {
  gh = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let body = '';
    req.on('data', (d) => (body += d)); req.on('end', () => {
      const auth = req.headers.authorization || '';
      const j = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (u.pathname === '/app') return j({ slug: 'redgreen-test', name: 'RedGreen test', html_url: 'https://github.com/apps/redgreen-test', owner: { login: 'OwnerUser' } });
      if (u.pathname === '/app/installations') return j([{ id: 1, account: { login: 'ownerUser' } }, { id: 2, account: { login: 'stranger' } }]);
      let m;
      if ((m = u.pathname.match(/^\/app\/installations\/(\d+)\/access_tokens$/))) return j({ token: `tok${m[1]}`, expires_at: new Date(Date.now() + 3600e3).toISOString() });
      if (u.pathname === '/installation/repositories') return j({ repositories: [{ full_name: auth.endsWith('tok1') ? 'ownerUser/app1' : 'stranger/evil' }] });
      if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/))) return j([{ number: 7, title: 'bug', body: 'it breaks' }]);
      if (/\/issues\/comments$/.test(u.pathname)) return j([]);
      if ((m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/)) && req.method === 'POST') { posted.push({ repo: m[1], body: JSON.parse(body).body }); return j({ id: posted.length }, 201); }
      j({ message: 'not found' }, 404);
    });
  });
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  process.env.GITHUB_API_URL = `http://127.0.0.1:${gh.address().port}`;
});
after(() => gh.close());

test('App mode: only the owner\'s (and explicitly allowed) installations run; strangers are ignored; comments are sanitised', async () => {
  const { createBot } = await import('../src/bot.js?bot-test');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const ran = [], logs = [];
  const runCase = async (kase) => { ran.push(`${kase.repo.owner}/${kase.repo.repo}`); return { id: 'run_x', verdict: 'not_reproduced', steps: [{ type: 'repro.rejected', reason: `crashed at ${os.homedir()}/secret/x.js with token ghp_${'b'.repeat(36)}` }] }; };
  const createCase = async (ref) => ({ id: 'gh_x', kind: 'github', repo: ref, issue: { title: 'bug' } });
  const bot = createBot({ createCase, runCase, log: (m) => logs.push(m), getConfig: () => ({ appId: '123', privateKey, label: 'redgreen', intervalMs: 3600e3, repos: [], allowAccounts: [] }) });
  await bot.start();
  for (let i = 0; i < 50 && !(ran.length && posted.length >= 2); i++) await new Promise((r) => setTimeout(r, 100));
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(ran, ['ownerUser/app1'], `ran: ${ran}`);
  assert.ok(logs.some((l) => /ignoring installation on @stranger/.test(l)), logs.join('\n'));
  assert.equal(bot.status.ignoredInstallations, 1);
  assert.ok(posted.length >= 1 && posted.every((p) => p.repo === 'ownerUser/app1'), 'never comments on the stranger\'s repo');
  const all = posted.map((p) => p.body).join('\n');
  assert.ok(!all.includes(os.homedir()), 'home folder leaked into a public comment');
  assert.ok(!/ghp_b{36}/.test(all), 'token leaked into a public comment');
  assert.match(all, /~\/secret\/x\.js/);
});

test('App mode: an explicitly allowed account is also run', async () => {
  posted.length = 0;
  const { createBot } = await import('../src/bot.js?bot-test-2');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const ran = [];
  const bot = createBot({ createCase: async (ref) => ({ id: 'gh_y', kind: 'github', repo: ref, issue: { title: 'b' } }), runCase: async (k) => { ran.push(`${k.repo.owner}/${k.repo.repo}`); return { id: 'r', verdict: 'not_reproduced', steps: [] }; }, log: () => {}, getConfig: () => ({ appId: '123', privateKey, label: 'redgreen', intervalMs: 3600e3, repos: [], allowAccounts: ['stranger'] }) });
  await bot.start();
  for (let i = 0; i < 60 && ran.length < 2; i++) await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ran.sort(), ['ownerUser/app1', 'stranger/evil']);
});
