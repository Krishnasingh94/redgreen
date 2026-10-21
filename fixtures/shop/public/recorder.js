// RedGreen evidence recorder (drop-in, no dependencies).
// Records: user actions + resulting state, console errors, uncaught errors, failed fetches.
// Nothing leaves the page until the user clicks "Report bug" and approves.
const events = [];
let seq = 0;
const t0 = performance.now();
function push(type, data) {
  events.push({ id: 'e' + (++seq), t_ms: Math.round(performance.now() - t0), type, ...data });
  if (events.length > 500) events.shift();
}

export function recordAction(name, args, stateAfter) {
  push('action', { name, args: JSON.parse(JSON.stringify(args ?? [])), stateAfter });
}

const origError = console.error.bind(console);
console.error = (...a) => { push('console.error', { message: a.map(String).join(' ') }); origError(...a); };
window.addEventListener('error', (e) => push('uncaught', { message: e.message, source: e.filename, line: e.lineno }));
window.addEventListener('unhandledrejection', (e) => push('uncaught', { message: String(e.reason) }));

const origFetch = window.fetch.bind(window);
window.fetch = async (url, opts = {}) => {
  const started = performance.now();
  try {
    const res = await origFetch(url, opts);
    if (!res.ok) {
      let body = '';
      try { body = await res.clone().text(); } catch {}
      push('network.failed', {
        method: opts.method || 'GET', url: String(url), status: res.status,
        requestHeaders: opts.headers || {}, requestBody: opts.body ? String(opts.body) : null,
        responseBody: body.slice(0, 2000), duration_ms: Math.round(performance.now() - started),
      });
    }
    return res;
  } catch (err) {
    push('network.failed', { method: opts.method || 'GET', url: String(url), status: 0, error: String(err) });
    throw err;
  }
};

export function getBundle(description) {
  return {
    schema: 'redgreen.evidence/v1',
    app: 'demo-shop',
    description,
    captured_at: new Date().toISOString(),
    env: { userAgent: navigator.userAgent, url: location.href, viewport: `${innerWidth}x${innerHeight}` },
    events: events.slice(),
  };
}
