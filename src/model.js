// Gemma 4 client over an OpenAI-compatible chat endpoint.
// Default: LM Studio local server (http://localhost:1234/v1). Nothing leaves the machine.
// Optional: any other OpenAI-compatible endpoint serving Gemma 4 (set GEMMA_BASE_URL + GEMMA_API_KEY).
let lastStatus = null;
export const modelConfig = {
  baseUrl: (process.env.GEMMA_BASE_URL || 'http://localhost:1234/v1').replace(/\/$/, ''),
  model: process.env.GEMMA_MODEL || '', // empty = auto-detect first loaded Gemma model in LM Studio
  apiKey: process.env.GEMMA_API_KEY || 'lm-studio',
  temperature: Number(process.env.GEMMA_TEMPERATURE ?? 0.2),
  maxTokens: Number(process.env.GEMMA_MAX_TOKENS ?? 3000),
  timeoutMs: Number(process.env.GEMMA_TIMEOUT_MS ?? 90000),
  // provider: 'lmstudio' (OpenAI-compatible, local) or 'gemini' (Gemma 4 through Google's Gemini API, bring your own key)
  provider: process.env.GEMMA_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : 'lmstudio'),
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_GEMMA_MODEL || 'gemma-4-26b-a4b-it',
};
export const GEMINI_MODELS = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it'];

// Apply settings saved from the website (data/model-config.json). Keys are kept on this machine only.
export function applyModelSettings(cfg = {}) {
  if (cfg.provider === 'gemini' || cfg.provider === 'lmstudio') modelConfig.provider = cfg.provider;
  if (typeof cfg.geminiKey === 'string' && cfg.geminiKey) modelConfig.geminiKey = cfg.geminiKey;
  if (GEMINI_MODELS.includes(cfg.geminiModel)) modelConfig.geminiModel = cfg.geminiModel;
  if (typeof cfg.baseUrl === 'string' && /^https?:\/\//.test(cfg.baseUrl)) { modelConfig.baseUrl = cfg.baseUrl.replace(/\/$/, ''); modelConfig.model = ''; }
  lastStatus = null;
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
async function geminiGenerate({ system, user, images = [], temperature }) {
  if (!modelConfig.geminiKey) throw new Error('No Gemini API key set. Add one in Model settings.');
  const parts = [{ text: `${system}\n\n${user}\n\nReply with ONLY the JSON object, no prose, no markdown fences.` }];
  for (const url of images) { const m = String(url).match(/^data:(image\/[a-z]+);base64,(.+)$/); if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } }); }
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), modelConfig.timeoutMs);
  try {
    const res = await fetch(`${GEMINI}/${modelConfig.geminiModel}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': modelConfig.geminiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { temperature: temperature ?? modelConfig.temperature, maxOutputTokens: modelConfig.maxTokens } }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${text.slice(0, 300)}`);
    const j = JSON.parse(text);
    return (j.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  } catch (e) { if (e.name === 'AbortError') throw new Error(`Gemini API timed out after ${modelConfig.timeoutMs}ms`); throw e; }
  finally { clearTimeout(t); }
}

export function isLocal() {
  if (modelConfig.provider === 'gemini') return false;
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
  if (modelConfig.provider === 'gemini') { if (!modelConfig.geminiKey) throw new Error('No Gemini API key set. Add one in Model settings.'); return modelConfig.geminiModel; }
  if (modelConfig.model) return modelConfig.model;
  const list = await http('/models');
  const ids = (list.data || []).map((m) => m.id);
  const gemma = ids.find((id) => /gemma[-_ ]?4/i.test(id)) || ids.find((id) => /gemma/i.test(id));
  if (!gemma) throw new Error(`no Gemma model loaded at ${modelConfig.baseUrl}. Loaded: ${ids.join(', ') || 'none'}`);
  modelConfig.model = gemma;
  return gemma;
}

export async function status() {
  // Never let the page wait on a busy model server: answer within 2 s, using the last known state if needed.
  const check = (async () => {
    try {
      const model = await resolveModel();
      return (lastStatus = { ok: true, model, provider: modelConfig.provider, baseUrl: modelConfig.provider === 'gemini' ? 'Gemini API' : modelConfig.baseUrl, local: isLocal(), gemma4: /gemma[-_ ]?4/i.test(model) });
    } catch (e) {
      return (lastStatus = { ok: false, error: e.message, baseUrl: modelConfig.baseUrl, local: isLocal() });
    }
  })();
  const slow = new Promise((r) => setTimeout(() => r(lastStatus || { ok: false, checking: true, error: 'Still checking the model server…', baseUrl: modelConfig.baseUrl, local: isLocal() }), 2000));
  return Promise.race([check, slow]);
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

export async function chatJson({ system, user, schemaName, schema, images = [], temperature }) {
  const model = await resolveModel();
  if (modelConfig.provider === 'gemini') {
    const started = Date.now();
    const text = await geminiGenerate({ system, user, images, temperature });
    let json;
    try { json = extractJson(text); } catch (e) { throw new Error(`${e.message}. Got: ${String(text).slice(0, 200)}`); }
    return { json, model, durationMs: Date.now() - started, usage: null };
  }
  const base = { model, temperature: temperature ?? modelConfig.temperature, max_tokens: modelConfig.maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: images.length ? [{ type: 'text', text: user }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] : user }] };
  const started = Date.now();
  let data;
  try {
    data = await http('/chat/completions', { ...base, response_format: { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } } });
  } catch (e) {
    if (e.status !== 400 && e.status !== 422) throw e;
    data = await http('/chat/completions', base); // endpoint doesn't support structured output; parse leniently
  }
  const choice = data.choices?.[0] || {};
  const msg = choice.message || {};
  if (!msg.content && choice.finish_reason === 'length') throw new Error(`model hit max_tokens (${modelConfig.maxTokens}) before answering — raise GEMMA_MAX_TOKENS or the context length in LM Studio`);
  let json;
  try { json = extractJson(msg.content || ''); }
  catch (e) { throw new Error(`${e.message}${choice.finish_reason === 'length' ? ' (output was cut off: max_tokens reached)' : ''}. Got: ${String(msg.content || '').slice(0, 200)}`); }
  return { json, model, durationMs: Date.now() - started, usage: data.usage || null };
}
