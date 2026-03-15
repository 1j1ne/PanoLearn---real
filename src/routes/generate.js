// src/routes/generate.js
const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { requireAuth }        = require('../middleware/auth');
const { generationLimiter }  = require('../middleware/rateLimit');
const { generate, enhanceMathWithGPT, MODELS } = require('../services/aiService');

const router = express.Router();
const prisma = new PrismaClient();

// ── The full prompt builder (mirrors content.js logic) ────────────────────
function buildPrompts(title, transcript, modes) {
  const modeSchemas = {
    summary: `"summary": {
        "tldr": "2-3 sentence summary of what was actually taught",
        "main_topics": ["topic 1", "topic 2", "topic 3"],
        "what_to_remember": "most important takeaway"
      }`,
    concepts: `"concepts_3step": [
        {
          "title": "Name of the concept",
          "step1_definition": "Definition and core properties",
          "step2_principle": "Underlying mechanism, formulas, or relationships",
          "step3_application": "How it is applied in examples or problems from the lecture"
        }
      ]`,
    flashcards: `"flashcards": [
        { "front": "term or question", "back": "answer", "category": "topic" }
      ]`,
    timeline: `"timeline": [
        { "segment": "0:00-4:00", "topic": "topic", "key_point": "specific point" }
      ]`,
    mindmap: `"concept_summary": {
        "sections": [
          {
            "heading": "Topic or formula group name",
            "items": [
              {
                "label": "short label shown in collapsed row",
                "steps": [
                  {
                    "title": "Step title e.g. Set up / First part / Evaluate / Final Answer",
                    "prose": "One sentence plain-language explanation",
                    "equation": "Key formula or result e.g. int_{0}^{b}(expr dr) or Sigma_{k=0}^{inf}(x^k/k!)",
                    "is_final": false
                  }
                ]
              }
            ]
          }
        ]
      }`,
    exam: `"exam_questions": [
        {
          "type": "Computation | Proof | Conceptual | Application | Derivation",
          "difficulty": "medium | hard",
          "question": "Rigorous exam question requiring actual work — compute, derive, or prove using specific examples from the lecture",
          "answer": "Full worked solution with every step shown"
        }
      ]`
  };

  const requested = modes.map(m => modeSchemas[m]).filter(Boolean).join(',\n');

  const systemPrompt = `You are an expert lecture note extractor.
Rules:
1. Use ONLY the provided transcript — every term, example, and analogy must come directly from it.
2. Do NOT add outside facts, textbook definitions, or general knowledge not present in the transcript.
3. Be specific: use the exact examples the professor gave.
4. Return ONLY valid JSON — no markdown, no preamble.
5. For exam_questions: ONLY Computation, Proof, Application, Derivation — never trivial recall. difficulty must be medium or hard only.
6. Detect the lecture_type from: "math", "coding", "science", "humanities". Use "math" for anything with formulas/proofs; "coding" for programming/CS algorithms; "science" for bio/chem/physics without heavy math; "humanities" for history/literature/social science.
7. For coding lectures: include code examples in triple backticks with language tag e.g. \`\`\`python\\ncode here\\n\`\`\`
8. Math notation: use proper LaTeX — \\( inline \\), $ display $ — e.g. \\( \\sum_{k=0}^{\\infty} a_k x^k \\)`;

  const userPrompt = `Transcript of a single lecture session.
Title: "${title || 'Unknown'}"

TRANSCRIPT:
"""
${transcript}
"""

Return this JSON — every item must be traceable to the transcript:
{
  "lecture_title": "specific descriptive title",
  "lecture_type": "math|coding|science|humanities",
  ${requested}
}`;

  return { systemPrompt, userPrompt };
}

// ── POST /generate ────────────────────────────────────────────────────────
router.post('/', requireAuth, generationLimiter, async (req, res) => {
  const {
    transcript,
    title     = 'Unknown Lecture',
    modes     = ['summary', 'concepts', 'flashcards', 'timeline', 'mindmap', 'exam'],
    model     = 'claude-sonnet-4-20250514',
    videoUrl  = null,
  } = req.body;

  // ── Validate ─────────────────────────────────────────────────────────────
  if (!transcript?.trim()) {
    return res.status(400).json({ error: 'Transcript is required' });
  }
  const wordCount = transcript.trim().split(/\s+/).length;
  if (wordCount < 120) {
    return res.status(400).json({ error: `Transcript too short (${wordCount} words). Need at least 120 words.` });
  }
  if (!MODELS[model]) {
    return res.status(400).json({ error: `Unknown model: ${model}. Valid: ${Object.keys(MODELS).join(', ')}` });
  }

  // ── Build prompts ─────────────────────────────────────────────────────────
  const { systemPrompt, userPrompt } = buildPrompts(title, transcript, modes);

  try {
    // ── Call AI ───────────────────────────────────────────────────────────
    const { text, inputTokens, outputTokens, costUsd, provider } = await generate({
      user: req.user, model, systemPrompt, userPrompt
    });

    // ── Parse JSON response ───────────────────────────────────────────────
    let result;
    try {
      const clean = text.replace(/```json|```/g, '').trim();
      result = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: 'AI returned invalid JSON. Please retry.' });
    }

    // ── Step 2: GPT-4o-mini upgrades math to LaTeX (if Anthropic was used) ──
    if (provider === 'anthropic' && process.env.OPENAI_API_KEY) {
      result = await enhanceMathWithGPT({ user: req.user, jsonResult: result });
    }

    // ── Log to DB ─────────────────────────────────────────────────────────
    await prisma.generation.create({
      data: {
        userId:       req.user.id,
        provider:     provider.toUpperCase(),
        model,
        lectureTitle: result.lecture_title || title,
        videoUrl,
        modes,
        inputTokens,
        outputTokens,
        costUsd,
      }
    });

    res.json({ result, meta: { model, inputTokens, outputTokens, costUsd } });

  } catch (e) {
    console.error('Generate error:', e.message);
    // Surface API key errors cleanly
    if (e.message.includes('API key') || e.message.includes('401') || e.message.includes('auth')) {
      return res.status(401).json({ error: e.message });
    }
    res.status(500).json({ error: e.message || 'Generation failed' });
  }
});

// ── GET /generate/models — list available models ──────────────────────────
router.get('/models', requireAuth, (req, res) => {
  const list = Object.entries(MODELS).map(([id, meta]) => ({
    id,
    label:    meta.label,
    provider: meta.provider,
    // BYOK required if FREE plan and using platform's OpenAI
    requiresKey: req.user.plan === 'FREE',
  }));
  res.json({ models: list });
});

// ── GET /generate/history — user's past generations ──────────────────────
router.get('/history', requireAuth, async (req, res) => {
  const page  = parseInt(req.query.page  || '1');
  const limit = parseInt(req.query.limit || '20');
  const skip  = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.generation.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      skip, take: limit,
      select: { id:1, model:1, lectureTitle:1, videoUrl:1, modes:1, costUsd:1, createdAt:1 }
    }),
    prisma.generation.count({ where: { userId: req.user.id } })
  ]);

  res.json({ items, total, page, pages: Math.ceil(total / limit) });
});

module.exports = router;
