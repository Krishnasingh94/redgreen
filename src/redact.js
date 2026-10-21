// Deterministic redaction applied to evidence BEFORE it is stored or sent to the model.
const RULES = [
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, sub: 'Bearer [REDACTED_TOKEN]' },
  { name: 'api_key', re: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, sub: '[REDACTED_KEY]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, sub: '[REDACTED_JWT]' },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, sub: '[REDACTED_EMAIL]' },
  { name: 'card', re: /\b(?:\d[ -]?){13,19}\b/g, sub: '[REDACTED_CARD]' },
  { name: 'query_secret', re: /([?&](?:token|key|secret|password|session|auth)=)[^&\s"]+/gi, sub: '$1[REDACTED]' },
];
const SENSITIVE_KEYS = /^(authorization|cookie|set-cookie|x-api-key|password|token|secret|session)$/i;

export function redact(value) {
  let count = 0;
  function walk(v, key) {
    if (typeof key === 'string' && SENSITIVE_KEYS.test(key) && v != null) { count++; return '[REDACTED]'; }
    if (typeof v === 'string') {
      // Try JSON-encoded strings (e.g. request bodies) so keys inside are handled too.
      const trimmed = v.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 100000) {
        try { return JSON.stringify(walk(JSON.parse(trimmed))); } catch {}
      }
      let out = v;
      for (const r of RULES) out = out.replace(r.re, (...m) => { count++; return r.sub.replace('$1', m[1] ?? ''); });
      return out;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === 'object') {
      const o = {};
      for (const [k, x] of Object.entries(v)) o[k] = walk(x, k);
      return o;
    }
    return v;
  }
  const result = walk(value);
  return { value: result, count };
}
