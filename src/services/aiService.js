// src/services/aiService.js
// Claude generates content → GPT-4o-mini converts math to LaTeX
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai');
const { decrypt } = require('../lib/crypto');

const MODELS = {
  'claude-sonnet-4-20250514':  { provider: 'anthropic', label: 'Claude Sonnet 4',  maxTokens: 4096 },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', label: 'Claude Haiku 4.5', maxTokens: 4096 },
  'claude-opus-4-6':           { provider: 'anthropic', label: 'Claude Opus 4.6',  maxTokens: 4096 },
  'gpt-4o':                    { provider: 'openai',    label: 'GPT-4o',           maxTokens: 4096 },
  'gpt-4o-mini':               { provider: 'openai',    label: 'GPT-4o mini',      maxTokens: 4096 },
  'o3-mini':                   { provider: 'openai',    label: 'o3-mini',          maxTokens: 4096 },
};

const COST_PER_1M = {
  'claude-sonnet-4-20250514':  { in: 3.0,  out: 15.0 },
  'claude-haiku-4-5-20251001': { in: 0.8,  out: 4.0  },
  'claude-opus-4-6':           { in: 15.0, out: 75.0 },
  'gpt-4o':                    { in: 2.5,  out: 10.0 },
  'gpt-4o-mini':               { in: 0.15, out: 0.6  },
  'o3-mini':                   { in: 1.1,  out: 4.4  },
};

function estimateCost(model, inputTokens, outputTokens) {
  const c = COST_PER_1M[model];
  if (!c) return 0;
  return (inputTokens / 1_000_000) * c.in + (outputTokens / 1_000_000) * c.out;
}

function resolveKey(user, provider) {
  if (provider === 'anthropic') {
    const byok = user.anthropicKey ? decrypt(user.anthropicKey) : null;
    return byok || process.env.ANTHROPIC_API_KEY;
  }
  if (provider === 'openai') {
    const byok = user.openaiKey ? decrypt(user.openaiKey) : null;
    return byok || process.env.OPENAI_API_KEY;
  }
  throw new Error('Unknown provider: ' + provider);
}

// ── Step 1: Claude generates study notes ──────────────────────────────────
async function generateWithClaude({ user, systemPrompt, userPrompt }) {
  const apiKey = resolveKey(user, 'anthropic');
  const client = new Anthropic({ apiKey });
  const resp = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  return {
    text:         resp.content[0]?.text || '',
    inputTokens:  resp.usage?.input_tokens  || 0,
    outputTokens: resp.usage?.output_tokens || 0,
    costUsd:      estimateCost('claude-sonnet-4-20250514', resp.usage?.input_tokens || 0, resp.usage?.output_tokens || 0),
    provider:     'anthropic'
  };
}

// ── Step 2: GPT-4o-mini upgrades all math strings to LaTeX ───────────────
async function enhanceMathWithGPT({ user, jsonResult }) {
  const apiKey = resolveKey(user, 'openai');
  if (!apiKey) {
    console.log('No OpenAI key — skipping math enhancement');
    return jsonResult; // return as-is if no OpenAI key
  }

  const client = new OpenAI({ apiKey });

  const systemPrompt = `You are a LaTeX math formatter. You receive a JSON object containing study notes.
Your job: find every string that contains mathematical notation and convert it to proper LaTeX.

Rules:
- Use \\( ... \\) for inline math
- Use \\[ ... \\] for display/block math (equations, integrals, sums)
- Convert informal notation like "int_{0}^{1}(x^2 dx)" → \\[ \\int_{0}^{1} x^2 \\, dx \\]
- Convert "Sigma_{k=0}^{inf}(x^k)" → \\[ \\sum_{k=0}^{\\infty} x^k \\]
- Convert "frac{a}{b}" → \\( \\frac{a}{b} \\)
- Convert "sqrt(x)" → \\( \\sqrt{x} \\)
- Convert "alpha, beta, gamma" → \\( \\alpha, \\beta, \\gamma \\)
- Leave plain English text unchanged
- Keep ALL other JSON fields exactly the same — only modify string values that contain math
- Return ONLY valid JSON, no markdown, no explanation`;

  const userPrompt = `Convert all math notation in this JSON to proper LaTeX. Return the complete JSON with math upgraded:\n\n${JSON.stringify(jsonResult)}`;

  try {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
      response_format: { type: 'json_object' }
    });
    const text = resp.choices[0]?.message?.content || '';
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Math enhancement failed, using original:', e.message);
    return jsonResult; // fallback to Claude's output unchanged
  }
}

// ── Main export: Claude content + GPT math ────────────────────────────────
async function generate({ user, model, systemPrompt, userPrompt }) {
  const meta = MODELS[model];
  if (!meta) throw new Error(`Unknown model: ${model}`);

  let result;

  if (meta.provider === 'anthropic') {
    // Step 1: Claude generates notes
    result = await generateWithClaude({ user, systemPrompt, userPrompt });
  } else {
    // User picked GPT model — use it directly for content too
    const apiKey = resolveKey(user, 'openai');
    const client = new OpenAI({ apiKey });
    const resp = await client.chat.completions.create({
      model,
      max_tokens: meta.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
      response_format: { type: 'json_object' }
    });
    result = {
      text:         resp.choices[0]?.message?.content || '',
      inputTokens:  resp.usage?.prompt_tokens     || 0,
      outputTokens: resp.usage?.completion_tokens || 0,
      costUsd:      estimateCost(model, resp.usage?.prompt_tokens || 0, resp.usage?.completion_tokens || 0),
      provider:     'openai'
    };
  }

  return result;
}

// ── Exported separately so generate.js can call it after parsing JSON ──────
module.exports = { generate, enhanceMathWithGPT, MODELS };
