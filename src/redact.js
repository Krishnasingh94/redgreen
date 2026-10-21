// Deterministic redaction applied to evidence BEFORE it is stored or sent to the model.
// Order matters: multi-line / structured secrets first, then tokens, then PII.

// Luhn checksum: only digit runs that are valid card numbers are redacted (order ids and timestamps are kept).
function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

const RULES = [
  { name: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, sub: '[REDACTED_PRIVATE_KEY]' },
  { name: 'url_credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, sub: (m, scheme) => `${scheme}[REDACTED]@` },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, sub: 'Bearer [REDACTED_TOKEN]' },
  // Basic credentials are base64; require a digit or base64 symbol so prose like "Basic information" is kept.
  { name: 'basic', re: /\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{8,}={0,2}/g, sub: 'Basic [REDACTED_TOKEN]' },
  { name: 'github_token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g, sub: '[REDACTED_KEY]' },
  { name: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, sub: '[REDACTED_KEY]' },
  { name: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, sub: '[REDACTED_KEY]' },
  { name: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, sub: '[REDACTED_KEY]' },
  { name: 'sk_key', re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g, sub: '[REDACTED_KEY]' },
  { name: 'stripe_key', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g, sub: '[REDACTED_KEY]' },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, sub: '[REDACTED_JWT]' },
  { name: 'query_secret', re: /([?&](?:token|key|secret|password|session|auth|access_token|api_key)=)[^&\s"]+/gi, sub: (m, k) => `${k}[REDACTED]` },
  // key=value / key: value secrets inside free text (console messages, error strings)
  { name: 'kv_secret', re: /\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(\s*[:=]\s*)(?!\[REDACTED)["']?[^\s"'&,;]+["']?/gi, sub: (m, k, sep) => `${k}${sep}[REDACTED]` },
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, sub: '[REDACTED_EMAIL]' },
  { name: 'card', re: /\b(?:\d[ -]?){12,18}\d\b/g, sub: (m) => (luhn(m.replace(/\D/g, '')) ? '[REDACTED_CARD]' : m) },
  // international phone numbers (only with a leading +, to avoid touching prices, ids and quantities)
  { name: 'phone', re: /\+\d{1,3}[ -]?\(?\d{2,5}\)?[ -]?\d{3,5}(?:[ -]?\d{2,5})?\b/g, sub: '[REDACTED_PHONE]' },
];

// Matched case-insensitively with "-" and "_" ignored, so accessToken / access_token / Access-Token all match.
const SENSITIVE_KEYS = new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'xapikey', 'xauthtoken', 'apikey', 'password', 'passwd', 'secret', 'clientsecret', 'token', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'session', 'sessionid', 'privatekey', 'creditcard', 'cardnumber', 'cvv', 'cvc']);
const isSensitiveKey = (k) => typeof k === 'string' && SENSITIVE_KEYS.has(k.toLowerCase().replace(/[-_]/g, ''));

export function redact(value) {
  let count = 0;
  function walk(v, key) {
    if (isSensitiveKey(key) && v != null && v !== '') { count++; return '[REDACTED]'; }
    if (typeof v === 'string') {
      // Try JSON-encoded strings (e.g. request bodies) so keys inside are handled too.
      const trimmed = v.trim();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 100000) {
        try { return JSON.stringify(walk(JSON.parse(trimmed))); } catch {}
      }
      let out = v;
      for (const r of RULES) {
        out = out.replace(r.re, (...m) => {
          const rep = typeof r.sub === 'function' ? r.sub(...m) : r.sub;
          if (rep !== m[0]) count++;
          return rep;
        });
      }
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
