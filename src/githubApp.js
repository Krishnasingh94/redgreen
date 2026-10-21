// GitHub App auth without dependencies: app JWT (RS256) -> installation tokens. Works with webhooks turned off:
// the worker polls the installations, so anyone can install the app without us running a public server.
import crypto from 'node:crypto';
const API = () => process.env.GITHUB_API_URL || 'https://api.github.com';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function appJwt(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

export function createAppAuth({ appId, privateKey }) {
  const tokens = new Map(); // installation id -> { token, exp }
  let repoToInstall = new Map();
  let app = null;
  async function call(method, path, auth, body) {
    const res = await fetch(API() + path, { method, headers: { Authorization: `Bearer ${auth}`, Accept: 'application/vnd.github+json', 'User-Agent': 'redgreen-app', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text();
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}: ${t.slice(0, 160)}`);
    return t ? JSON.parse(t) : null;
  }
  async function installationToken(id) {
    const c = tokens.get(id);
    if (c && c.exp - Date.now() > 5 * 60_000) return c.token;
    const r = await call('POST', `/app/installations/${id}/access_tokens`, appJwt(appId, privateKey));
    tokens.set(id, { token: r.token, exp: new Date(r.expires_at).getTime() });
    return r.token;
  }
  return {
    async info() { app ??= await call('GET', '/app', appJwt(appId, privateKey)); return app; },
    // Every repo where someone installed the app.
    async repos() {
      const installs = await call('GET', '/app/installations?per_page=100', appJwt(appId, privateKey));
      const map = new Map(), out = [];
      for (const ins of installs) {
        const tok = await installationToken(ins.id);
        const r = await call('GET', '/installation/repositories?per_page=100', tok);
        for (const repo of r.repositories) { map.set(repo.full_name.toLowerCase(), ins.id); out.push({ repo: repo.full_name, account: ins.account?.login, installationId: ins.id }); }
      }
      repoToInstall = map;
      return out;
    },
    async tokenFor(repo) {
      const id = repoToInstall.get(repo.toLowerCase());
      if (!id) throw new Error(`RedGreen is not installed on ${repo}`);
      return installationToken(id);
    },
  };
}
