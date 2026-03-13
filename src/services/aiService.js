// src/services/aiService.js
// Unified AI caller — supports Anthropic and OpenAI with the same interface
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI = require('openai');
const { decrypt } = require('../lib/crypto');

// ── Model catalogue ────────────────────────────────────────────────────────
const MODELS = {
  // Anthropic
  'claude-sonnet-4-20250514':  { provider: 'anthropic', label: 'Claude Sonnet 4',  maxTokens: 4096 },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', label: 'Claude Haiku 4.5', maxTokens: 4096 },
  'claude-opus-4-6':           { provider: 'anthropic', label: 'Claude Opus 4.6',  maxTokens: 4096 },
  // OpenAI
  'gpt-4o':                    { provider: 'openai', label: 'GPT-4o',       maxTokens: 4096 },
  'gpt-4o-mini':               { provider: 'openai', label: 'GPT-4o mini',  maxTokens: 4096 },
  'o3-mini':                   { provider: 'openai', label: 'o3-mini',      maxTokens: 4096 },
};

// ── Cost per 1M tokens (approximate, for logging) ─────────────────────────
const COST_PER_1M = {
  'claude-sonnet-4-20250514':  { in: 3.0,   out: 15.0  },
  'claude-haiku-4-5-20251001': { in: 0.8,   out: 4.0   },
  'claude-opus-4-6':           { in: 15.0,  out: 75.0  },
  'gpt-4o':                    { in: 2.5,   out: 10.0  },
  'gpt-4o-mini':               { in: 0.15,  out: 0.6   },
  'o3-mini':                   { in: 1.1,   out: 4.4   },
};

function estimateCost(model, inputTokens, outputTokens) {
  const c = COST_PER_1M[model];
  if (!c) return 0;
  return (inputTokens / 1_000_000) * c.in + (outputTokens / 1_000_000) * c.out;
}

// ── Resolve which API key to use ───────────────────────────────────────────
// Priority: user's BYOK key > platform key (for PRO/CAMPUS)
function resolveKey(user, provider) {
  if (provider === 'anthropic') {
    const byok = user.anthropicKey ? decrypt(user.anthropicKey) : null;
    return byok || process.env.ANTHROPIC_API_KEY;
  }
  if (provider === 'openai') {
    const byok = user.openaiKey ? decrypt(user.openaiKey) : null;
    // FREE users must supply their own OpenAI key
    if (!byok && user.plan === 'FREE') {
      throw new Error('OpenAI key required. Add your key in Settings.');
    }
    return byok || process.env.OPENAI_API_KEY;
  }
  throw new Error('Unknown provider: ' + provider);
}

// ── Main generate function ─────────────────────────────────────────────────
async function generate({ user, model, systemPrompt, userPrompt }) {
  const meta = MODELS[model];
  if (!meta) throw new Error(`Unknown model: ${model}`);

  const apiKey = resolveKey(user, meta.provider);
  let inputTokens = 0, outputTokens = 0, text = '';

  if (meta.provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: meta.maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });
    text         = resp.content[0]?.text || '';
    inputTokens  = resp.usage?.input_tokens  || 0;
    outputTokens = resp.usage?.output_tokens || 0;
  }

  if (meta.provider === 'openai') {
    const client = new OpenAI({ apiKey });
    const resp = await client.chat.completions.create({
      model,
      max_tokens: meta.maxTokens,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   }
      ],
      response_format: { type: 'json_object' }  // enforce JSON output
    });
    text         = resp.choices[0]?.message?.content || '';
    inputTokens  = resp.usage?.prompt_tokens     || 0;
    outputTokens = resp.usage?.completion_tokens || 0;
  }

  const costUsd = estimateCost(model, inputTokens, outputTokens);
  return { text, inputTokens, outputTokens, costUsd, provider: meta.provider };
}

module.exports = { generate, MODELS };
