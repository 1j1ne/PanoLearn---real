// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');
const { encrypt, decrypt } = require('../lib/crypto');

const router  = express.Router();
const prisma  = new PrismaClient();

function makeToken(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d'
  });
}

// ── POST /auth/register ────────────────────────────────────────────────────
router.post('/register', authLimiter, async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 8)  return res.status(400).json({ error: 'Password must be 8+ characters' });

  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash, name }
    });

    res.status(201).json({ token: makeToken(user.id), user: publicUser(user) });
  } catch (e) {
    console.error('REGISTER ERROR:', e.message, e.code);
    res.status(500).json({ error: e.message || 'Registration failed' });
  }
});

// ── POST /auth/login ──────────────────────────────────────────────────────
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok)  return res.status(401).json({ error: 'Invalid credentials' });

    res.json({ token: makeToken(user.id), user: publicUser(user) });
  } catch (e) {
    console.error("AUTH ERROR:", e.message, e.code);
    res.status(500).json({ error: e.message || 'Login failed' });
  }
});

// ── GET /auth/me ──────────────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// ── PATCH /auth/keys — save encrypted BYOK API keys ──────────────────────
router.patch('/keys', requireAuth, async (req, res) => {
  const { anthropicKey, openaiKey } = req.body;
  const data = {};

  if (anthropicKey !== undefined) {
    // Validate key format before storing
    if (anthropicKey && !anthropicKey.startsWith('sk-ant-')) {
      return res.status(400).json({ error: 'Invalid Anthropic API key format' });
    }
    data.anthropicKey = anthropicKey ? encrypt(anthropicKey) : null;
  }

  if (openaiKey !== undefined) {
    if (openaiKey && !openaiKey.startsWith('sk-')) {
      return res.status(400).json({ error: 'Invalid OpenAI API key format' });
    }
    data.openaiKey = openaiKey ? encrypt(openaiKey) : null;
  }

  try {
    const updated = await prisma.user.update({ where: { id: req.user.id }, data });
    res.json({ user: publicUser(updated) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to save keys' });
  }
});

// ── Sanitize user object for API responses ─────────────────────────────────
function publicUser(u) {
  return {
    id:           u.id,
    email:        u.email,
    name:         u.name,
    plan:         u.plan,
    hasAnthropicKey: !!u.anthropicKey,
    hasOpenAIKey:    !!u.openaiKey,
    subCurrentPeriodEnd: u.subCurrentPeriodEnd,
    createdAt:    u.createdAt,
  };
}

module.exports = router;
