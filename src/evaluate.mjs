// Job-description evaluation. Two ways to use it:
//  1. Inside an agent harness (Claude Code, Codex, ...): `apply-pilot eval prompt`
//     prints the rubric prompt, the agent answers with JSON, `apply-pilot eval score`
//     turns the JSON into the weighted score. No API key needed.
//  2. Standalone: `apply-pilot eval run --provider deepseek` calls a model directly.
import { hardFilter, scoreEvaluation } from './scoring.mjs';
import { checkJobPolicy } from './job-policy.mjs';

export const PROVIDERS = {
  deepseek: { kind: 'openai', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyEnv: 'DEEPSEEK_API_KEY' },
  openai: { kind: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', keyEnv: 'OPENAI_API_KEY' },
  openrouter: { kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek/deepseek-chat', keyEnv: 'OPENROUTER_API_KEY' },
  ollama: { kind: 'openai', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:14b', keyEnv: null },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY' },
};

export function buildPrompt(profile, jdText) {
  const dims = profile.scoring.dimensions.map((d) => `- ${d.id} (${d.label}, weight ${d.weight}): ${d.guide || ''}`).join('\n');
  const facts = (profile.candidate?.facts || []).map((f) => `- ${f}`).join('\n') || '- (none given)';
  const gaps = (profile.writing.forbiddenClaims || []).map((f) => `- ${f}`).join('\n') || '- (none)';
  const system = [
    'You screen job and internship postings for one candidate. Be strict and literal.',
    'Rate only what the posting and the candidate facts support. Do not invent experience.',
    'Answer with one JSON object and nothing else.',
    'Also return jobType: full_time, phd, cifre, internship, or unknown. Classify the advertised contract, not a qualification. Return jobTypeEvidence as a literal quote from the posting; use unknown when unclear.',
  ].join(' ');
  const user = `CANDIDATE TARGET\n${profile.candidate?.summary || '(not set)'}\n\nVERIFIED CANDIDATE FACTS\n${facts}\n\nTHINGS THE CANDIDATE HAS NOT DONE (count as gaps, never as strengths)\n${gaps}\n\nRUBRIC: rate each dimension from 0 to 5\n${dims}\n\nJOB POSTING\n"""\n${jdText.slice(0, 16000)}\n"""\n\nReturn JSON:\n{"company": "...", "role": "...", "location": "...", "start": "...", "duration": "...", "language": "...",\n "ratings": {${profile.scoring.dimensions.map((d) => `"${d.id}": {"score": 0, "reason": "..."}`).join(', ')}},\n "gaps": ["..."], "summary": "two plain sentences"}`;
  return { system, user };
}

export function parseModelJson(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('model reply contains no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

export async function callModel({ provider = 'deepseek', model, baseUrl, prompt, temperature = 0 }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`unknown provider "${provider}" (${Object.keys(PROVIDERS).join(', ')})`);
  const key = p.keyEnv ? process.env[p.keyEnv] : 'none';
  if (!key) throw new Error(`set ${p.keyEnv} to use ${provider}`);
  const base = baseUrl || p.baseUrl;
  if (p.kind === 'anthropic') {
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || p.model, max_tokens: 2000, temperature, system: prompt.system, messages: [{ role: 'user', content: prompt.user }] }),
    });
    if (!res.ok) throw new Error(`${provider} ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content.map((c) => c.text || '').join('');
  }
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: model || p.model, temperature, messages: [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] }),
  });
  if (!res.ok) throw new Error(`${provider} ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message.content;
}

/** Combine a model (or agent) answer with hard filters and the weighted rubric. */
export function finishEvaluation(profile, answer, jdText = '') {
  // Filters look at the title (and the description's first line, usually the title), not the whole description.
  const filters = hardFilter(profile, { company: answer.company || '', text: `${answer.role || ''}\n${String(jdText).split('\n')[0]}` });
  const scored = scoreEvaluation(profile, answer.ratings || {});
  const policy = checkJobPolicy(profile, answer);
  const decision = filters.length || policy.status === 'excluded' ? 'Skip'
    : policy.status === 'review' && scored.decision === 'Apply' ? 'Consider' : scored.decision;
  return { ...answer, filters, ...scored, policy, needsReview: policy.status === 'review', decision };
}

export async function evaluateText(profile, jdText, opts = {}) {
  const prompt = buildPrompt(profile, jdText);
  const reply = await callModel({ ...opts, prompt });
  return finishEvaluation(profile, parseModelJson(reply), jdText);
}
