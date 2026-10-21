// Gemma 4 client over an OpenAI-compatible chat endpoint.
// Default: LM Studio local server (http://localhost:1234/v1). Nothing leaves the machine.
// Optional: any other OpenAI-compatible endpoint serving Gemma 4 (set GEMMA_BASE_URL + GEMMA_API_KEY).
export const modelConfig = {
  baseUrl: (process.env.GEMMA_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, ''),
  model: process.env.GEMMA_MODEL || '', // empty = auto-detect first loaded Gemma model in LM Studio
  apiKey: process.env.GEMMA_API_KEY || 'lm-studio',
  temperature: Number(process.env.GEMMA_TEMPERATURE ?? 0.2),
  maxTokens: Number(process.env.GEMMA_MAX_TOKENS ?? 3000),
  timeoutMs: Number(process.env.GEMMA_TIMEOUT_MS ?? 180000),
};

export function isLocal() {
  try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(modelConfig.baseUrl).hostname); } catch { return false; }
}

async function http(pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), modelConfig.timeoutMs);
  try {
    const res = await fetch(modelConfig.baseUrl + pathname, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${modelConfig.apiKey}` },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) { const err = new Error(`model endpoint ${res.status}: ${text.slice(0, 400)}`); err.status = res.status; throw err; }
    return JSON.parse(text);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`model timed out after ${modelConfig.timeoutMs}ms`);
    if (e.cause?.code === 'ECONNREFUSED') throw new Error(`cannot reach model at ${modelConfig.baseUrl} — is the LM Studio server running?`);
    throw e;
  } finally { clearTimeout(timer); }
}

export async function resolveModel() {
  if (modelConfig.model) return modelConfig.model;
  const list = await http('/models');
  const ids = (list.data || []).map((m) => m.id);
  const gemma = ids.find((id) => /gemma[-_ ]?4/i.test(id)) || ids.find((id) => /gemma/i.test(id));
  if (!gemma) throw new Error(`no Gemma model loaded at ${modelConfig.baseUrl}. Loaded: ${ids.join(', ') || 'none'}`);
  modelConfig.model = gemma;
  return gemma;
}

export async function status() {
  try {
    const model = await resolveModel();
    return { ok: true, model, baseUrl: modelConfig.baseUrl, local: isLocal(), gemma4: /gemma[-_ ]?4/i.test(model) };
  } catch (e) {
    return { ok: false, error: e.message, baseUrl: modelConfig.baseUrl, local: isLocal() };
  }
}

// Extract the first top-level JSON object from model text (handles ```json fences and preambles).
export function extractJson(text) {
  if (!text) throw new Error('empty model response');
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text].filter(Boolean);
  for (const c of candidates) {
    const start = c.indexOf('{');
    if (start < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < c.length; i++) {
      const ch = c[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) { try { return JSON.parse(c.slice(start, i + 1)); } catch { break; } }
    }
  }
  throw new Error('model did not return valid JSON');
}

export async function chatJson({ system, user, schemaName, schema, images = [] }) {
  const model = await resolveModel();
  const base = { model, temperature: modelConfig.temperature, max_tokens: modelConfig.maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : user }] };
  const started = Date.now();
  let data;
  try {
    data = await http('/chat/completions', { ...base, response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } });
  } catch (e) {
    if (e.status !== 400 && e.status !== 422) throw e;
    data = await http('/chat/completions', base); // endpoint doesn't support structured output; parse leniently
  }
  const msg = data.choices?.[0]?.message || {};
  const json = extractJson(msg.content || '');
  return { json, model, durationMs: Date.now() - started, usage: data.usage || null };
}
